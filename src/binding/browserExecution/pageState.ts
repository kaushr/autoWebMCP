/* ------------------------------------------------------------------ *
 * Page state — the generic shapes for "is this page in the state the
 * binding expects", and the policy a platform declares about how that
 * question is answered.
 *
 * This exists because a live Salesforce run proved that "a visible dialog
 * exists" is not a page state. A Lightning record page legitimately carries
 * visible dialog-role surfaces (docked utility bar, panels, path assistant)
 * while sitting in plain read-only view, and treating any of them as "the
 * record is being edited" skipped the Edit click entirely and sent
 * resolution hunting for a field on a page that never had it.
 *
 * The generic engine knows only these shapes: a page is `record-edit`,
 * `record-view`, or `unknown`, and entering edit mode is a *transition
 * with a postcondition*, not a click. What evidence establishes
 * `record-edit` on a given platform is platform knowledge — declared in
 * its Platform Intelligence pack, compiled into a `PageStatePolicy` at the
 * composition root, applied mechanically by that platform's adapter.
 * Nothing here consults a model; state assessment is deterministic.
 * ------------------------------------------------------------------ */

export type PageState = "record-edit" | "record-view" | "unknown";

/** What a state assessment actually saw, kept so a wrong answer is arguable. */
export interface PageStateEvidence {
  /** Editable record fields found inside the qualifying (or best) surface. */
  editableFieldCount: number;
  commitActionFound: boolean;
  dismissActionFound: boolean;
  /** Platform edit-component evidence found, by tag name, if any. */
  editComponentEvidence: string[];
  /** Visible dialog-like surfaces that did NOT qualify as an edit surface. */
  unrelatedDialogsIgnored: number;
}

export interface PageStateAssessment {
  state: PageState;
  /** The qualifying edit surface, when state is `record-edit`. */
  surface?: Element;
  evidence: PageStateEvidence;
}

/**
 * The outcome of ensuring an editable state — a proven transition, not a
 * hopeful click. `ok: true` asserts the postcondition: the page is now in
 * `record-edit` as the platform defines it.
 */
export interface EditableTransition {
  ok: boolean;
  initialState: PageState;
  finalState: PageState;
  editActionResolved: boolean;
  editActionInvoked: boolean;
  /** Human-readable trail: states, evidence, and what was attempted. */
  diagnostics: string[];
}

/**
 * How a platform's record-edit state is recognized. Compiled from Platform
 * Intelligence at the composition root; deliberately declarative — element
 * identities and thresholds, never DOM operations.
 */
export interface PageStatePolicy {
  /**
   * Element tag names that themselves signify a record-edit surface on this
   * platform (a component identity is a documented platform fact, not a
   * recorded selector chain).
   */
  editSurfaceComponents: string[];
  /**
   * A dialog-like surface qualifies structurally only with at least this
   * many editable fields inside it AND a commit action. One lone input
   * with a button is a search box or a note composer, not a record form.
   */
  minimumEditableFields: number;
  /** Accessible labels that count as the surface's commit action, lowercase. */
  commitActionLabels: string[];
  /** Accessible labels that count as its dismiss action, lowercase. */
  dismissActionLabels: string[];
}

/**
 * The conservative default when a platform declares nothing: structural
 * evidence only, two-field minimum, Save/Cancel wording. A platform with
 * different semantics declares its own in its pack.
 */
export const DEFAULT_PAGE_STATE_POLICY: PageStatePolicy = {
  editSurfaceComponents: [],
  minimumEditableFields: 2,
  commitActionLabels: ["save"],
  dismissActionLabels: ["cancel"]
};
