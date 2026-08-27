import type { SourceApplication } from "../semantic/model";

/* ------------------------------------------------------------------ *
 * Three concepts, deliberately never merged:
 *
 *   EXECUTION EVIDENCE   what the application appeared to do
 *   BINDING CANDIDATE    a proposed mechanism worth investigating   ← here
 *   EXECUTION BINDING    a validated mechanism we may publish
 *
 * A candidate is a research lead. It is not a binding, it grants no
 * permission to call anything, and publication still requires a validated
 * binding a human selected.
 * ------------------------------------------------------------------ */

export type BindingEligibility =
  | "supported-candidate"
  | "needs-validation"
  | "private-observed-transport"
  | "unsafe-to-replay"
  | "unresolved"
  | "no-safe-candidate";

/** Where a human has taken the proposal. V0.1 stops at `proposed`. */
export type BindingCandidateState = "none" | "proposed" | "accepted-for-validation" | "rejected";

export type BindingConfidence = "high" | "medium" | "low";

export interface ProposedMechanism {
  /** A family of supported mechanisms, never a specific call. */
  bindingFamily: string;
  mechanism: string;
  /** The transport that was seen, for provenance. Never an instruction. */
  observedTransport: string | null;
  /**
   * Always false. Observing a transport is not permission to drive it, and
   * V0.1 produces no executable anything — the literal type makes a future
   * change to that a deliberate act rather than an accident.
   */
  directReplayAllowed: false;
}

export interface BindingCandidateProposal {
  capabilityId: string;
  sourceApplication: SourceApplication;
  /** Null when no mechanism could honestly be proposed. */
  candidate: ProposedMechanism | null;
  confidence: BindingConfidence;
  eligibility: BindingEligibility;
  /** Why this was proposed, in plain observational language. */
  evidence: string[];
  warnings: string[];
  validationRequired: string[];
}

/** Eligibility states that mean "nothing here may be used yet". */
const UNUSABLE: ReadonlySet<BindingEligibility> = new Set<BindingEligibility>([
  "no-safe-candidate",
  "unresolved",
  "unsafe-to-replay",
  "private-observed-transport"
]);

/**
 * Whether a proposal is even a lead worth a human's time. Nothing in the
 * codebase treats `true` here as permission to bind: publication continues to
 * require a validated binding chosen from what the application advertises.
 */
export function isInvestigable(proposal: BindingCandidateProposal): boolean {
  return proposal.candidate !== null && !UNUSABLE.has(proposal.eligibility);
}

export function noSafeCandidate(
  capabilityId: string,
  sourceApplication: SourceApplication,
  reason: string
): BindingCandidateProposal {
  return {
    capabilityId,
    sourceApplication,
    candidate: null,
    confidence: "low",
    eligibility: "no-safe-candidate",
    evidence: [],
    warnings: [reason],
    validationRequired: []
  };
}
