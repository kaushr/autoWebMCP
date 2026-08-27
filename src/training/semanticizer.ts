import { assertSemanticCapability, type SemanticCapability } from "../semantic/model";
import type { NormalizedObservation } from "../capture/normalize";
import type { CapturePlatform } from "../capture/types";

/** Evidence captured by the browser extension on an arbitrary application. */
export interface SemanticizationRequest {
  traceKind: "extension";
  /** Correlates the run back to the trace it was proposed from. */
  traceSessionId: string;
  application: string;
  platform: CapturePlatform;
  trace: readonly NormalizedObservation[];
  uiLabels: string[];
}

export interface SemanticizationResponse {
  candidate: SemanticCapability;
  ambiguities: string[];
}

/**
 * What was actually asked of the model. Admin-safe by construction: static
 * instruction text, the sanitized evidence that was sent, and the parameters
 * that materially change behaviour. No credential is ever in scope here.
 */
export interface SemanticizerDiagnostics {
  runId: string;
  requestedAt: string;
  latencyMs: number;
  model: string;
  promptVersion: string;
  instructions: string[];
  /** The exact serialized input handed to the model. */
  input: string;
  parameters: Record<string, string | number | boolean>;
  providerResponseId?: string;
}

/**
 * One semanticizer invocation, kept whole.
 *
 * The raw response is stored before parsing precisely so that a model that
 * answered badly and a parser that rejected a good answer look different. A run
 * with `parseError` set is a record of a failure, not an absence of one.
 */
export interface SemanticizerRun {
  runId: string;
  traceSessionId: string;
  diagnostics: SemanticizerDiagnostics;
  /** Provider-visible response text, before any application parsing. */
  rawResponse: string;
  candidate?: SemanticCapability;
  ambiguities: string[];
  parseError?: string;
}

export function parseSemanticizationResponse(value: unknown): SemanticizationResponse {
  if (typeof value !== "object" || value === null || !("candidate" in value) || !("ambiguities" in value)) {
    throw new Error("Semanticizer response is not a candidate capability object.");
  }

  const response = value as { candidate: SemanticCapability; ambiguities: unknown };
  if (!Array.isArray(response.ambiguities) || !response.ambiguities.every((item) => typeof item === "string")) {
    throw new Error("Semanticizer ambiguities must be strings.");
  }

  // A capability taught on an arbitrary application may have no execution
  // binding yet; the model reports that as an explicit null.
  const candidate: SemanticCapability = { ...response.candidate };
  if (!candidate.binding) delete candidate.binding;
  assertSemanticCapability(candidate);
  return { candidate, ambiguities: response.ambiguities };
}

/** Calls a same-origin server endpoint; the browser never receives the API key. */
export async function semanticizeTrace(request: SemanticizationRequest): Promise<SemanticizerRun> {
  const response = await fetch("/api/semanticize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`Semanticizer request failed (${response.status}).`);
  }

  const body = (await response.json()) as { raw?: unknown; diagnostics?: SemanticizerDiagnostics };
  if (typeof body.raw !== "string" || !body.diagnostics) {
    throw new Error("Semanticizer response is missing its raw output or diagnostics.");
  }

  const run: SemanticizerRun = {
    runId: body.diagnostics.runId,
    traceSessionId: request.traceSessionId,
    diagnostics: body.diagnostics,
    rawResponse: body.raw,
    ambiguities: []
  };

  // Parsing is recorded, not assumed. A model answer that cannot be read is
  // still a run worth inspecting.
  try {
    const parsed = parseSemanticizationResponse(JSON.parse(body.raw));
    run.candidate = parsed.candidate;
    run.ambiguities = parsed.ambiguities;
  } catch (error) {
    run.parseError = error instanceof Error ? error.message : String(error);
  }
  return run;
}

export function confirmCandidate(candidate: SemanticCapability): SemanticCapability {
  return {
    ...candidate,
    provenance: {
      ...candidate.provenance,
      source: "confirmed",
      confirmedByHuman: true
    }
  };
}
