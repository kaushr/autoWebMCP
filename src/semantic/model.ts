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

/**
 * What an input IS, which is not the same as what type it holds.
 *
 * `business` inputs were demonstrated: a human changed that control and the
 * capability exists because they did. `target-identity` was not — nobody
 * types a record id into an edit form. It is added because the platform and
 * the application say this operation acts on an existing entity and must
 * name which one.
 *
 * The distinction is load-bearing in three places: grounding must not try to
 * resolve an identity input to a form field, the published schema must
 * always require it, and a human confirming the contract has to be able to
 * see that it is a targeting parameter rather than something they taught.
 */
export type CapabilityInputRole =
  | "business"
  /** Selects WHICH entity the operation acts on. Contributed by the system. */
  | "target-identity"
  /**
   * A search term or filter typed into the application's own query UI.
   *
   * Not a field on any record. A live attempt to teach a search asked
   * "which Opportunity field is this?" of a global search box, and the only
   * answer the model allowed was an API name — so the honest answer was
   * unavailable and a false one was the only way forward. A query control
   * belongs to the application's navigation, and grounding must not look
   * for a record field behind it.
   */
  | "query";

export interface CapabilityInput {
  name: string;
  description: string;
  type: CapabilityInputType;
  required: boolean;
  enum?: string[];
  /** Absent means `business` — every input predating this distinction was one. */
  role?: CapabilityInputRole;
  /**
   * WHICH kind of entity a `target-identity` input selects, e.g. `Opportunity`.
   *
   * The parameter exists because an entity type was established; recording
   * which one is strictly more honest than inferring it back out of the
   * parameter's name later. `opportunity_id` → `Opportunity` happens to
   * invert cleanly, and `custom_object_id` does not — the `__c` suffix is
   * gone by then — so a contract that carries the answer is the only one
   * that can be relied on.
   *
   * Meaningless on any other role, and never set there.
   */
  entityType?: string;
}

/**
 * What an output IS, beyond the type of its value.
 *
 * `entity-identity` means the output carries the application's own stable
 * identity for entities of a named type — the thing an identity-gated tool
 * requires as its target. It is the producer half of the only relationship
 * this system derives between capabilities, and it is declared rather than
 * guessed at from a name.
 */
export type CapabilityOutputRole = "entity-identity";

export interface CapabilityOutput {
  name: string;
  description: string;
  type: "object" | "array" | "string" | "number" | "boolean";
  role?: CapabilityOutputRole;
  /** The entity type an `entity-identity` output identifies, e.g. `Opportunity`. */
  entityType?: string;
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
