export type CapabilityInputType = "string" | "number" | "boolean";

export type ProvenanceSource = "observed" | "configured" | "inferred" | "confirmed";

export interface CapabilityInput {
  name: string;
  description: string;
  type: CapabilityInputType;
  required: boolean;
  enum?: string[];
}

export interface CapabilityOutput {
  name: string;
  description: string;
  type: "object" | "array" | "string" | "number" | "boolean";
}

/**
 * This is intentionally a small hackathon contract, not a workflow graph or
 * generalized ontology. Bindings are deterministic application identifiers.
 */
export interface SemanticCapability {
  id: string;
  name: string;
  description: string;
  inputs: CapabilityInput[];
  outputs: CapabilityOutput[];
  binding: {
    application: "prospect-intelligence" | "salesforce";
    action: string;
  };
  provenance: {
    source: ProvenanceSource;
    observationIds: string[];
    confirmedByHuman: boolean;
  };
  safety: {
    readOnly: boolean;
    requiresConfirmation: boolean;
  };
}

export type CapabilityInputValue = string | number | boolean | undefined;
export type CapabilityInputValues = Record<string, CapabilityInputValue>;

export function assertSemanticCapability(value: SemanticCapability): SemanticCapability {
  if (!/^[a-z][a-z0-9_]*$/.test(value.id)) {
    throw new Error(`Capability id must be lower snake case: ${value.id}`);
  }

  const inputNames = new Set<string>();
  for (const input of value.inputs) {
    if (!/^[a-z][a-z0-9_]*$/.test(input.name)) {
      throw new Error(`Input name must be lower snake case: ${input.name}`);
    }
    if (inputNames.has(input.name)) {
      throw new Error(`Duplicate input name: ${input.name}`);
    }
    inputNames.add(input.name);
  }

  if (value.provenance.confirmedByHuman && value.provenance.source !== "confirmed") {
    throw new Error("Human-confirmed capabilities must have confirmed provenance.");
  }

  return value;
}
