import { isInvestigable, type BindingCandidateProposal } from "../binding/model";
import { acceptedBinding, type BindingValidationRecord } from "../binding/validation";
import {
  acceptedBrowserBinding,
  type BrowserBindingCandidateRecord,
  type BrowserBindingValidationRecord,
  type BrowserExecutionBinding
} from "../binding/browserExecution/model";
import type { ExecutionOutcomeStatus } from "../binding/browserExecution/result";
import type { SemanticCapability } from "../semantic/model";
import type { BindingCandidateRecord } from "./bindingInference";

/**
 * The user-facing lifecycle, derived from the same state the app already
 * tracks.
 *
 * The Studio's internal model is deliberately precise — a capability, a
 * binding *candidate*, a validation *result*, an accepted execution *binding*
 * are four different things, and collapsing them is exactly the mistake the
 * architecture exists to prevent. But a person confirming a workflow does not
 * need four nouns; they need to know where they are in one line:
 *
 * ```text
 * Capability → Execution → Validation → Publication
 * ```
 *
 * This module derives that one line — and which actions are currently
 * meaningful — from the precise internal state, without changing what that
 * state means. It is pure and has no DOM dependency, so the lifecycle a human
 * sees can be tested directly against the state transitions that produce it.
 */

export type CapabilityStageStatus = "proposed" | "confirmed";

export type ExecutionStageStatus =
  /** Bound through the application's own advertised actions (e.g. SignalBase). */
  | "advertised"
  | "not-analyzed"
  | "candidate"
  | "no-safe-candidate"
  | "rejected";

export type ValidationStageStatus =
  /** Execution is via an advertised action; there is nothing to validate. */
  | "not-applicable"
  | "not-started"
  | "validated"
  | "failed"
  | "inconclusive"
  | "requires-setup";

export type PublicationStageStatus = "blocked" | "ready" | "published";

export interface CapabilityStageView {
  status: CapabilityStageStatus;
  label: string;
}

export interface ExecutionStageView {
  status: ExecutionStageStatus;
  label: string;
  family?: string;
  mechanism?: string;
  /** Show the "suggest an execution path" action. */
  canSuggest: boolean;
  /** Show "Validate this execution path" — investigation and validation as one step. */
  canValidate: boolean;
  /** Show "Reject this suggestion". */
  canReject: boolean;
}

export interface ValidationStageView {
  status: ValidationStageStatus;
  label: string;
  /** What remains before this could become an execution binding. */
  requirements: string[];
  /** Show "Accept execution binding". Only true when a binding was actually proven. */
  canAccept: boolean;
  accepted: boolean;
}

/**
 * The second execution strategy: driving the application's own browser UI
 * rather than calling a supported API. Kept as its own stage, never merged
 * into `ExecutionStageView` — a capability can have a candidate on one
 * strategy, a rejection on the other, and the two must stay legible
 * separately. See docs/BINDING_VALIDATION.md for why both are legitimate at
 * once.
 */
export type BrowserExecutionStageStatus =
  | "not-applicable"
  | "not-analyzed"
  | "proposed"
  | "no-safe-candidate"
  | "rejected";

export interface BrowserExecutionStageView {
  status: BrowserExecutionStageStatus;
  label: string;
  binding?: BrowserExecutionBinding;
  /** Show "Suggest browser execution". */
  canPropose: boolean;
  /** Show "Test browser execution". */
  canTest: boolean;
  /** Show "Reject this suggestion". */
  canReject: boolean;
}

export type BrowserValidationStageStatus = "not-applicable" | "not-started" | ExecutionOutcomeStatus;

export interface BrowserValidationStageView {
  status: BrowserValidationStageStatus;
  label: string;
  /** Show "Accept execution binding". Only true once a test has actually run to a usable outcome. */
  canAccept: boolean;
  accepted: boolean;
}

export interface PublicationStageView {
  status: PublicationStageStatus;
  label: string;
  /** Plain-language reason, present whenever status is "blocked". */
  reason?: string;
  canPublish: boolean;
}

export interface StudioLifecycleView {
  capability: CapabilityStageView;
  execution: ExecutionStageView;
  validation: ValidationStageView;
  browserExecution: BrowserExecutionStageView;
  browserValidation: BrowserValidationStageView;
  publication: PublicationStageView;
}

export interface StudioLifecycleInput {
  capability: SemanticCapability;
  /** Whether the taught application itself advertises a binding for this capability. */
  advertisedBound: boolean;
  bindingCandidate: BindingCandidateRecord | undefined;
  validation: BindingValidationRecord | undefined;
  /** The second execution strategy's candidate, independent of `bindingCandidate` above. */
  browserBindingCandidate?: BrowserBindingCandidateRecord;
  browserBindingValidation?: BrowserBindingValidationRecord;
  /** Whether this exact capability id is already in the control plane's publications. */
  published: boolean;
}

function executionStage(
  advertisedBound: boolean,
  bindingCandidate: BindingCandidateRecord | undefined
): ExecutionStageView {
  if (advertisedBound) {
    return {
      status: "advertised",
      label: "Execution already available",
      canSuggest: false,
      canValidate: false,
      canReject: false
    };
  }

  if (!bindingCandidate) {
    return { status: "not-analyzed", label: "Not analyzed yet", canSuggest: true, canValidate: false, canReject: false };
  }

  if (bindingCandidate.state === "rejected") {
    return { status: "rejected", label: "Suggestion rejected", canSuggest: true, canValidate: false, canReject: false };
  }

  const proposal: BindingCandidateProposal = bindingCandidate.proposal;
  if (!proposal.candidate) {
    return {
      status: "no-safe-candidate",
      label: "No safe execution path identified",
      canSuggest: true,
      canValidate: false,
      canReject: false
    };
  }

  const investigable = isInvestigable(proposal);
  return {
    status: "candidate",
    label: investigable ? "Execution path suggested" : "Observed mechanism is not eligible for validation",
    family: proposal.candidate.bindingFamily,
    mechanism: proposal.candidate.mechanism,
    canSuggest: true,
    canValidate: investigable,
    canReject: true
  };
}

function validationStage(
  advertisedBound: boolean,
  validation: BindingValidationRecord | undefined
): ValidationStageView {
  if (advertisedBound) {
    return { status: "not-applicable", label: "Not required for this execution path", requirements: [], canAccept: false, accepted: false };
  }
  if (!validation) {
    return { status: "not-started", label: "Not started", requirements: [], canAccept: false, accepted: false };
  }

  const result = validation.result;
  const label: Record<ValidationStageStatus, string> = {
    "not-applicable": "Not required for this execution path",
    "not-started": "Not started",
    validated: "Validated",
    failed: "Failed",
    inconclusive: "Inconclusive",
    "requires-setup": "Setup required"
  };

  return {
    status: result.status,
    label: label[result.status],
    requirements: result.requirements,
    canAccept: result.status === "validated" && Boolean(result.binding) && validation.state !== "accepted",
    accepted: validation.state === "accepted"
  };
}

function browserExecutionStage(
  advertisedBound: boolean,
  browserBindingCandidate: BrowserBindingCandidateRecord | undefined
): BrowserExecutionStageView {
  if (advertisedBound) {
    return { status: "not-applicable", label: "Not required for this application", canPropose: false, canTest: false, canReject: false };
  }
  if (!browserBindingCandidate) {
    return { status: "not-analyzed", label: "Not analyzed yet", canPropose: true, canTest: false, canReject: false };
  }
  if (browserBindingCandidate.state === "rejected") {
    return { status: "rejected", label: "Suggestion rejected", canPropose: true, canTest: false, canReject: false };
  }
  if (!browserBindingCandidate.proposal.binding) {
    return { status: "no-safe-candidate", label: "No safe browser execution path identified", canPropose: true, canTest: false, canReject: false };
  }
  return {
    status: "proposed",
    label: "Browser execution path suggested",
    binding: browserBindingCandidate.proposal.binding,
    canPropose: true,
    canTest: true,
    canReject: true
  };
}

const BROWSER_VALIDATION_LABEL: Record<ExecutionOutcomeStatus, string> = {
  succeeded: "Validated",
  partially_verified: "Save succeeded — value read-back unavailable",
  failed: "Failed",
  blocked: "Blocked before writing anything"
};

function browserValidationStage(
  advertisedBound: boolean,
  browserBindingValidation: BrowserBindingValidationRecord | undefined
): BrowserValidationStageView {
  if (advertisedBound) {
    return { status: "not-applicable", label: "Not required for this execution path", canAccept: false, accepted: false };
  }
  if (!browserBindingValidation) {
    return { status: "not-started", label: "Not started", canAccept: false, accepted: false };
  }

  const { result, state } = browserBindingValidation;
  // A binding is offerable for acceptance once it is at least proven safe to
  // use — `succeeded` or `partially_verified` (a save that genuinely
  // completed but could not be read back). `failed` and `blocked` never are.
  const usable = result.status === "succeeded" || result.status === "partially_verified";

  return {
    status: result.status,
    label: BROWSER_VALIDATION_LABEL[result.status],
    canAccept: usable && state !== "accepted",
    accepted: state === "accepted"
  };
}

function publicationStage(
  capability: SemanticCapability,
  bound: boolean,
  bindingCandidate: BindingCandidateRecord | undefined,
  validation: BindingValidationRecord | undefined,
  browserBindingCandidate: BrowserBindingCandidateRecord | undefined,
  browserBindingValidation: BrowserBindingValidationRecord | undefined,
  published: boolean
): PublicationStageView {
  const confirmed = capability.provenance.confirmedByHuman;

  if (!confirmed) {
    return { status: "blocked", label: "Blocked", reason: "Confirm the capability's meaning first.", canPublish: false };
  }

  if (bound) {
    return published
      ? { status: "published", label: "Published", canPublish: true }
      : { status: "ready", label: "Ready to publish", canPublish: true };
  }

  // Confirmed, but not bound: say precisely which step is outstanding rather
  // than a single generic "no binding" message. The browser-execution route
  // takes priority here when it is the one actually offering a next step —
  // most capabilities that land on `requires-setup` for the supported-API
  // route will never move past it, so leading with that discouraging
  // message while a validated browser binding sits ready to accept would
  // bury the real path forward.
  if (
    browserBindingValidation &&
    (browserBindingValidation.result.status === "succeeded" ||
      browserBindingValidation.result.status === "partially_verified") &&
    browserBindingValidation.state !== "accepted"
  ) {
    return {
      status: "blocked",
      label: "Blocked",
      reason: "A validated browser execution path is ready — accept it to publish.",
      canPublish: false
    };
  }

  let reason: string;
  if (!bindingCandidate) {
    reason =
      browserBindingCandidate?.proposal.binding && browserBindingCandidate.state !== "rejected"
        ? "A browser execution path has been suggested — test it to continue."
        : "No execution path has been identified yet. Suggest one to continue.";
  } else if (bindingCandidate.state === "rejected") {
    reason = "The suggested execution path was rejected.";
  } else if (!bindingCandidate.proposal.candidate) {
    reason = "No safe execution path was found from the available evidence.";
  } else if (!validation) {
    reason = "The suggested execution path has not been validated yet.";
  } else if (validation.result.status === "requires-setup") {
    reason = "Setup is required before this can become an agent-executable capability.";
  } else if (validation.result.status === "failed") {
    reason = "Validation failed, so no execution binding exists.";
  } else if (validation.result.status === "inconclusive") {
    reason = "Validation could not reach a conclusion.";
  } else if (validation.result.status === "validated" && validation.state !== "accepted") {
    reason = "A validated execution path is ready — accept it to publish.";
  } else {
    reason = "An execution binding is required before this capability can be published.";
  }

  return { status: "blocked", label: "Blocked", reason, canPublish: false };
}

/**
 * Derives the four-stage view a human reads from the precise state the app
 * already tracks. Reused by the normal Studio render and by tests; nothing
 * here mutates state or performs I/O.
 */
export function deriveStudioLifecycle(input: StudioLifecycleInput): StudioLifecycleView {
  const {
    capability,
    advertisedBound,
    bindingCandidate,
    validation,
    browserBindingCandidate,
    browserBindingValidation,
    published
  } = input;
  // Two independent routes to a binding, either sufficient on its own: a
  // supported application API the runtime can prove and accept, or a
  // semantic browser execution binding tested and accepted through the
  // application's own UI. Neither weakens the other's requirements.
  const bound =
    advertisedBound || Boolean(acceptedBinding(validation)) || Boolean(acceptedBrowserBinding(browserBindingValidation));

  return {
    capability: {
      status: capability.provenance.confirmedByHuman ? "confirmed" : "proposed",
      label: capability.provenance.confirmedByHuman ? "Confirmed" : "Proposed"
    },
    execution: executionStage(advertisedBound, bindingCandidate),
    validation: validationStage(advertisedBound, validation),
    browserExecution: browserExecutionStage(advertisedBound, browserBindingCandidate),
    browserValidation: browserValidationStage(advertisedBound, browserBindingValidation),
    publication: publicationStage(
      capability,
      bound,
      bindingCandidate,
      validation,
      browserBindingCandidate,
      browserBindingValidation,
      published
    )
  };
}
