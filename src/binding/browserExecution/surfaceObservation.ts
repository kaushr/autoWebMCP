import type { ResolutionPolicy } from "./resolutionPolicy";
import {
  composedContains,
  composedParent,
  isCustomElement,
  isPotentialFieldHost,
  queryComposedTree,
  queryComposedTreeFirst
} from "./composedTree";
import { accessibleName, isVisible, normalizeLabel } from "./engine";

/* ------------------------------------------------------------------ *
 * Neutral surface observation.
 *
 * Structural candidate discovery, generic across platforms. It reports
 * what the composed document contains — clusters of editable fields,
 * actions, headings, component identities, ARIA roles — without ever
 * concluding what any of it means. That interpretation belongs entirely
 * to a platform's own Platform Intelligence.
 *
 * Exists because Salesforce page-state classification previously
 * discovered its candidate surfaces through a hardcoded selector
 * (`[role="dialog"], [aria-modal="true"]`, plus whatever component tags
 * the platform happened to declare) *before* Platform Intelligence ever
 * got a say. A live edit form with sixteen fields and a Save button never
 * matched any of those identities, so it never became a candidate at
 * all — not because field detection or composed-tree traversal failed
 * (both are shared with execution's own field resolution, and both are
 * proven correct), but because candidate discovery itself was too narrow
 * and ran too early to be corrected by knowledge. This module inverts
 * that order: observe broadly first, let a platform's knowledge decide
 * what any of it means second.
 * ------------------------------------------------------------------ */

export interface EditableFieldUnit {
  element: Element;
  kind: "component-host" | "native-control";
}

export interface SurfaceAction {
  element: Element;
  /** Normalized (trimmed, lowercased) accessible name. */
  label: string;
}

/** One step of an action-anchored expansion climb, kept for diagnosis. */
export interface ExpansionStep {
  /** A short, neutral descriptor — tag name, id, and first couple of classes. Never a durable selector. */
  element: string;
  editableFieldCount: number;
}

/** A neutral, exportable description of a candidate surface — facts, not DOM references. */
export interface SurfaceFacts {
  heading?: string;
  visible: boolean;
  editableFieldCount: number;
  /** Normalized accessible names of every visible action found in this surface. */
  actionLabels: string[];
  /** ARIA roles/markers found on the surface's own root element. */
  roles: string[];
  /** Tag names of every custom element found at or beneath the surface root. */
  componentIdentities: string[];
  /**
   * Present only for a surface discovered by climbing from an action: the
   * hop-by-hop field count seen along the way, from the action itself up
   * to wherever the climb stopped. Exists so a failure to find the real
   * form is diagnosable directly — how deep the real nesting actually is,
   * and whether the bounded hop budget was the thing that ran out —
   * rather than guessed at from outside.
   */
  expansionTrace?: ExpansionStep[];
}

export interface SurfaceObservation {
  id: string;
  root: Element;
  fieldUnits: EditableFieldUnit[];
  actions: SurfaceAction[];
  facts: SurfaceFacts;
}

const ACTION_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"]';
const HEADING_SELECTOR = 'h1, h2, h3, [role="heading"]';
const DIALOG_ROLE_SELECTOR = '[role="dialog"], [aria-modal="true"]';
/** The native-tag definition of "editable," used only for controls no counted component host already owns. */
const NATIVE_FIELD_SELECTOR = 'input:not([type="hidden"]), select, textarea, [role="textbox"], [contenteditable="true"]';
/**
 * How far a candidate surface is allowed to grow while expanding outward
 * from a single action. Bounded on purpose: this is a structural heuristic
 * for "which nearby fields does this action belong to," not a general page
 * segmentation algorithm, and no real UI needs more than this to relate a
 * commit action to the form around it.
 */
const MAX_EXPANSION_HOPS = 10;

/**
 * Every editable field unit in the document: a component host that owns a
 * value counts once, and a native control counts only when no counted host
 * already contains it — otherwise one `lightning-input` wrapping one
 * `<input>` would count as two fields, and a lone search box would satisfy
 * a multi-field threshold by itself. Computed once, document-wide, so every
 * candidate surface's count is a `composedContains` filter over the same
 * set rather than a repeated, possibly-inconsistent re-scan.
 */
function allFieldUnits(root: ParentNode, policy: ResolutionPolicy): EditableFieldUnit[] {
  const hosts = queryComposedTree(root, "*", policy).filter(
    (element) => isVisible(element) && isPotentialFieldHost(element, policy)
  );
  const topHosts = hosts.filter((host) => !hosts.some((other) => other !== host && composedContains(other, host)));
  const natives = queryComposedTree(root, NATIVE_FIELD_SELECTOR, policy)
    .filter(isVisible)
    .filter((native) => !topHosts.some((host) => composedContains(host, native)));
  return [
    ...topHosts.map((element) => ({ element, kind: "component-host" as const })),
    ...natives.map((element) => ({ element, kind: "native-control" as const }))
  ];
}

function allActions(root: ParentNode, policy: ResolutionPolicy): SurfaceAction[] {
  return queryComposedTree(root, ACTION_SELECTOR, policy)
    .filter(isVisible)
    .map((element) => ({ element, label: normalizeLabel(accessibleName(element) ?? "") }))
    .filter((action) => action.label.length > 0);
}

function within<T extends { element: Element }>(root: Element, items: readonly T[]): T[] {
  return items.filter((item) => root === item.element || composedContains(root, item.element));
}

function headingWithin(root: Element, policy: ResolutionPolicy): string | undefined {
  // aria-labelledby is checked first: the real Aura "Sorry to interrupt"
  // error surface names itself that way — `aria-labelledby="auraErrorTitle"`
  // pointing at a plain `<span>`, not a semantic heading tag — and a
  // heading-tag-only search missed it entirely.
  const labelledBy = root.getAttribute("aria-labelledby");
  if (labelledBy) {
    const scope = root.ownerDocument ?? document;
    const label = labelledBy
      .split(/\s+/)
      .map((id) => scope.getElementById(id))
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .map((el) => (el.textContent ?? "").trim())
      .filter(Boolean)
      .join(" ");
    if (label.length > 0) return label;
  }
  const heading = root.matches(HEADING_SELECTOR) ? root : queryComposedTreeFirst(root, HEADING_SELECTOR, policy);
  if (!heading) return undefined;
  const text = (accessibleName(heading) ?? heading.textContent ?? "").trim();
  return text.length > 0 ? text : undefined;
}

function componentIdentitiesWithin(root: Element, policy: ResolutionPolicy): string[] {
  const tags = new Set<string>();
  if (isCustomElement(root)) tags.add(root.tagName.toLowerCase());
  for (const element of queryComposedTree(root, "*", policy)) {
    if (isCustomElement(element)) tags.add(element.tagName.toLowerCase());
  }
  return [...tags];
}

function rolesOf(root: Element): string[] {
  const roles: string[] = [];
  const role = root.getAttribute("role");
  if (role) roles.push(role);
  if (root.getAttribute("aria-modal") === "true") roles.push("aria-modal");
  return roles;
}

/** A short, neutral descriptor for diagnostics — never a durable selector. */
function describeElement(element: Element): string {
  const classes = element.classList.length > 0 ? `.${[...element.classList].slice(0, 2).join(".")}` : "";
  const id = element.id ? `#${element.id}` : "";
  return `${element.tagName.toLowerCase()}${id}${classes}`;
}

function describeSurface(
  root: Element,
  id: string,
  units: readonly EditableFieldUnit[],
  actions: readonly SurfaceAction[],
  policy: ResolutionPolicy,
  expansionTrace?: ExpansionStep[]
): SurfaceObservation {
  const fieldUnits = within(root, units);
  const surfaceActions = within(root, actions);
  return {
    id,
    root,
    fieldUnits,
    actions: surfaceActions,
    facts: {
      heading: headingWithin(root, policy),
      visible: isVisible(root),
      editableFieldCount: fieldUnits.length,
      actionLabels: [...new Set(surfaceActions.map((action) => action.label))],
      roles: rolesOf(root),
      componentIdentities: componentIdentitiesWithin(root, policy),
      ...(expansionTrace ? { expansionTrace } : {})
    }
  };
}

/**
 * Where a visible action's own surface plausibly ends: walk up the
 * composed tree from the action, up to a bounded number of hops, and keep
 * whichever ancestor along the way contains the most editable field
 * units. This is what finds "the form this Save button belongs to"
 * without knowing anything about what a form looks like on any particular
 * platform — it only uses the structural fact that a commit-shaped action
 * and the fields it commits are usually near each other in the composed
 * tree, which is what let a real, sixteen-field Salesforce edit form
 * become observable even though its own container carried no dialog role
 * and no known component tag at all.
 *
 * The climb does NOT stop at the first hop that fails to capture more
 * fields than the hop before it. An earlier version did, on the
 * assumption that field count grows steadily while climbing — which
 * proved false against a real Lightning modal: its footer (Save/Cancel)
 * and its scrollable body (every field) are typically siblings several
 * wrapper levels apart, not parent and child. Climbing from Save can pick
 * up one incidental field early, hit a wrapper level that adds nothing,
 * and — under the old logic — read that flat hop as "boundary found" and
 * stop right there, one hop short of the level that would have merged in
 * the entire field-rich body. A live run reproduced exactly that: a
 * winning candidate of one field, next to a genuine Save and Cancel,
 * while the real form's sixteen fields sat one hop further up. The fix is
 * to keep climbing the full bounded budget regardless of a flat hop, and
 * remember the best count seen anywhere along the way — a later jump is
 * not missed just because an earlier hop happened not to grow.
 */
function expandFromAction(
  action: Element,
  units: readonly EditableFieldUnit[],
  documentRoot: ParentNode,
  policy: ResolutionPolicy
): { best: Element; trace: ExpansionStep[] } {
  let best = action;
  let bestCount = within(action, units).length;
  let current: Element = action;
  const trace: ExpansionStep[] = [{ element: describeElement(action), editableFieldCount: bestCount }];
  for (let hop = 0; hop < MAX_EXPANSION_HOPS; hop++) {
    const parent = composedParent(current);
    // The traversal root itself — and `<body>`/`<html>` specifically, since
    // `composedParent` never yields the `Document` object even when that
    // was the root passed in — is never accepted as a surface. "The whole
    // page is the edit surface" is exactly the false positive this exists
    // to prevent — a flat test fixture with a stray Save button and two
    // unrelated fields as document-level siblings has nothing structurally
    // between the button and the page root, and without this bound the
    // expansion would happily climb all the way there and call the entire
    // page one candidate.
    if (!parent || parent === documentRoot || parent.tagName === "BODY" || parent.tagName === "HTML") break;
    const count = within(parent, units).length;
    trace.push({ element: describeElement(parent), editableFieldCount: count });
    // Strictly greater only: a tie keeps the earlier, tighter ancestor,
    // so a run of flat hops after the real boundary never widens the
    // result past where it needs to be.
    if (count > bestCount) {
      best = parent;
      bestCount = count;
    }
    current = parent;
  }
  void policy; // reserved for a future traversal-policy-sensitive expansion rule
  return { best, trace };
}

function dedupeByContainment(elements: readonly Element[]): Element[] {
  return elements.filter((el) => !elements.some((other) => other !== el && composedContains(other, el)));
}

/**
 * Every plausible candidate surface in the document, generic across
 * platforms: explicit structural boundaries (dialog/modal roles, any
 * custom element — a potential component boundary) union'd with the
 * structural neighbourhood of every visible, labelled action. A platform's
 * Platform Intelligence decides which of these, if any, mean "record-edit"
 * — this only decides what is observable at all.
 *
 * Deliberately not a general page-segmentation algorithm: bounded
 * expansion, simple containment-based dedup, nothing learned or inferred
 * beyond structural proximity. It is exactly as sophisticated as the one
 * case that required it, and no more.
 */
export function observeSurfaces(root: ParentNode, policy: ResolutionPolicy): SurfaceObservation[] {
  const units = allFieldUnits(root, policy);
  const actions = allActions(root, policy);

  const candidates = new Set<Element>();
  const traces = new Map<Element, ExpansionStep[]>();
  for (const element of queryComposedTree(root, DIALOG_ROLE_SELECTOR, policy)) candidates.add(element);
  for (const element of queryComposedTree(root, "*", policy)) {
    if (isCustomElement(element)) candidates.add(element);
  }
  for (const action of actions) {
    const { best, trace } = expandFromAction(action.element, units, root, policy);
    candidates.add(best);
    // Several actions can land on the same candidate after dedup; keep
    // whichever trace actually climbed further, since that is the more
    // informative one to see when diagnosing a shortfall.
    const existing = traces.get(best);
    if (!existing || trace.length > existing.length) traces.set(best, trace);
  }

  const deduped = dedupeByContainment([...candidates]).filter(isVisible);
  return deduped.map((element, index) =>
    describeSurface(element, `surface-${index}`, units, actions, policy, traces.get(element))
  );
}
