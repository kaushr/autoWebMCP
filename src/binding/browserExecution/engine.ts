import type { FieldValueKind, SemanticTarget, VerificationCheck } from "./model";
import type { ExecutionCheckResult } from "./result";

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

export type ResolveOutcome = { ok: true; target: ResolvedTarget } | { ok: false; reason: string };

export type FieldWriteOutcome = { ok: boolean; detail: string };

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
  resolveTarget?(root: ParentNode, target: SemanticTarget): ResolvedTarget | undefined;
  setFieldValue?(
    resolved: ResolvedTarget,
    value: string,
    valueKind: FieldValueKind
  ): Promise<FieldWriteOutcome> | FieldWriteOutcome | undefined;
  /** `true`/`false` is a real answer; `undefined` means "ask the generic check instead". */
  hasValidationError?(root: ParentNode): boolean | undefined;
  isEditStateClosed?(root: ParentNode): boolean | undefined;
  /** Reads a field's current on-screen value back, for verification. `undefined` means unreadable. */
  readFieldValue?(root: ParentNode, target: SemanticTarget): string | undefined;
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

function findById(root: ParentNode, id: string): Element | null {
  const owner = "getElementById" in root ? (root as Document) : (root.getRootNode?.() as Document | undefined);
  return owner?.getElementById?.(id) ?? root.querySelector(`#${cssEscapeId(id)}`);
}

function cssEscapeId(id: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/([^\w-])/g, "\\$1");
}

/** The accessible name of an element, by the same priority a screen reader would use. */
export function accessibleName(element: Element, root: ParentNode): string | undefined {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => textOf(findById(root, id)))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (text) return text;
  }

  const id = element.getAttribute("id");
  if (id) {
    const label = root.querySelector(`label[for="${cssEscapeId(id)}"]`);
    const labelText = textOf(label);
    if (labelText) return labelText;
  }

  const closestLabel = element.closest("label");
  const closestLabelText = textOf(closestLabel);
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

/** The nearest enclosing section/card/fieldset heading, mirroring the extension's own capture policy. */
function nearestSectionHeading(element: Element): string | undefined {
  const section = element.closest(
    '[role="dialog"], [role="region"], [role="tabpanel"], form, fieldset, section, article'
  );
  if (!section) return undefined;
  const heading = section.querySelector('[role="heading"], h1, h2, h3, h4, h5, h6, legend');
  return textOf(heading);
}

/* ----------------------------- candidate walk ----------------------------- */

/**
 * Collects matching elements, piercing open shadow roots. A closed shadow
 * root exposes nothing to any script, including this one, by design — that
 * is a real limit of the browser platform, not a bug in this resolver, and
 * it is why a platform adapter exists for components that use one.
 */
function collectElements(root: ParentNode, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)];
  for (const host of root.querySelectorAll("*")) {
    const shadow = (host as Element).shadowRoot;
    if (shadow) found.push(...collectElements(shadow, selector));
  }
  return found;
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

function isVisible(element: Element): boolean {
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
function resolveGeneric(root: ParentNode, target: SemanticTarget): ResolveOutcome {
  const candidates = collectElements(root, selectorForRole(target.role)).filter(isVisible);
  const wantedLabel = normalizeLabel(target.label);

  let matches = candidates.filter((element) => {
    const name = accessibleName(element, root);
    return name !== undefined && normalizeLabel(name) === wantedLabel;
  });

  if (matches.length === 0) {
    // A field's application identifier is stable evidence even when the
    // visible label drifted (a translation, a redesign) — try it before
    // giving up entirely.
    if (target.applicationIdentifier) {
      matches = candidates.filter(
        (element) =>
          element.getAttribute("name") === target.applicationIdentifier ||
          element.getAttribute("id") === target.applicationIdentifier
      );
    }
    if (matches.length === 0) {
      return { ok: false, reason: `No element with the accessible name "${target.label}" was found on the page.` };
    }
  }

  if (matches.length > 1 && target.applicationIdentifier) {
    const byIdentifier = matches.filter(
      (element) =>
        element.getAttribute("name") === target.applicationIdentifier ||
        element.getAttribute("id") === target.applicationIdentifier
    );
    if (byIdentifier.length === 1) matches = byIdentifier;
  }

  if (matches.length > 1 && target.section) {
    const bySection = matches.filter(
      (element) => nearestSectionHeading(element)?.toLowerCase() === target.section?.toLowerCase()
    );
    if (bySection.length >= 1) matches = bySection;
  }

  if (matches.length !== 1) {
    return {
      ok: false,
      reason: `"${target.label}" matched ${matches.length} elements on the page; a single unambiguous match is required.`
    };
  }

  return { ok: true, target: { element: matches[0], strategy: "generic-accessible-name" } };
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
  const fromAdapter = adapter?.resolveTarget?.(root, target);
  if (fromAdapter) return { ok: true, target: fromAdapter };
  return resolveGeneric(root, target);
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
  adapter?: PlatformResolverAdapter
): Promise<FieldWriteOutcome> {
  const fromAdapter = await adapter?.setFieldValue?.(resolved, value, valueKind);
  if (fromAdapter) return fromAdapter;
  return writeNativeValue(resolved.element, value);
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
  adapter?: PlatformResolverAdapter;
}

const GENERIC_VALIDATION_SELECTOR = '[role="alert"], [aria-invalid="true"]';

function genericHasValidationError(root: ParentNode): boolean {
  return collectElements(root, GENERIC_VALIDATION_SELECTOR).some(isVisible);
}

function genericReadFieldValue(root: ParentNode, target: SemanticTarget): string | undefined {
  const outcome = resolveGeneric(root, target);
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

  if (context.checks.includes("no-validation-error-visible")) {
    const hasError = context.adapter?.hasValidationError?.(context.root) ?? genericHasValidationError(context.root);
    results.push({
      name: "validation_clear",
      status: hasError ? "fail" : "pass",
      detail: hasError ? "A validation error is visible on the page." : "No validation error is visible."
    });
  }

  if (context.checks.includes("edit-state-closed") || context.checks.includes("returned-to-record-view")) {
    const closed = context.adapter?.isEditStateClosed?.(context.root);
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
        context.adapter?.readFieldValue?.(context.root, input.target) ??
        genericReadFieldValue(context.root, input.target);
      if (value === undefined) {
        allObserved = false;
        details.push(`"${input.target.label}" could not be read back.`);
        continue;
      }
      if (normalizeLabel(value) !== normalizeLabel(input.expectedValue)) {
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
