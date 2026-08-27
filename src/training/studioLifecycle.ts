import { isInvestigable, type BindingCandidateProposal } from "../binding/model";
import { acceptedBinding, type BindingValidationRecord } from "../binding/validation";
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
  publication: PublicationStageView;
}

export interface StudioLifecycleInput {
  capability: SemanticCapability;
  /** Whether the taught application itself advertises a binding for this capability. */
  advertisedBound: boolean;
  bindingCandidate: BindingCandidateRecord | undefined;
  validation: BindingValidationRecord | undefined;
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

function publicationStage(
  capability: SemanticCapability,
  bound: boolean,
  bindingCandidate: BindingCandidateRecord | undefined,
  validation: BindingValidationRecord | undefined,
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
  // than a single generic "no binding" message.
  let reason: string;
  if (!bindingCandidate) {
    reason = "No execution path has been identified yet. Suggest one to continue.";
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
  const { capability, advertisedBound, bindingCandidate, validation, published } = input;
  const bound = advertisedBound || Boolean(acceptedBinding(validation));

  return {
    capability: {
      status: capability.provenance.confirmedByHuman ? "confirmed" : "proposed",
      label: capability.provenance.confirmedByHuman ? "Confirmed" : "Proposed"
    },
    execution: executionStage(advertisedBound, bindingCandidate),
    validation: validationStage(advertisedBound, validation),
    publication: publicationStage(capability, bound, bindingCandidate, validation, published)
  };
}
