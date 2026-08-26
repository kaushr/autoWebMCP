import type { SafeInteraction } from "./types";

export type ObservationProvenance = "OBSERVED" | "INFERRED" | "HUMAN_CONFIRMED" | "CONFIGURED";

export interface SemanticObservation {
  kind: "field_change" | "save" | "application_reaction";
  timestamp: number;
  field?: { label?: string; context?: string };
  effects?: string[];
  provenance: ObservationProvenance;
  sourceInteractionIds: string[];
}

/**
 * First normalizer slice: reduce safe capture metadata to a compact evidence
 * trace. Values and raw rrweb events intentionally do not cross this boundary.
 */
export function normalizeInteractions(interactions: SafeInteraction[]): SemanticObservation[] {
  const observations: SemanticObservation[] = [];
  for (const interaction of interactions) {
    if (interaction.kind === "field_change") {
      observations.push({
        kind: "field_change",
        timestamp: interaction.timestamp,
        field: { label: interaction.element?.label, context: interaction.element?.role },
        provenance: "OBSERVED",
        sourceInteractionIds: [interaction.id]
      });
      continue;
    }

    if (interaction.kind === "click" && /save/i.test(interaction.element?.label ?? "")) {
      observations.push({
        kind: "save",
        timestamp: interaction.timestamp,
        provenance: "OBSERVED",
        sourceInteractionIds: [interaction.id]
      });
    }
  }
  return observations;
}
