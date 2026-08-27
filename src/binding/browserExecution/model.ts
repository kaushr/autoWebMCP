import type { EpistemicNeed } from "../../applicationIntelligence/model";
import type { SourceApplication } from "../../semantic/model";
import type { ExecutionResult } from "./result";

/* ------------------------------------------------------------------ *
 * Semantic browser execution binding.
 *
 * A second strategy alongside the supported-API route in
 * `binding/validation.ts`, not a replacement for it. Some capabilities have
 * a supported application interface the runtime cannot yet reach (Salesforce
 * UI API today); this describes the other honest option — driving the same
 * workflow through the application's own browser UI, the way the human who
 * taught it did.
 *
 * Declarative, not a replay script. Every target below is a semantic
 * description — a visible label, a role, the application's own field
 * identifier — that a runtime re-resolves against the LIVE DOM at execution
 * time. Nothing here is a screen coordinate, a recorded click position, a CSS
 * selector chain, an XPath, or a DOM node id: none of those survive a
 * re-render, and storing one would make this a macro wearing a schema's
 * clothes. See `engine.ts` for the runtime that re-resolves these.
 * ------------------------------------------------------------------ */

export type SemanticRole =
  | "field"
  | "button"
  | "link"
  | "combobox"
  | "checkbox"
  | "radio"
  | "region";

/**
 * How a control is found on the live page. Every field here is something a
 * human (or a screen reader) could also use to find it — never anything
 * positional or structural to one rendered instance of the DOM.
 */
export interface SemanticTarget {
  role: SemanticRole;
  /** Visible label or accessible name, as a human would read it. */
  label: string;
  /** The application's own field/control identifier, when the capture observed one. */
  applicationIdentifier?: string;
  /** Nearest enclosing section/card/fieldset heading, for disambiguation. */
  section?: string;
}

export type FieldValueKind = "text" | "date" | "select" | "checkbox" | "number";

/**
 * What the application itself says this input is, resolved at proposal
 * time and written down here.
 *
 * MATERIALIZED APPLICATION INTELLIGENCE — a cached answer, not a fact this
 * binding owns. The binding is a way of reaching a control; what that
 * control accepts belongs to the application, and for a picklist the legal
 * set can narrow by record type, by a controlling field's current value,
 * and by the running user's permissions. Materializing it keeps V0.1
 * simple and is safe because the application stays authoritative: an
 * option that is no longer legal is rejected by the app at save time, and
 * verification catches it.
 *
 * The long-term shape is `application intelligence + runtime context →
 * resolved execution contract → binding`, which is why the provenance
 * below travels with the value: a consumer can always tell how current a
 * materialized domain is, and where it came from.
 */
export interface BoundApplicationField {
  /** e.g. `Opportunity`. */
  objectApiName?: string;
  /** The application's own field identity, e.g. `StageName`. */
  apiName: string;
  /** The application's declared type, e.g. `picklist`. */
  type: string;
  /** The value domain as known when this binding was proposed. Absent means unknown, never unrestricted. */
  options?: string[];
  /** Which knowledge layer supplied the options, when there are any. */
  optionsSource?: "tenant" | "standard" | "human-confirmed" | "observation-only";
  /** Which knowledge layer identified the field. */
  knowledge: "tenant" | "standard" | "human-confirmed" | "observation-only";
  /** The standard release consulted, when standard knowledge identified it. */
  release?: string;
}

/** One capability input, and where it lands on the application's own UI. */
export interface BrowserBindingInput {
  /** The capability's own input name, e.g. `close_date`. */
  semanticInput: string;
  semanticTarget: SemanticTarget;
  valueKind: FieldValueKind;
  applicationField?: BoundApplicationField;
}

export type PageMode = "record-view" | "edit-form" | "edit-or-record";

export interface BrowserBindingContext {
  /** Object/record type the capability acts on, when the evidence named one. */
  recordType?: string;
  /**
   * What the runtime should ensure before resolving input targets.
   * `edit-or-record` means: enter edit mode first if the page is not already
   * showing an editable form for this record.
   */
  pageMode: PageMode;
}

export interface BrowserBindingCommit {
  semanticAction: SemanticTarget;
}

export type VerificationCheck =
  | "edit-state-closed"
  | "returned-to-record-view"
  | "field-value-observable"
  | "no-validation-error-visible";

/**
 * Literal `true`, the same defensive pattern `binding/model.ts` uses for
 * `directReplayAllowed`. A binding that claimed otherwise would need to
 * change its type, not just a value, making the claim a deliberate act.
 */
export interface BrowserBindingSafety {
  noCoordinates: true;
  noXPath: true;
  noPrivateTransportReplay: true;
  noCredentialExtraction: true;
}

export const BROWSER_BINDING_SAFETY: BrowserBindingSafety = {
  noCoordinates: true,
  noXPath: true,
  noPrivateTransportReplay: true,
  noCredentialExtraction: true
};

/**
 * A declarative browser execution binding: HOW a confirmed capability can be
 * performed through the application's own browser UI. It describes a
 * mechanism, never a script — safe to serialize, inspect in Studio, and
 * export, because nothing in it is executable on its own without a live DOM
 * and a runtime that re-resolves every target fresh.
 */
export interface BrowserExecutionBinding {
  id: string;
  capabilityId: string;
  sourceApplication: SourceApplication;
  /** Which resolver adapter applies, e.g. "salesforce-lightning". */
  platform: string;
  context: BrowserBindingContext;
  inputs: BrowserBindingInput[];
  commit: BrowserBindingCommit;
  verification: VerificationCheck[];
  safety: BrowserBindingSafety;
  /** Why this binding was proposed, in plain observational language. */
  evidence: string[];
}

/** Where a human has taken a proposed browser binding. V0.1 stops at `rejected`/`accepted`. */
export type BrowserBindingCandidateState = "proposed" | "tested" | "accepted" | "rejected";

export interface BrowserBindingProposal {
  binding: BrowserExecutionBinding | null;
  /** Plain-language reasons no binding could be proposed, when `binding` is null. */
  warnings: string[];
  /**
   * Specific facts the system knows it is missing.
   *
   * A proposal with a blocking need is not a failure — it is a question,
   * and answering it lets the same deterministic proposal run again. Needs
   * marked non-blocking accompany a perfectly usable binding and simply
   * record a gap, such as a picklist whose value domain is unknown.
   */
  needs?: EpistemicNeed[];
}

export interface BrowserBindingCandidateRecord {
  state: BrowserBindingCandidateState;
  proposal: BrowserBindingProposal;
}

/**
 * A tested browser binding's lifecycle, deliberately shaped like
 * `BindingValidationRecord` in `binding/validation.ts`: proof and approval
 * are different judgements there, and they stay different here. Testing
 * (running `executeConfirmed` once) produces a `result`; only a human
 * accepting it — never a passing test alone — unlocks publication.
 */
export type BrowserBindingTestState = "none" | "tested" | "accepted" | "rejected";

export interface BrowserBindingValidationRecord {
  state: BrowserBindingTestState;
  binding: BrowserExecutionBinding;
  result: ExecutionResult;
}

/** The gate publication reads, mirroring `acceptedBinding` in `binding/validation.ts`. */
export function acceptedBrowserBinding(
  record: BrowserBindingValidationRecord | undefined
): BrowserExecutionBinding | undefined {
  if (!record || record.state !== "accepted") return undefined;
  return record.binding;
}
