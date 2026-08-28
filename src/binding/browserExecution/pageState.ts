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

/**
 * One independently-provenanced way a platform's record-edit state can be
 * established. Multiple patterns may exist for the same platform, each
 * with its own strength: a documented component identity is not the only
 * way to recognize an edit surface, and a structural pattern inferred from
 * one live observation is not the same *kind* of knowledge as a vendor's
 * own component name, even when both currently point at `record-edit`.
 * Collapsing them into one flat rule was the mistake — see
 * `sf-record-edit-structural-semantics` in the Salesforce pack for the
 * live case that forced this apart.
 */
export interface EditSurfacePattern {
  id: string;
  strength: string;
  evidence:
    | { kind: "component-identity"; componentIdentities: string[] }
    | { kind: "structural"; minimumEditableFields: number };
}

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
  /** How many candidate surfaces were observed in total, qualifying or not. */
  surfacesObserved: number;
  /** Which pattern, if any, established `record-edit` — its id and epistemic strength. */
  matchedPattern?: { id: string; strength: string };
  /** Other observed candidates that did not qualify, kept for diagnosis — an unrelated error banner included, never silently dropped. */
  otherSurfaces?: Array<{ heading?: string; roles: string[]; editableFieldCount: number }>;
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
 *
 * `patterns` replaces what used to be a single flat component-tag list plus
 * a single field-count threshold. Multiple independently-provenanced ways
 * to recognize record-edit can coexist — a documented component identity
 * and a structural pattern are different *kinds* of evidence and may carry
 * different strength, and a platform is not limited to declaring one of
 * each. `commitActionLabels`/`dismissActionLabels` stay flat and shared:
 * they name what "Save" and "Cancel" look like on this platform, used both
 * by the structural pattern and independently, to find and click those
 * actions during restoration and validation — that vocabulary does not
 * vary per recognition pattern.
 */
export interface PageStatePolicy {
  patterns: EditSurfacePattern[];
  /** Accessible labels that count as a commit action, lowercase. */
  commitActionLabels: string[];
  /** Accessible labels that count as a dismiss action, lowercase. */
  dismissActionLabels: string[];
}

/**
 * The conservative default when a platform declares nothing: one
 * structural pattern, two-field minimum, Save/Cancel wording. A platform
 * with different semantics declares its own in its pack.
 */
export const DEFAULT_PAGE_STATE_POLICY: PageStatePolicy = {
  patterns: [
    {
      id: "generic-structural",
      strength: "documented-policy",
      evidence: { kind: "structural", minimumEditableFields: 2 }
    }
  ],
  commitActionLabels: ["save"],
  dismissActionLabels: ["cancel"]
};

/**
 * Undoing a page-state transition AutoWebMCP itself caused.
 *
 * The counterpart to `EditableTransition`: that type records that we
 * entered edit mode, this one records putting the page back. Ownership is
 * why both exist — a read-only operation compensates only for state it
 * introduced, and a record the user was already editing is not ours to
 * cancel.
 */
export interface EditRestoration {
  /** Proven: the page is back in the state we found it in. */
  ok: boolean;
  dismissActionResolved: boolean;
  dismissActionInvoked: boolean;
  finalState: PageState;
  diagnostics: string[];
}
