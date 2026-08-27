/* ------------------------------------------------------------------ *
 * Resolution policy — how a platform must be traversed and identified.
 *
 * The deliberate seam between knowledge and mechanism. Platform
 * Intelligence knows things like "Lightning hides native controls behind
 * component and shadow boundaries" and "events are retargeted at component
 * hosts"; this is the small, deterministic, vendor-free shape that
 * knowledge is compiled into before the execution engine acts on it.
 *
 * Deliberately not an import of Platform Intelligence: the engine must stay
 * generic, and a platform must be able to declare different resolution
 * behaviour without the engine changing. Translation from pack knowledge to
 * this shape happens once, in `adapters.ts` — the composition root.
 *
 * Equally deliberately: no model is consulted at runtime. A DOM lookup is
 * mechanism, and mechanism stays deterministic.
 * ------------------------------------------------------------------ */

/** What identifies a control, strongest evidence first. */
export type IdentitySignal = "applicationIdentifier" | "accessibleName" | "section";

export interface ResolutionPolicy {
  /**
   * `composed-tree` descends through open shadow roots; `flat-dom` stays in
   * the light DOM. Identical results on a page with no shadow DOM, so the
   * distinction only matters where a platform actually encapsulates.
   */
  traversal: "flat-dom" | "composed-tree";
  shadowRoots: "ignore" | "recursive";
  /**
   * Whether a component may re-fire events at its host rather than the
   * control that was actually operated. Where true, a write must dispatch
   * `composed` events so the framework observes them at all.
   */
  eventRetargeting: boolean;
  /** Ordered: the first signal that yields exactly one candidate wins. */
  identityPriority: IdentitySignal[];
}

/**
 * What an ordinary web page gets. Flat traversal, name-first identity —
 * the behaviour before any platform declares otherwise, and what SignalBase
 * and every unrecognized application continue to receive unchanged.
 */
export const DEFAULT_RESOLUTION_POLICY: ResolutionPolicy = {
  traversal: "flat-dom",
  shadowRoots: "ignore",
  eventRetargeting: false,
  identityPriority: ["accessibleName", "applicationIdentifier", "section"]
};
