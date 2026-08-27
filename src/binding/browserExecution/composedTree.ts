import type { ResolutionPolicy } from "./resolutionPolicy";

/* ------------------------------------------------------------------ *
 * Composed-tree traversal.
 *
 * The single traversal foundation for every semantic resolution the
 * browser execution engine performs. It exists because a live Salesforce
 * test produced the same defect four separate times — an Edit control, a
 * field host, a field's value read-back, and a native input each "not
 * found" — every one of them a plain `querySelectorAll` that could not
 * cross a Lightning shadow boundary.
 *
 * Fixing those individually was the wrong shape of fix. A platform whose
 * controls live behind component boundaries needs *all* of its resolution
 * to traverse the composed tree, consistently, or the next lookup written
 * anywhere in the codebase reintroduces the bug. Whether to descend is a
 * platform *policy* (see `resolutionPolicy.ts`, sourced from Platform
 * Intelligence); descending correctly is this module's *mechanism*.
 *
 * Nothing here is Salesforce-specific, and nothing here produces or
 * consumes a selector chain, XPath, coordinate, or node id: callers pass
 * element *shapes* (a tag/role selector) and match on semantic identity.
 * ------------------------------------------------------------------ */

/** Guards against a pathological or cyclic component tree. Far deeper than any real UI nests. */
const MAX_SHADOW_DEPTH = 30;

function descends(policy: ResolutionPolicy): boolean {
  return policy.shadowRoots === "recursive";
}

/**
 * Every element under `root`, descending into open shadow roots when the
 * policy calls for it. A closed shadow root exposes nothing to any script,
 * including this one — a real platform limit, not a gap here.
 */
export function composedDescendants(root: ParentNode, policy: ResolutionPolicy): Element[] {
  const found: Element[] = [];
  const visit = (node: ParentNode, depth: number): void => {
    if (depth > MAX_SHADOW_DEPTH) return;
    if (descends(policy)) visitOwnShadow(node, depth, visit);
    for (const element of node.querySelectorAll("*")) {
      found.push(element);
      const shadow = element.shadowRoot;
      if (shadow && descends(policy)) visit(shadow, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

/**
 * A root that is itself a component host.
 *
 * `querySelectorAll` on an element searches its light-DOM subtree and
 * stops at its own shadow boundary, so a caller that passes a component —
 * `queryComposedTree(fieldHost, …)`, which is the normal thing to do once
 * a field has been resolved — would search everything except the shadow
 * root where that component actually keeps its controls. A Lightning
 * picklist keeps its combobox trigger exactly there, and the omission read
 * as "this field has no control".
 */
function visitOwnShadow(
  node: ParentNode,
  depth: number,
  visit: (node: ParentNode, depth: number) => void
): void {
  const shadow = node instanceof Element ? node.shadowRoot : null;
  if (shadow) visit(shadow, depth + 1);
}

/** `querySelectorAll` across the composed tree, honouring the platform's traversal policy. */
export function queryComposedTree(root: ParentNode, selector: string, policy: ResolutionPolicy): Element[] {
  const found: Element[] = [];
  const visit = (node: ParentNode, depth: number): void => {
    if (depth > MAX_SHADOW_DEPTH) return;
    found.push(...node.querySelectorAll(selector));
    if (!descends(policy)) return;
    visitOwnShadow(node, depth, visit);
    for (const element of node.querySelectorAll("*")) {
      const shadow = element.shadowRoot;
      if (shadow) visit(shadow, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

/** The first composed-tree match, or `undefined`. */
export function queryComposedTreeFirst(
  root: ParentNode,
  selector: string,
  policy: ResolutionPolicy
): Element | undefined {
  return queryComposedTree(root, selector, policy)[0];
}

/**
 * The first composed-tree match, considering the root element ITSELF.
 *
 * A semantic resolver is allowed to land on whatever element carries the
 * field's identity — sometimes a component host, sometimes a light-DOM
 * wrapper, sometimes the native control itself. Downstream control
 * discovery must not assume which: searching only *inside* the resolved
 * element silently fails when the resolution was exact, which is how a
 * date field that resolved perfectly reported having no date control.
 */
export function composedMatchWithin(
  root: Element,
  selector: string,
  policy: ResolutionPolicy
): Element | undefined {
  if (root.matches(selector)) return root;
  return queryComposedTreeFirst(root, selector, policy);
}

/**
 * `closest`, continued across shadow boundaries by stepping from a shadow
 * root to its host. Native `closest` stops at the boundary, which silently
 * loses any ancestor context a component is nested inside — the enclosing
 * form or section of a Lightning field being exactly that case.
 */
export function composedClosest(
  element: Element,
  selector: string,
  policy: ResolutionPolicy
): Element | undefined {
  let current: Element | null = element;
  let depth = 0;
  while (current && depth <= MAX_SHADOW_DEPTH) {
    const match = current.closest(selector);
    if (match) return match;
    if (!descends(policy)) return undefined;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
    depth++;
  }
  return undefined;
}

/**
 * The root an element's own id references resolve against. `<label for>`
 * and `aria-labelledby` name ids scoped to the element's own tree, so a
 * document-scoped lookup finds nothing for anything inside a component.
 * Callers should never have to remember this — every name lookup in this
 * codebase goes through `accessibleName` below, which applies it.
 */
export function ownerScope(element: Element): ParentNode {
  const root = element.getRootNode();
  return root instanceof ShadowRoot || root instanceof Document ? (root as ParentNode) : element;
}
