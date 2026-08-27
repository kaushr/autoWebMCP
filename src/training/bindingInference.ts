import type { NormalizedObservation, ObservationTrace } from "../capture/normalize";
import type { SemanticCapability } from "../semantic/model";
import type { BindingCandidateProposal, BindingCandidateState } from "../binding/model";
import { applyPolicyCeiling, prepareBindingInference } from "../binding/prefilter";
import type { SemanticizerDiagnostics } from "./semanticizer";

/** Same diagnostic envelope as semantic inference; a separate run history. */
export interface BindingInferenceRun {
  runId: string;
  traceSessionId: string;
  capabilityId: string;
  diagnostics: SemanticizerDiagnostics;
  rawResponse: string;
  proposal?: BindingCandidateProposal;
  parseError?: string;
}

export interface BindingCandidateRecord {
  state: BindingCandidateState;
  proposal: BindingCandidateProposal;
}

function parseProposal(
  raw: unknown,
  capability: SemanticCapability,
  sourceApplication: NonNullable<SemanticCapability["provenance"]["sourceApplication"]>
): BindingCandidateProposal {
  if (typeof raw !== "object" || raw === null) throw new Error("Binding response is not an object.");
  const body = raw as Partial<BindingCandidateProposal>;

  if (!body.eligibility) throw new Error("Binding response is missing an eligibility.");
  if (!body.confidence) throw new Error("Binding response is missing a confidence.");
  for (const key of ["evidence", "warnings", "validationRequired"] as const) {
    if (!Array.isArray(body[key])) throw new Error(`Binding response ${key} must be an array.`);
  }

  return {
    capabilityId: capability.id,
    sourceApplication,
    candidate: body.candidate
      ? {
          bindingFamily: String(body.candidate.bindingFamily ?? ""),
          mechanism: String(body.candidate.mechanism ?? ""),
          observedTransport: body.candidate.observedTransport ?? null,
          directReplayAllowed: false
        }
      : null,
    confidence: body.confidence,
    eligibility: body.eligibility,
    evidence: body.evidence ?? [],
    warnings: body.warnings ?? [],
    validationRequired: body.validationRequired ?? []
  };
}

/**
 * Deterministic preparation, then the model, then deterministic validation.
 *
 * The middle step is the only one that reasons freely, and it is bracketed:
 * it sees a pre-filtered handful of evidence rather than a request storm, and
 * whatever it returns is capped by platform policy before anyone sees it.
 */
export async function inferBindingCandidate(
  capability: SemanticCapability,
  trace: ObservationTrace,
  observations: readonly NormalizedObservation[]
): Promise<{ run?: BindingInferenceRun; proposal: BindingCandidateProposal }> {
  const prepared = prepareBindingInference(capability, trace.executionEvidence ?? [], observations);

  // No mechanism was observed, so there is nothing to ask about. Answering
  // this without a model is the point: an absent candidate is a real result.
  if (prepared.kind === "no-safe-candidate") return { proposal: prepared.proposal };

  const response = await fetch("/api/binding-candidate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(prepared.input)
  });
  if (!response.ok) throw new Error(`Binding inference failed (${response.status}).`);

  const body = (await response.json()) as { raw?: unknown; diagnostics?: SemanticizerDiagnostics };
  if (typeof body.raw !== "string" || !body.diagnostics) {
    throw new Error("Binding inference response is missing its raw output or diagnostics.");
  }

  const source = capability.provenance.sourceApplication!;
  const run: BindingInferenceRun = {
    runId: body.diagnostics.runId,
    traceSessionId: trace.sessionId,
    capabilityId: capability.id,
    diagnostics: body.diagnostics,
    rawResponse: body.raw
  };

  try {
    run.proposal = applyPolicyCeiling(parseProposal(JSON.parse(body.raw), capability, source), prepared.policy);
  } catch (error) {
    run.parseError = error instanceof Error ? error.message : String(error);
    return {
      run,
      proposal: applyPolicyCeiling(
        {
          capabilityId: capability.id,
          sourceApplication: source,
          candidate: null,
          confidence: "low",
          eligibility: "no-safe-candidate",
          evidence: [],
          warnings: ["The model's binding proposal could not be read."],
          validationRequired: []
        },
        prepared.policy
      )
    };
  }

  return { run, proposal: run.proposal };
}

export interface ControlPlaneReset {
  cleared: boolean;
  traces: number;
  publications: number;
}

export async function resetControlPlane(): Promise<ControlPlaneReset> {
  const response = await fetch("/api/debug/reset", { method: "POST" });
  if (!response.ok) throw new Error(`Reset failed (${response.status}).`);
  return (await response.json()) as ControlPlaneReset;
}
