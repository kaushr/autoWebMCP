import { assertSemanticCapability, type SemanticCapability } from "../semantic/model";
import type { NormalizedObservation } from "../capture/normalize";
import type { CapturePlatform } from "../capture/types";
import type { ObservationEvent } from "./events";

/** Evidence instrumented by the Prospect Intelligence application itself. */
export interface AppTraceRequest {
  traceKind?: "app";
  application: "prospect-intelligence";
  trace: readonly ObservationEvent[];
  uiLabels: string[];
}

/** Evidence captured by the browser extension on an arbitrary application. */
export interface ExtensionTraceRequest {
  traceKind: "extension";
  application: string;
  platform: CapturePlatform;
  trace: readonly NormalizedObservation[];
  uiLabels: string[];
}

export type SemanticizationRequest = AppTraceRequest | ExtensionTraceRequest;

export interface SemanticizationResponse {
  candidate: SemanticCapability;
  ambiguities: string[];
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
export async function semanticizeTrace(request: SemanticizationRequest): Promise<SemanticizationResponse> {
  const response = await fetch("/api/semanticize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`Semanticizer request failed (${response.status}).`);
  }
  return parseSemanticizationResponse(await response.json());
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
