import { canonicalIdentityFromPath, type EntityIdentityPolicy } from "./entityIdentity";
import {
  accessibleName,
  collectElements,
  invokeSemanticAction,
  isVisible,
  policyFor,
  pressKey,
  resolveSemanticTarget,
  setFieldValue,
  typeText,
  waitForApplicationReaction,
  type PlatformResolverAdapter
} from "./engine";
import type { BrowserBindingSafety, FieldValueKind, SemanticTarget } from "./model";
import type { SourceApplication } from "../../semantic/model";

/* ------------------------------------------------------------------ *
 * Entity resolution — finding candidates, never choosing between them.
 *
 * A different shape from a mutation, and deliberately its own type rather
 * than a `BrowserExecutionBinding` with its commit made optional. The
 * differences are not incidental: there is nothing to save, nothing to
 * verify against a record, and the OUTPUT is the point. Bolting that onto
 * a binding whose every verification check asks "did the edit surface
 * close" would make both harder to reason about.
 *
 * The invariant that gives this its purpose:
 *
 *   SEARCH MAY BE FUZZY. MUTATION MUST BE EXACT.
 *
 * So this returns candidates carrying the platform's own stable identity,
 * and never picks one. A name is not an identity — two Opportunities may
 * share one — which is exactly why handing back an id is the whole job.
 * ------------------------------------------------------------------ */

/** One thing the application offered in response to a query. */
export interface EntityCandidate {
  /** The platform's stable identity, suitable for a mutation's target. */
  id: string;
  /** What the application called it on screen. Human-facing, never an identity. */
  name: string;
  entityType: string;
  /**
   * Whatever else the row stated plainly, e.g. an account or a stage.
   *
   * Only ever text the application itself rendered alongside the result.
   * Nothing is inferred, and a field that was not shown is absent rather
   * than guessed — a disambiguator that might be wrong is worse than none.
   */
  context?: Record<string, string>;
}

/** One filter a query may narrow by, beyond the free-text term. */
export interface QueryFilter {
  /** The capability input carrying it, e.g. `account_name`. */
  inputName: string;
  semanticTarget: SemanticTarget;
  valueKind: FieldValueKind;
}

/**
 * How a confirmed search capability is performed through the application's
 * own UI.
 *
 * Declarative in exactly the same way a mutation binding is: every target
 * is a role plus a visible label, re-resolved live. No selector, no XPath,
 * no coordinate, and no recorded result position — the results this
 * returns are read from whatever the application renders now.
 */
export interface BrowserQueryBinding {
  id: string;
  capabilityId: string;
  sourceApplication: SourceApplication;
  platform: string;
  /** The entity type whose identities this query is expected to return. */
  entityType: string;
  /** Where the search term is typed, and which capability input supplies it. */
  query: { inputName: string; semanticTarget: SemanticTarget };
  /** Additional narrowing controls, when the application offers them. */
  filters?: QueryFilter[];
  /** The control that reveals the search field, when it is not already on screen. */
  open?: SemanticTarget;
  /** The control that runs the search, when there is one to click. */
  submit?: SemanticTarget;
  /**
   * The key that runs the search, when no control does.
   *
   * A live Salesforce trace showed typing followed straight by navigation,
   * with nothing clicked in between — the search was submitted with Enter,
   * and a binding that can only click could not reproduce it.
   */
  submitKey?: string;
  safety: BrowserBindingSafety;
  evidence: string[];
}

export interface QueryOutcome {
  status: "succeeded" | "no-results" | "blocked";
  candidates: EntityCandidate[];
  evidence: string[];
  warnings: string[];
  executedAt: string;
}

export interface ExecuteQueryOptions {
  root: ParentNode & Node;
  binding: BrowserQueryBinding;
  /** Capability input name → value. The free-text term plus any filters. */
  inputs: Record<string, string>;
  adapter?: PlatformResolverAdapter;
  /** How this platform encodes entity identity, from its pack. */
  identity: EntityIdentityPolicy;
  reaction?: { timeoutMs?: number; quietMs?: number };
  /** How long to keep looking for results before concluding there are none. */
  resultsWaitMs?: number;
}

const RESULT_SELECTOR = "a[href]";

/**
 * Structure that marks a link as the SUBJECT of its row, card or list.
 *
 * Standard semantics, not a platform quirk: a row header identifies its
 * row, a heading titles its card, and an option IS the thing it offers to
 * select. A live Salesforce results page put the matched record's link in
 * `th.slds-cell-edit` and `h2.recordTitle`, while the account and owner of
 * that same record sat in `td[gridcell]` and card list items — fields OF
 * the result, not results.
 *
 * Options matter because an application need not navigate to answer. The
 * same search that would not submit synthetically showed its results in a
 * type-ahead listbox, which is the answer arriving without a page change.
 */
const SUBJECT_SELECTOR =
  'th, [role="rowheader"], h1, h2, h3, h4, h5, h6, [role="heading"], [role="option"], [role="treeitem"]';

/** Whether a link is the thing its row or card is about. */
function isSubjectLink(link: Element): boolean {
  return Boolean(link.closest(SUBJECT_SELECTOR));
}

/**
 * Every entity the page is currently linking to, of the type asked for.
 *
 * Identity comes from the LINK's own route, using the same declared
 * pattern that tells an execution which record is open. That is the
 * reason a result carries a usable id at all: the application states it
 * in the href, and no scraping of visible text could be as reliable.
 *
 * Deduplicated by id, because a results page routinely links the same
 * record more than once — a title link and a preview link are one
 * candidate, not two. Order is preserved, so the application's own
 * ranking survives; nothing here reorders or truncates, and NOTHING
 * selects.
 */
export function candidatesOnPage(
  root: ParentNode,
  /**
   * Narrow to one entity type, or omit to return everything identifiable.
   *
   * Omitting is the normal case. A demonstration that ended on an
   * Opportunity does not establish that Opportunities are all a caller
   * wants — someone searching "Acme" may well mean the Account — and
   * discarding the rest would hide results the application itself offered.
   * Type enforcement belongs at the mutation, where `update_opportunity`
   * already refuses a record whose observed type is not the one it binds.
   */
  entityType: string | undefined,
  identity: EntityIdentityPolicy,
  adapter?: PlatformResolverAdapter
): EntityCandidate[] {
  const policy = policyFor(adapter);
  const found = new Map<string, EntityCandidate>();

  const links = collectElements(root, RESULT_SELECTOR, policy);
  // Prefer links the page's own structure identifies as a row's or card's
  // subject. A search for "PS Project" returned an Opportunity, its
  // account and its owner — three records, one result — because every
  // record link looks alike and only the surrounding structure says which
  // one the row is about.
  //
  // The preference is conditional on the page offering it: where nothing
  // is marked, there is nothing to reason from, and every record link is
  // taken rather than none.
  const subjects = links.filter(isSubjectLink);
  const considered = subjects.length > 0 ? subjects : links;

  for (const element of considered) {
    if (!(element instanceof HTMLAnchorElement) || !isVisible(element)) continue;

    // `getAttribute` rather than `.href`: the attribute is what the
    // application wrote, and resolving it would drag in the test or host
    // origin for no benefit — only the path matters.
    const href = element.getAttribute("href") ?? "";
    const path = href.startsWith("http") ? safePath(href) : href;
    if (!path) continue;

    // Only the record's own page. A link BENEATH a record — a live page
    // carried `/lightning/r/<id>/related/Products/view` — identifies that
    // record correctly and is not a result for it.
    const parsed = canonicalIdentityFromPath(path, identity);
    if (!parsed) continue;

    // A candidate whose type cannot be established is dropped whatever was
    // asked for. Returning an id without being able to say what it refers
    // to is how a custom object's identifier reached a list of
    // Opportunities in a live run.
    if (!parsed.entityType) continue;
    // And when a type IS requested, it must match exactly rather than
    // merely fail to contradict.
    if (entityType && parsed.entityType !== entityType) continue;
    if (found.has(parsed.id)) continue;

    // Whitespace collapsed, case preserved. `normalizeLabel` exists for
    // COMPARING labels and lowercases to do it; a candidate's name is
    // shown to a person and handed to an agent, and "acme renewal" is not
    // what the application called this record.
    const name = (accessibleName(element) ?? "").replace(/\s+/g, " ").trim();
    if (!name) continue;

    // The candidate's OWN type, which the guard above proved it has —
    // never the type that was asked for.
    found.set(parsed.id, { id: parsed.id, name, entityType: parsed.entityType });
  }

  return [...found.values()];
}

function safePath(href: string): string | undefined {
  try {
    return new URL(href).pathname;
  } catch {
    return undefined;
  }
}

const RESULTS_WAIT_MS = 8_000;
const RESULTS_POLL_MS = 300;

/**
 * Reads the page for candidates until some appear or the window closes.
 *
 * Deliberately not a fixed sleep: the common case returns as soon as the
 * application has rendered, and only a genuinely empty result pays the
 * full wait.
 */
async function collectCandidates(
  root: ParentNode,
  entityType: string | undefined,
  identity: EntityIdentityPolicy,
  adapter: PlatformResolverAdapter | undefined,
  waitMs = RESULTS_WAIT_MS,
  /** Whether the application has navigated since the search was submitted. */
  navigated: () => boolean = () => false,
  /**
   * What the page was already linking to before the search ran.
   *
   * Without this, "results have arrived" means "some record link exists",
   * and a page that already had some answers instantly with the wrong
   * ones. A live search run from an Opportunity record returned that
   * record's own account and owner: they were on screen the whole time,
   * and the read happened before the results page replaced them.
   */
  before: ReadonlySet<string> = new Set()
): Promise<EntityCandidate[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const all = candidatesOnPage(root, entityType, identity, adapter);
    // Whether what is on screen answers THIS search.
    //
    // If the application navigated in response, the page is its answer and
    // everything on it counts — including records that were already
    // linked, because searching twice for the same thing must not return
    // less the second time.
    //
    // If it did not navigate, the page is the one we started on, and the
    // links that were already there are not results. That distinction is
    // what stops a search run from a record page reporting that record's
    // own account and owner as matches.
    const found = navigated() ? all : all.filter((candidate) => !before.has(candidate.id));
    if (found.length > 0 || Date.now() >= deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, RESULTS_POLL_MS));
  }
}

/**
 * Runs a taught search and returns what the application offered.
 *
 * Read-only by construction: it types into a search control and reads
 * links. There is no commit, nothing is saved, and the only state it
 * changes is whatever the application does in response to being searched —
 * which is why this needs no execution confirmation, unlike a mutation.
 *
 * Ambiguity is preserved rather than resolved. Several candidates is a
 * legitimate and common answer, and picking the first would be the system
 * quietly deciding which record a later write lands on.
 */
export async function executeQuery(options: ExecuteQueryOptions): Promise<QueryOutcome> {
  const { root, binding, inputs, adapter, identity } = options;
  const evidence: string[] = [];
  const warnings: string[] = [];
  const now = () => new Date().toISOString();

  const term = inputs[binding.query.inputName]?.trim() ?? "";
  if (!term) {
    return {
      status: "blocked",
      candidates: [],
      evidence,
      warnings: [`No search term was supplied for "${binding.query.inputName}".`],
      executedAt: now()
    };
  }

  // The query control, then any filters the caller actually supplied. An
  // unsupplied filter is left alone rather than cleared: "not narrowing by
  // account" and "narrowing by an empty account" are different searches.
  const controls: Array<{ target: SemanticTarget; value: string; kind: FieldValueKind; name: string }> = [
    { target: binding.query.semanticTarget, value: term, kind: "text", name: binding.query.inputName }
  ];
  for (const filter of binding.filters ?? []) {
    const value = inputs[filter.inputName]?.trim();
    if (value) controls.push({ target: filter.semanticTarget, value, kind: filter.valueKind, name: filter.inputName });
  }

  // What the page already links to. A search has not produced results
  // merely because record links exist — they may be the ones that were
  // there before it ran.
  const before = new Set(candidatesOnPage(root, undefined, identity, adapter).map((candidate) => candidate.id));
  // The whole address, hash included: a platform that carries the search
  // term in its own URL fragment changes only that when asked something
  // new, and it is still the application answering.
  const locationOf = (): string | undefined => {
    const document = root instanceof Document ? root : (root as Element).ownerDocument;
    return document?.location?.href;
  };
  const addressBefore = locationOf();

  // Reveal the search field first, when the demonstration showed it being
  // opened. A control that is not on screen cannot be resolved, and the
  // failure would read as "the search box is missing" rather than "it has
  // not been opened yet".
  // Only if it is not already open. A binding taught from a closed search
  // box would otherwise fail on a page where the box is already showing —
  // which is exactly the state a previous search leaves behind, and it
  // reported the search control as missing when it was right there.
  const alreadyOpen = resolveSemanticTarget(root, binding.query.semanticTarget, adapter).ok;
  if (binding.open && !alreadyOpen) {
    const opened = await invokeSemanticAction(root, binding.open, adapter);
    if (!opened.ok) {
      return {
        status: "blocked",
        candidates: [],
        evidence,
        warnings: [`The search could not be opened: ${opened.detail}`],
        executedAt: now()
      };
    }
    evidence.push(opened.detail);
    await waitForApplicationReaction({ root, ...options.reaction });
  }

  for (const control of controls) {
    const resolution = resolveSemanticTarget(root, control.target, adapter);
    if (!resolution.ok) {
      return {
        status: "blocked",
        candidates: [],
        evidence,
        warnings: [`The control for "${control.name}" could not be found: ${resolution.reason}`],
        executedAt: now()
      };
    }
    // Typed rather than written. A search control belongs to a component
    // that tracks its own state from key events, and a value set directly
    // sits in the box while the component believes the field is empty.
    const write =
      control.kind === "text"
        ? await typeText(root, control.target, control.value, adapter)
        : await setFieldValue(resolution.target, control.value, control.kind, adapter);
    if (!write.ok) {
      return {
        status: "blocked",
        candidates: [],
        evidence,
        warnings: [`"${control.name}" could not be set: ${write.detail}`],
        executedAt: now()
      };
    }
    evidence.push(write.detail);
  }

  // Run it: a control if the application has one, otherwise the key the
  // demonstration showed. Typing alone leaves many search boxes idle.
  const ran = binding.submit
    ? await invokeSemanticAction(root, binding.submit, adapter)
    : binding.submitKey
      ? await pressKey(root, binding.query.semanticTarget, binding.submitKey, adapter, options.reaction)
      : undefined;
  if (ran && !ran.ok) {
    return {
      status: "blocked",
      candidates: [],
      evidence,
      warnings: [`The search could not be run: ${ran.detail}`],
      executedAt: now()
    };
  }
  if (ran) evidence.push(ran.detail);

  const settled = await waitForApplicationReaction({ root, ...options.reaction });
  evidence.push(
    settled.settled
      ? `The results settled ${settled.elapsedMs}ms after searching.`
      : `The page did not settle within ${settled.elapsedMs}ms; results were read anyway.`
  );

  // Results arrive asynchronously, and a settle signal is not the same as
  // results existing: a live run read an empty page immediately after
  // submitting and reported no matches, while the application was still
  // fetching them. So the page is re-read for a bounded window and returns
  // the moment anything appears.
  //
  // An empty answer after the whole window is still a real answer — a term
  // that matches nothing must not spin for the full budget every time, but
  // it is the only case that pays it.
  // Everything identifiable, not only the type the recording ended on.
  const candidates = await collectCandidates(
    root,
    undefined,
    identity,
    adapter,
    options.resultsWaitMs,
    () => locationOf() !== addressBefore,
    before
  );

  // What the reading was working with, recorded whether or not it
  // succeeded. Without this an empty result is indistinguishable between
  // "the application found nothing", "the page never changed", and "the
  // records are there and the extraction cannot see them" — three
  // different problems that look identical from outside.
  const onPageNow = candidatesOnPage(root, undefined, identity, adapter);
  evidence.push(
    `Reading: ${before.size} record link(s) before, ${onPageNow.length} after; ` +
      `the address ${locationOf() !== addressBefore ? "changed" : "did not change"}` +
      (onPageNow.length > 0
        ? `; on the page now: ${onPageNow.map((entry) => `${entry.name} [${entry.entityType}]`).join(", ")}`
        : "") +
      "."
  );
  evidence.push(
    candidates.length === 0
      ? "No identifiable records were found on the page after searching."
      : `Found ${candidates.length} candidate(s): ${candidates
          .map((candidate) => `${candidate.name} [${candidate.entityType}] (${candidate.id})`)
          .join(", ")}.`
  );

  // Said plainly rather than left for a caller to notice. An agent that
  // treats several candidates as one would write to whichever came first,
  // which is the failure this whole handoff exists to prevent.
  if (candidates.length > 1) {
    warnings.push(
      `${candidates.length} candidates matched. They are returned in the application's own order and none has ` +
        "been chosen — select one by its identity before acting on it."
    );
  }

  return {
    status: candidates.length > 0 ? "succeeded" : "no-results",
    candidates,
    evidence,
    warnings,
    executedAt: now()
  };
}
