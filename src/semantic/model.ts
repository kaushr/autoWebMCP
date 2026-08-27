/**
 * Canonical semantic input types. `date` is a logical calendar date carried
 * as `YYYY-MM-DD` — how a live application wants it *presented* (a locale
 * display string, a picker interaction) is the browser binding's and the
 * platform adapter's business, never part of the capability contract.
 */
export type CapabilityInputType = "string" | "date" | "number" | "boolean";

/**
 * The application a capability was demonstrated on. Deliberately just an
 * identity: the semantic model knows that capabilities come from somewhere,
 * never what any particular application can do.
 */
export interface SourceApplication {
  id: string;
  label: string;
}

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
 * generalized ontology. A semantic capability may be confirmed before an
 * existing application execution binding has been discovered and validated.
 */
export interface SemanticCapability {
  id: string;
  name: string;
  description: string;
  inputs: CapabilityInput[];
  outputs: CapabilityOutput[];
  /**
   * An observed or configured existing application execution path. Teach Mode
   * runs against arbitrary applications, so a capability may be confirmed
   * with no binding at all; discovering one is a separate step.
   */
  binding?: {
    application: string;
    action: string;
  };
  provenance: {
    source: ProvenanceSource;
    observationIds: string[];
    confirmedByHuman: boolean;
    /**
     * Where the capability was learned. It scopes which execution bindings may
     * be offered, and is absent when the evidence did not identify one.
     */
    sourceApplication?: SourceApplication;
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
