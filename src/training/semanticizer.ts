import { assertSemanticCapability, type SemanticCapability } from "../semantic/model";
import type { ObservationEvent } from "./events";

export interface SemanticizationRequest {
  application: "prospect-intelligence";
  trace: readonly ObservationEvent[];
  uiLabels: string[];
}

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
  assertSemanticCapability(response.candidate);
  return { candidate: response.candidate, ambiguities: response.ambiguities };
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
