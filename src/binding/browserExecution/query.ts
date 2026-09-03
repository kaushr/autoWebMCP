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
}

const RESULT_SELECTOR = "a[href]";

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
  entityType: string,
  identity: EntityIdentityPolicy,
  adapter?: PlatformResolverAdapter
): EntityCandidate[] {
  const policy = policyFor(adapter);
  const found = new Map<string, EntityCandidate>();

  for (const element of collectElements(root, RESULT_SELECTOR, policy)) {
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

    // Filtering by type requires KNOWING the type. `sameEntity` matches on
    // id alone when either side is untyped, which is right for comparing
    // two references to one record and wrong here: a live search returned
    // six candidates of which four were not Opportunities at all — a
    // custom object and two other prefixes the pack does not declare — and
    // every one of them passed an Opportunity filter by being unknown.
    if (parsed.entityType !== entityType) continue;
    if (found.has(parsed.id)) continue;

    // Whitespace collapsed, case preserved. `normalizeLabel` exists for
    // COMPARING labels and lowercases to do it; a candidate's name is
    // shown to a person and handed to an agent, and "acme renewal" is not
    // what the application called this record.
    const name = (accessibleName(element) ?? "").replace(/\s+/g, " ").trim();
    if (!name) continue;

    found.set(parsed.id, { id: parsed.id, name, entityType });
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

  // Reveal the search field first, when the demonstration showed it being
  // opened. A control that is not on screen cannot be resolved, and the
  // failure would read as "the search box is missing" rather than "it has
  // not been opened yet".
  if (binding.open) {
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
    const write = await setFieldValue(resolution.target, control.value, control.kind, adapter);
    if (!write.ok) {
      return {
        status: "blocked",
        candidates: [],
        evidence,
        warnings: [`"${control.name}" could not be set: ${write.detail}`],
        executedAt: now()
      };
    }
    evidence.push(`Set "${control.name}" to ${JSON.stringify(control.value)}.`);
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

  const candidates = candidatesOnPage(root, binding.entityType, identity, adapter);
  evidence.push(
    candidates.length === 0
      ? `No ${binding.entityType} links were found on the page after searching.`
      : `Found ${candidates.length} ${binding.entityType} candidate(s): ${candidates
          .map((candidate) => `${candidate.name} (${candidate.id})`)
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
