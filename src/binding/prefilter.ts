import type { NetworkEffect, ExecutionEvidence } from "../capture/execution";
import type { NormalizedObservation } from "../capture/normalize";
import type { SemanticCapability } from "../semantic/model";
import { noSafeCandidate, type BindingCandidateProposal } from "./model";
import {
  capEligibility,
  defaultBindingPolicyProvider,
  type BindingPolicyProvider,
  type PolicyNotes,
  type TransportObservation
} from "./policy";

/** Enough nearby traffic to show what else was happening, never the storm. */
const NEARBY_SAMPLE_LIMIT = 5;

/** What the model is allowed to see. Deliberately small and pre-reasoned. */
export interface BindingCandidateInput {
  capability: {
    id: string;
    name: string;
    description: string;
    inputs: Array<{ name: string; required: boolean }>;
  };
  sourceApplication: SemanticCapability["provenance"]["sourceApplication"];
  causalCandidates: Array<{
    method: string;
    pathPattern: string;
    startedAfterMs: number;
    durationMs: number;
    status: number;
    action: string;
  }>;
  nearbySample: Array<{ method: string; pathPattern: string; startedAfterMs: number; status: number }>;
  observationSummary: string[];
  policy: PolicyNotes;
}

export type BindingPreparation =
  | { kind: "no-safe-candidate"; proposal: BindingCandidateProposal }
  | { kind: "infer"; input: BindingCandidateInput; policy: PolicyNotes };

function summarize(observations: readonly NormalizedObservation[]): string[] {
  return observations.slice(0, 12).map((observation) => {
    const label = observation.target ?? observation.field?.label ?? observation.action;
    const value =
      observation.oldValue !== undefined || observation.newValue !== undefined
        ? ` (${observation.oldValue ?? "∅"} → ${observation.newValue ?? "∅"})`
        : "";
    return `${observation.action}: ${label}${value}`;
  });
}

function strongestCandidate(
  evidence: readonly ExecutionEvidence[]
): { effect: NetworkEffect; action: string } | undefined {
  let best: { effect: NetworkEffect; action: string } | undefined;

  for (const group of evidence) {
    for (const requestId of group.causalCandidates ?? []) {
      const effect = group.networkEffects.find((candidate) => candidate.requestId === requestId);
      if (!effect) continue;
      // Earliest wins: the request that carries an action starts with it.
      if (!best || effect.startedAfterMs < best.effect.startedAfterMs) {
        best = { effect, action: group.actionLabel ?? group.action };
      }
    }
  }
  return best;
}

/**
 * The deterministic half of binding discovery.
 *
 * It decides what is even worth asking about, and it can answer on its own.
 * A session with no causal candidate has no mechanism to propose, and saying
 * so is a real result — feeding a request storm to a model and letting it pick
 * something plausible is how you invent a binding.
 */
export function prepareBindingInference(
  capability: SemanticCapability,
  evidence: readonly ExecutionEvidence[],
  observations: readonly NormalizedObservation[],
  provider: BindingPolicyProvider = defaultBindingPolicyProvider
): BindingPreparation {
  const source = capability.provenance.sourceApplication;
  if (!source) {
    return {
      kind: "no-safe-candidate",
      proposal: noSafeCandidate(capability.id, { id: "unknown", label: "Unknown application" },
        "The capability does not record which application it was learned from.")
    };
  }

  const best = strongestCandidate(evidence);
  if (!best) {
    return {
      kind: "no-safe-candidate",
      proposal: {
        ...noSafeCandidate(
          capability.id,
          source,
          "No request qualified as a causal candidate, so no execution mechanism was observed."
        ),
        validationRequired: provider.notesFor(source, undefined).validationRequired
      }
    };
  }

  const transport: TransportObservation = {
    method: best.effect.method,
    pathPattern: best.effect.pathPattern,
    origin: best.effect.origin,
    status: best.effect.status
  };
  const policy = provider.notesFor(source, transport);

  const nearby = evidence
    .flatMap((group) => group.networkEffects)
    .filter((effect) => effect.role !== "causal-candidate" && !effect.backgroundLikely)
    .slice(0, NEARBY_SAMPLE_LIMIT)
    .map((effect) => ({
      method: effect.method,
      pathPattern: effect.pathPattern,
      startedAfterMs: effect.startedAfterMs,
      status: effect.status
    }));

  return {
    kind: "infer",
    policy,
    input: {
      capability: {
        id: capability.id,
        name: capability.name,
        description: capability.description,
        inputs: capability.inputs.map((entry) => ({ name: entry.name, required: entry.required }))
      },
      sourceApplication: source,
      causalCandidates: [
        {
          method: best.effect.method,
          pathPattern: best.effect.pathPattern,
          startedAfterMs: best.effect.startedAfterMs,
          durationMs: best.effect.durationMs,
          status: best.effect.status,
          action: best.action
        }
      ],
      nearbySample: nearby,
      observationSummary: summarize(observations),
      policy
    }
  };
}

/**
 * The deterministic half again, after the model has answered.
 *
 * Policy is a ceiling the model cannot raise, replay is forced off whatever it
 * said, and the platform's warnings and validation steps are merged in rather
 * than left to the model's discretion.
 */
export function applyPolicyCeiling(
  proposal: BindingCandidateProposal,
  policy: PolicyNotes
): BindingCandidateProposal {
  const merged = (from: string[], extra: string[]): string[] => [...new Set([...from, ...extra])];

  return {
    ...proposal,
    eligibility: capEligibility(proposal.eligibility, policy.maximumEligibility),
    candidate: proposal.candidate ? { ...proposal.candidate, directReplayAllowed: false } : null,
    warnings: merged(proposal.warnings, policy.warnings),
    validationRequired: merged(proposal.validationRequired, policy.validationRequired)
  };
}
