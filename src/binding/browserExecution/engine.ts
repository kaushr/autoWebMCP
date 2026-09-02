import type { FieldValueKind, SemanticTarget, VerificationCheck } from "./model";
import type { ExecutionCheckResult } from "./result";
import { DEFAULT_RESOLUTION_POLICY, type IdentitySignal, type ResolutionPolicy } from "./resolutionPolicy";
import type { EditRestoration, EditableTransition, PageStateAssessment } from "./pageState";
import type { ValidationAssessment } from "./verificationPolicy";
import { parseDisplayedDate, type DateOrder } from "./dateRepresentation";
import {
  composedClosest,
  ownerScope,
  queryComposedTree,
  queryComposedTreeFirst
} from "./composedTree";

export type { ResolutionPolicy } from "./resolutionPolicy";
export type { EditRestoration, EditableTransition, PageState, PageStateAssessment, PageStatePolicy } from "./pageState";
export type { ValidationAssessment, VerificationPolicy } from "./verificationPolicy";

/* ------------------------------------------------------------------ *
 * Generic browser execution engine.
 *
 * Re-resolve, never replay. Nothing here stores or consumes a screen
 * coordinate, a recorded click position, a CSS selector chain, an XPath, or
 * a DOM node id as a durable contract. Every primitive takes a live DOM root
 * and a semantic description, and finds the control fresh, the same way a
 * human — or a screen reader — would: by its visible label, its role, its
 * accessible name.
 *
 * This layer knows nothing about any one application. Platform-specific
 * resolution (shadow-DOM component internals, a framework's own mirrored
 * value property, date-picker component semantics) lives behind the small
 * `PlatformResolverAdapter` seam and is tried first; this file only ever
 * falls back to generic accessibility-tree reasoning.
 * ------------------------------------------------------------------ */

export interface ResolvedTarget {
  element: Element;
  /** Which strategy found it — kept for explainability and test assertions, never persisted on the binding. */
  strategy: string;
}

/** Why a resolution went the way it did — for the failure report, never persisted on a binding. */
export interface ResolveDiagnostics {
  candidatesConsidered: number;
  traversal: ResolutionPolicy["traversal"];
  appliedSignals: string[];
}

export type ResolveOutcome =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; reason: string; diagnostics?: ResolveDiagnostics };

export type FieldWriteOutcome = { ok: boolean; detail: string };

/** Tenant-specific facts a write may need. Established at execution time, never stored on a binding. */
export interface WriteContext {
  /** This org's date ordering, when it has been established. Absent means undetermined. */
  dateOrder?: DateOrder;
}

export type { ExecutionCheckResult };

/**
 * Platform-aware resolution, tried before the generic strategies below.
 * Every method is optional and may decline (return `undefined`) to fall
 * through to generic DOM/accessibility reasoning — an adapter augments this
 * engine, it never replaces it, and the generic layer stays usable for any
 * application with no adapter of its own.
 */
export interface PlatformResolverAdapter {
  id: string;
  /**
   * How this platform must be traversed and identified, compiled from
   * Platform Intelligence at the composition root (`adapters.ts`). Absent
   * means the generic default applies.
   */
  resolutionPolicy?: ResolutionPolicy;
  /**
   * Brings the page to the state a binding's `context.pageMode` expects
   * before anything is resolved — e.g. opening a record's edit form — and
   * PROVES it: the returned transition's `ok` asserts the postcondition
   * "the page is now in record-edit state as this platform defines it",
   * never merely "an edit control was clicked". Not a data write (nothing
   * here sets a value or commits anything), so it runs under the
   * confirmation already given for the execution. `undefined` declines —
   * the platform has no page-state concept and the page is assumed ready.
   */
  ensureEditable?(
    root: ParentNode,
    policy: ResolutionPolicy,
    /** How long to wait for the page to reach the edit state before giving up. */
    timeoutMs?: number
  ): Promise<EditableTransition> | EditableTransition | undefined;
  resolveTarget?(root: ParentNode, target: SemanticTarget, policy: ResolutionPolicy): ResolvedTarget | undefined;
  setFieldValue?(
    resolved: ResolvedTarget,
    value: string,
    valueKind: FieldValueKind,
    policy: ResolutionPolicy,
    /**
     * Tenant facts the write needs but the platform cannot supply. Date
     * ordering lives here rather than in `ResolutionPolicy` because it is
     * configuration of one org, not behaviour of the platform: two orgs on
     * identical Lightning render the same date differently.
     */
    context?: WriteContext
  ): Promise<FieldWriteOutcome> | FieldWriteOutcome | undefined;
  /**
   * Platform-aware post-commit validation assessment: distinguishes a
   * blocking validation error from the platform's own notifications, tied
   * to the save attempt's edit surface. `undefined` declines to the
   * generic visible-alert check.
   */
  assessValidation?(root: ParentNode, policy: ResolutionPolicy): ValidationAssessment | undefined;
  isEditStateClosed?(root: ParentNode, policy: ResolutionPolicy): boolean | undefined;
  /**
   * Reads a field's current on-screen value back, for verification.
   * `undefined` means unreadable.
   *
   * `knownElement` — the element a write just operated on — is read
   * directly when it is still connected, instead of re-resolving from
   * scratch. A live run proved the need: a Stage write committed
   * correctly (`data-value` became "Confirm") while the transaction's
   * fresh re-resolution returned the *persisted* value, because Stage
   * carries no application identifier and its trigger is a plain
   * `<button role="combobox">` rather than a custom element — so
   * resolution fell through to the record view still visible behind the
   * open modal. Close Date never hit this, because its
   * `applicationIdentifier` pins it to the real input on the first try.
   */
  readFieldValue?(
    root: ParentNode,
    target: SemanticTarget,
    policy: ResolutionPolicy,
    knownElement?: Element
  ): string | undefined;
  /**
   * Reads the values a closed-domain control is currently offering,
   * without changing anything.
   *
   * Read-only by contract: an implementation may open a popup to see the
   * choices, but must select nothing, write nothing, and leave the control
   * as it found it. It reports whether it opened the control and whether
   * it could PROVE the control was dismissed again, because a read that
   * silently leaves a popup hanging is not the same as a clean one.
   */
  readFieldOptions?(
    root: ParentNode,
    target: SemanticTarget,
    policy: ResolutionPolicy
  ): OptionReadOutcome | Promise<OptionReadOutcome> | undefined;
  /**
   * Returns the page to its non-editing state, undoing an edit-mode
   * transition AutoWebMCP itself caused.
   *
   * Only ever called when we own that transition. It resolves the
   * platform's own dismiss action semantically — never a recorded selector
   * — and proves the resulting state rather than assuming it.
   */
  restoreRecordView?(
    root: ParentNode,
    policy: ResolutionPolicy,
    /** How long to wait for the page to leave edit mode before calling it unproven. */
    timeoutMs?: number
  ): Promise<EditRestoration> | EditRestoration;
  /** The platform's reading of the current page state, for ownership decisions. */
  assessPageState?(root: ParentNode, policy: ResolutionPolicy): PageStateAssessment | undefined;
}

/**
 * What one read of a closed-domain control found, and what it had to do to
 * find it.
 *
 * The bookkeeping matters as much as the values: an operation that opens a
 * control owns that transient state, and must be able to say whether it
 * put it back.
 */
export interface OptionReadOutcome {
  options?: string[];
  /** True when this read opened the control; false when it was already open. */
  openedByUs: boolean;
  dismissAttempted: boolean;
  /** Proven closed afterwards, not merely asked to close. */
  dismissProven: boolean;
  detail: string;
}

/* --------------------------- name/label reading --------------------------- */

export function normalizeLabel(value: string): string {
  return value
    .trim()
    .replace(/^\*/, "") // a leading "*" marks a required field, not part of its name
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function textOf(node: Element | null | undefined): string | undefined {
  const text = node?.textContent?.replace(/\s+/g, " ").trim();
  return text ? text : undefined;
}

/** Escapes an id for use in a `#id` CSS selector. Shared so every id-reference lookup in this codebase escapes the same way. */
export function cssEscapeId(id: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/([^\w-])/g, "\\$1");
}

/**
 * The accessible name of an element, by the same priority a screen reader
 * would use.
 *
 * Self-scoping on purpose. `aria-labelledby` and `<label for>` reference
 * ids scoped to the element's *own* root, so resolving them against the
 * document finds nothing for anything inside a component — and making that
 * the caller's job is precisely how it went wrong repeatedly. Callers pass
 * an element; the correct scope is derived here, once.
 */
export function accessibleName(element: Element): string | undefined {
  const scope = ownerScope(element);
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => textOf(scope.querySelector(`#${cssEscapeId(id)}`)))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (text) return text;
  }

  const id = element.getAttribute("id");
  if (id) {
    const label = scope.querySelector(`label[for="${cssEscapeId(id)}"]`);
    const labelText = textOf(label);
    if (labelText) return labelText;
  }

  // An ancestor `<label>` is by definition in the same tree, so plain
  // `closest` is correct here and needs no composed walk.
  const closestLabelText = textOf(element.closest("label"));
  if (closestLabelText) return closestLabelText;

  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role");
  if (tag === "button" || tag === "a" || role === "button" || role === "link") {
    const text = textOf(element);
    if (text) return text;
  }

  const placeholder = element.getAttribute("placeholder");
  if (placeholder?.trim()) return placeholder.trim();

  return undefined;
}

const SECTION_SELECTOR = '[role="dialog"], [role="region"], [role="tabpanel"], form, fieldset, section, article';
const HEADING_SELECTOR = '[role="heading"], h1, h2, h3, h4, h5, h6, legend';

/**
 * The nearest enclosing section heading, mirroring the extension's own
 * capture policy. Composed-aware: a component's enclosing section is
 * routinely outside its shadow root, which plain `closest` cannot reach.
 */
function nearestSectionHeading(element: Element, policy: ResolutionPolicy): string | undefined {
  const section = composedClosest(element, SECTION_SELECTOR, policy);
  if (!section) return undefined;
  return textOf(queryComposedTreeFirst(section, HEADING_SELECTOR, policy));
}

/* ----------------------------- candidate walk ----------------------------- */

/**
 * The one traversal every lookup in this engine goes through. Delegates to
 * the composed-tree primitive so that whether shadow roots are descended
 * is a single platform-policy decision rather than a choice re-made — and
 * repeatedly forgotten — at each call site.
 */
export function collectElements(root: ParentNode, selector: string, policy: ResolutionPolicy): Element[] {
  return queryComposedTree(root, selector, policy);
}

const FIELD_SELECTOR = 'input, select, textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]';
const ACTION_SELECTOR =
  'button, [role="button"], input[type="submit"], input[type="button"], a[role="button"]';

function selectorForRole(role: SemanticTarget["role"]): string {
  switch (role) {
    case "button":
    case "link":
      return ACTION_SELECTOR;
    case "checkbox":
      return 'input[type="checkbox"], [role="checkbox"]';
    case "radio":
      return 'input[type="radio"], [role="radio"]';
    case "combobox":
      return 'select, [role="combobox"]';
    default:
      return FIELD_SELECTOR;
  }
}

export function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  if (element.hidden) return false;
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  return true;
}

/**
 * Generic resolution: candidates matching the target's role, filtered to
 * those whose accessible name matches the target's label, disambiguated by
 * application identifier and enclosing section when more than one remains.
 * Zero matches or a genuine tie both fail rather than guess — the same
 * "silence beats a wrong write" rule `fieldMapping.ts` applies to inputs.
 */
function matchesIdentifier(element: Element, identifier: string): boolean {
  return element.getAttribute("name") === identifier || element.getAttribute("id") === identifier;
}

/**
 * Narrows candidates by one identity signal. Returns `undefined` when the
 * signal cannot be applied (the target carries no such evidence), so the
 * caller can move to the next signal rather than treating "no evidence" as
 * "no match".
 */
function narrowBy(
  signal: IdentitySignal,
  candidates: readonly Element[],
  target: SemanticTarget,
  policy: ResolutionPolicy
): Element[] | undefined {
  switch (signal) {
    case "applicationIdentifier": {
      if (!target.applicationIdentifier) return undefined;
      const identifier = target.applicationIdentifier;
      return candidates.filter((element) => matchesIdentifier(element, identifier));
    }
    case "accessibleName": {
      const wanted = normalizeLabel(target.label);
      return candidates.filter((element) => {
        const name = accessibleName(element);
        return name !== undefined && normalizeLabel(name) === wanted;
      });
    }
    case "section": {
      if (!target.section) return undefined;
      const wanted = target.section.toLowerCase();
      return candidates.filter((element) => nearestSectionHeading(element, policy)?.toLowerCase() === wanted);
    }
  }
}

/**
 * Generic resolution, driven by the platform's declared identity priority.
 *
 * Each signal narrows the candidate set in the order the platform says is
 * strongest; the first ordering that leaves exactly one candidate wins. A
 * signal that would eliminate everything is skipped rather than allowed to
 * empty the set — evidence that disagrees is weaker evidence, not proof of
 * absence. Zero matches or a genuine tie both fail rather than guess, the
 * same "silence beats a wrong write" rule `fieldMapping.ts` applies.
 */
function resolveGeneric(root: ParentNode, target: SemanticTarget, policy: ResolutionPolicy): ResolveOutcome {
  const candidates = collectElements(root, selectorForRole(target.role), policy).filter(isVisible);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `No ${target.role} elements at all were found on the page for "${target.label}".`,
      diagnostics: { candidatesConsidered: 0, traversal: policy.traversal, appliedSignals: [] }
    };
  }

  let matches = [...candidates];
  const appliedSignals: string[] = [];
  for (const signal of policy.identityPriority) {
    // Deliberately no early exit on a single remaining candidate: "only one
    // field on the page" is not evidence that it is *this* target, and
    // skipping the check would happily write into whatever happened to be
    // there. Every applicable signal is applied.
    const narrowed = narrowBy(signal, matches, target, policy);
    if (!narrowed || narrowed.length === 0) continue;
    matches = narrowed;
    appliedSignals.push(signal);
  }

  // Nothing narrowed at all: every candidate is still in play, which is not
  // a match, it is an unfiltered list.
  if (appliedSignals.length === 0) {
    return {
      ok: false,
      reason: `No element with the accessible name "${target.label}" was found on the page.`,
      diagnostics: { candidatesConsidered: candidates.length, traversal: policy.traversal, appliedSignals }
    };
  }

  if (matches.length !== 1) {
    return {
      ok: false,
      reason: `"${target.label}" matched ${matches.length} elements on the page; a single unambiguous match is required.`,
      diagnostics: { candidatesConsidered: candidates.length, traversal: policy.traversal, appliedSignals }
    };
  }

  return {
    ok: true,
    target: { element: matches[0], strategy: `generic:${appliedSignals.join("+")}` }
  };
}

/** The policy in force for a resolution — the adapter's, or the generic default. */
export function policyFor(adapter?: PlatformResolverAdapter): ResolutionPolicy {
  return adapter?.resolutionPolicy ?? DEFAULT_RESOLUTION_POLICY;
}

/**
 * Resolves a semantic target against the live DOM. The platform adapter, if
 * given, always gets first refusal; this function only falls back to
 * generic reasoning when it declines.
 */
export function resolveSemanticTarget(
  root: ParentNode,
  target: SemanticTarget,
  adapter?: PlatformResolverAdapter
): ResolveOutcome {
  const policy = policyFor(adapter);
  const fromAdapter = adapter?.resolveTarget?.(root, target, policy);
  if (fromAdapter) return { ok: true, target: fromAdapter };
  return resolveGeneric(root, target, policy);
}

/* -------------------------------- writing -------------------------------- */

/**
 * Sets a native form control's value through its property setter rather
 * than its attribute, so a framework's reactive bindings observe the
 * change, then dispatches the events a real keystroke or selection would —
 * the "safe DOM-property setter + correct browser events" strategy. Used as
 * the generic fallback; platform adapters get first refusal for anything a
 * component library intercepts before it reaches the native control.
 */
function writeNativeValue(element: Element, value: string): FieldWriteOutcome {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
    return { ok: true, detail: "Value set via the native input/textarea property setter." };
  }

  if (element instanceof HTMLSelectElement) {
    const option = [...element.options].find(
      (candidate) => candidate.value === value || normalizeLabel(candidate.textContent ?? "") === normalizeLabel(value)
    );
    if (!option) return { ok: false, detail: `No option matching "${value}" was found in the select.` };
    element.value = option.value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, detail: "Value set via the native select's value property." };
  }

  if (element.getAttribute("contenteditable") === "true") {
    element.textContent = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, detail: "Value set via contenteditable text content." };
  }

  return { ok: false, detail: `Element <${element.tagName.toLowerCase()}> has no generic way to receive a value.` };
}

/**
 * Sets a resolved field's value. Platform adapters get first refusal — the
 * date-picker hard case in particular usually needs one — and this function
 * only performs the generic native-property write when the adapter declines
 * or none was given.
 */
export async function setFieldValue(
  resolved: ResolvedTarget,
  value: string,
  valueKind: FieldValueKind,
  adapter?: PlatformResolverAdapter,
  context?: WriteContext
): Promise<FieldWriteOutcome> {
  const fromAdapter = await adapter?.setFieldValue?.(resolved, value, valueKind, policyFor(adapter), context);
  if (fromAdapter) return fromAdapter;
  return writeNativeValue(resolved.element, value);
}

/**
 * The values a control currently offers, read from the live application.
 *
 * The most accurate source of a value domain there is: it reflects this
 * record's type, the current state of any controlling field, and the
 * running user's permissions, none of which a stored snapshot can know.
 * Generic by design — the engine knows only "closed domain", and how to
 * open a particular platform's control belongs to its adapter.
 */
export async function readSemanticOptions(
  root: ParentNode,
  target: SemanticTarget,
  adapter?: Pick<PlatformResolverAdapter, "id" | "resolutionPolicy" | "readFieldOptions" | "resolveTarget">
): Promise<OptionReadOutcome> {
  const fromAdapter = await adapter?.readFieldOptions?.(root, target, policyFor(adapter));
  if (fromAdapter) return fromAdapter;

  // The generic case: a real `<select>` lists its own options and needs no
  // interaction at all, so there is nothing to restore.
  const outcome = resolveSemanticTarget(root, target, adapter);
  if (!outcome.ok) {
    return { openedByUs: false, dismissAttempted: false, dismissProven: true, detail: outcome.reason };
  }
  const element = outcome.target.element;
  if (element instanceof HTMLSelectElement) {
    const labels = [...new Set([...element.options].map((option) => (option.textContent ?? "").trim()).filter(Boolean))];
    return {
      ...(labels.length > 0 ? { options: labels } : {}),
      openedByUs: false,
      dismissAttempted: false,
      dismissProven: true,
      detail: labels.length > 0 ? `Read ${labels.length} options from the native select.` : "The native select offers no options."
    };
  }
  return {
    openedByUs: false,
    dismissAttempted: false,
    dismissProven: true,
    detail: "This control exposes no readable set of choices."
  };
}

/* -------------------------------- actions -------------------------------- */

/** Resolves and activates a semantic action (e.g. the Save button) via a real click event. */
export async function invokeSemanticAction(
  root: ParentNode,
  target: SemanticTarget,
  adapter?: PlatformResolverAdapter
): Promise<FieldWriteOutcome & { resolved?: ResolvedTarget }> {
  const outcome = resolveSemanticTarget(root, target, adapter);
  if (!outcome.ok) return { ok: false, detail: outcome.reason };

  if (!(outcome.target.element instanceof HTMLElement)) {
    return { ok: false, detail: "The resolved commit target is not clickable.", resolved: outcome.target };
  }
  outcome.target.element.click();
  return { ok: true, detail: `Activated "${target.label}".`, resolved: outcome.target };
}

/* ------------------------------- waiting ------------------------------- */

export interface ReactionOptions {
  root: Node;
  /** Stop waiting once no mutation has landed for this long. */
  quietMs?: number;
  /** Never wait longer than this in total. */
  timeoutMs?: number;
}

export interface ReactionSnapshot {
  /** `true` once the DOM went quiet before the timeout; `false` if the timeout won. */
  settled: boolean;
  elapsedMs: number;
}

/**
 * Waits for the application's asynchronous reaction to a commit to finish —
 * a save producing a re-render, a validation message appearing, a navigation
 * back to the record view — by watching for the DOM to stop mutating rather
 * than sleeping a fixed guess.
 */
export function waitForApplicationReaction(options: ReactionOptions): Promise<ReactionSnapshot> {
  const quietMs = options.quietMs ?? 400;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const start = Date.now();

  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout>;
    let timeoutTimer: ReturnType<typeof setTimeout>;

    const finish = (settled: boolean): void => {
      clearTimeout(quietTimer);
      clearTimeout(timeoutTimer);
      observer.disconnect();
      resolve({ settled, elapsedMs: Date.now() - start });
    };

    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), quietMs);
    });
    observer.observe(options.root, { childList: true, subtree: true, attributes: true, characterData: true });

    quietTimer = setTimeout(() => finish(true), quietMs);
    timeoutTimer = setTimeout(() => finish(false), timeoutMs);
  });
}

/* ------------------------------ verification ------------------------------ */

export interface VerifyContext {
  root: ParentNode;
  checks: readonly VerificationCheck[];
  inputs: ReadonlyArray<{ target: SemanticTarget; expectedValue: string }>;
  /** This org's established date ordering. Absent means undetermined, never month-first. */
  dateOrder?: DateOrder;
  adapter?: PlatformResolverAdapter;
}

/**
 * Compares a requested value to what the page displays. A record view does
 * not echo the input's wire format — a date written as `2026-10-01` is
 * displayed as `10/1/2026` — so equal date *parts* count as a match. A
 * value that neither matches nor parses into a comparable form is
 * `incomparable`: not proof of a wrong write, and never silently proof of
 * a right one.
 *
 * `order` is this org's date ordering, and omitting it is not the same as
 * assuming one. A displayed `3/4/2027` means different days in different
 * orgs, so without an established ordering it is `incomparable` — the one
 * answer that is true either way. Reading it month-first by default is
 * what let a wrong record report `match`.
 */
export function compareObservedValue(
  expected: string,
  observed: string,
  order?: DateOrder
): "match" | "mismatch" | "incomparable" {
  if (normalizeLabel(observed) === normalizeLabel(expected)) return "match";
  const expectedDate = parseDisplayedDate(expected, order);
  const observedDate = parseDisplayedDate(observed, order);
  // Either side unreadable for want of an ordering makes the comparison
  // unanswerable, never a verdict.
  if (expectedDate === "ambiguous" || observedDate === "ambiguous") return "incomparable";
  if (expectedDate && observedDate) {
    return expectedDate.year === observedDate.year &&
      expectedDate.month === observedDate.month &&
      expectedDate.day === observedDate.day
      ? "match"
      : "mismatch";
  }
  if (expectedDate || observedDate) return "incomparable";
  return "mismatch";
}

const GENERIC_VALIDATION_SELECTOR = '[role="alert"], [aria-invalid="true"]';

function genericHasValidationError(root: ParentNode, policy: ResolutionPolicy): boolean {
  return collectElements(root, GENERIC_VALIDATION_SELECTOR, policy).some(isVisible);
}

function genericReadFieldValue(
  root: ParentNode,
  target: SemanticTarget,
  policy: ResolutionPolicy
): string | undefined {
  const outcome = resolveGeneric(root, target, policy);
  if (!outcome.ok) return undefined;
  const element = outcome.target.element;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
  if (element instanceof HTMLSelectElement) return element.options[element.selectedIndex]?.text ?? element.value;
  return textOf(element);
}

/**
 * Runs the binding's declared verification checks against the live DOM
 * after a commit. Every check that cannot honestly be answered is reported
 * `skipped`, never assumed passing — see `execute.ts` for how that maps to
 * an overall result.
 */
export function verifyOutcome(context: VerifyContext): ExecutionCheckResult[] {
  const results: ExecutionCheckResult[] = [];
  const policy = policyFor(context.adapter);

  if (context.checks.includes("no-validation-error-visible")) {
    const assessment = context.adapter?.assessValidation?.(context.root, policy);
    const hasError = assessment ? assessment.blocking : genericHasValidationError(context.root, policy);
    const notes = assessment?.notes.length ? ` ${assessment.notes.join(" ")}` : "";
    results.push({
      name: "validation_clear",
      status: hasError ? "fail" : "pass",
      detail: hasError
        ? `A blocking validation error is in effect.${notes}`
        : `No blocking validation error is in effect.${notes}`
    });
  }

  if (context.checks.includes("edit-state-closed") || context.checks.includes("returned-to-record-view")) {
    const closed = context.adapter?.isEditStateClosed?.(context.root, policy);
    results.push({
      name: "returned_to_record",
      status: closed === undefined ? "skipped" : closed ? "pass" : "fail",
      detail:
        closed === undefined
          ? "No platform adapter could determine whether the edit view closed."
          : closed
            ? "The edit view closed and the page returned to a record view."
            : "The edit view is still open."
    });
  }

  if (context.checks.includes("field-value-observable")) {
    let allObserved = true;
    let allMatched = true;
    const details: string[] = [];

    for (const input of context.inputs) {
      const value =
        context.adapter?.readFieldValue?.(context.root, input.target, policy) ??
        genericReadFieldValue(context.root, input.target, policy);
      if (value === undefined) {
        allObserved = false;
        details.push(`"${input.target.label}" could not be read back.`);
        continue;
      }
      const comparison = compareObservedValue(input.expectedValue, value, context.dateOrder);
      if (comparison === "incomparable") {
        // The read-back produced something that neither matches nor can be
        // meaningfully compared (a display string the extractor misjudged).
        // That is "could not verify", never proof of a wrong write — and
        // never silently proof of a right one either.
        allObserved = false;
        details.push(`"${input.target.label}" read back as "${value}", which cannot be compared to "${input.expectedValue}".`);
        continue;
      }
      if (comparison === "mismatch") {
        allMatched = false;
        details.push(`"${input.target.label}" reads "${value}", expected "${input.expectedValue}".`);
      }
    }

    results.push({
      name: "value_verified",
      status: !allObserved ? "skipped" : allMatched ? "pass" : "fail",
      detail: !allObserved
        ? `Read-back unavailable: ${details.join(" ")}`
        : allMatched
          ? "Every input's value was observed and matches what was requested."
          : details.join(" ")
    });
  }

  return results;
}
