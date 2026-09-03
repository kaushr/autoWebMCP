import type { SemanticCapability } from "./model";

/* ------------------------------------------------------------------ *
 * How separate capabilities fit together, derived rather than asked.
 *
 * The problem is real and narrow. `update_opportunity` requires
 * `opportunity_id`. An agent that has a company name and no id has no way,
 * from that tool alone, to learn that another published tool hands out
 * exactly those ids. WebMCP has no field for "call A before B", so the
 * only place this can be said is the metadata an agent already reads.
 *
 * The temptation is to ask a model which tools sound related. That would
 * be inference layered on inference, and it would be wrong exactly when it
 * mattered — two tools about Opportunities that do not actually exchange
 * an identity read as related, and a correct pairing across differently
 * named entities does not. The relationship here is STRUCTURAL and is read
 * off the contracts:
 *
 *   PRODUCER   an output declaring role `entity-identity` for entity E
 *   CONSUMER   an input declaring role `target-identity` for entity E
 *   RELATION   the same E
 *
 * Nothing here knows a tool name, a vendor, or an entity type. The same
 * derivation that pairs a search of Opportunities with an update of one
 * would pair a search of Accounts with anything requiring an Account.
 *
 * Two things it deliberately is not. It is not a workflow graph: there is
 * no ordering, no transitive closure, and no plan — only "if you lack this,
 * that tool hands out candidates". And it is not a selection: a search may
 * return several candidates, so every sentence produced here keeps the
 * choosing with the caller. "Use search and then update it" would promise a
 * uniqueness the search does not have.
 * ------------------------------------------------------------------ */

/** A capability that hands back identities of some entity type. */
export interface IdentityProducer {
  capabilityId: string;
  entityType: string;
  /** The output carrying them, e.g. `candidates`. */
  outputName: string;
  /** Whether it writes nothing — worth saying when suggesting a caller run it first. */
  readOnly: boolean;
}

/** A parameter that must be given an identity of some entity type. */
export interface IdentityRequirement {
  inputName: string;
  entityType: string;
}

/**
 * The sentences to append to an agent-facing contract, given what else is
 * published alongside it.
 *
 * Empty is the normal answer and the correct one whenever the peer that
 * would justify a hint is not actually there. A hint about a tool an agent
 * cannot call is worse than no hint at all.
 */
export interface CompositionHints {
  /** Appended to the tool's own description. */
  tool: string[];
  /** Appended to a specific input's description, keyed by input name. */
  inputs: Record<string, string>;
}

export const NO_COMPOSITION_HINTS: CompositionHints = { tool: [], inputs: {} };

/**
 * Declares, in the contract itself, that this capability hands back entity
 * identities — and of what type.
 *
 * The description already says as much in prose, because a human confirming
 * the contract reads prose. This is the same fact in a form another
 * capability's contract can be matched against, which is what makes the
 * producer/consumer relationship derivable without either tool being named
 * anywhere or a model being asked which tools "sound related".
 *
 * The shape is the one `browserExecution/query.ts` actually returns —
 * `QueryOutcome.candidates`, each an `EntityCandidate` carrying `id` and
 * `name` — so the description describes the payload rather than an
 * idealized one. Returns the SAME object when the declaration is already
 * there, so re-grounding neither duplicates nor churns it.
 */
export function withEntityIdentityOutput(capability: SemanticCapability, entityType: string | undefined): SemanticCapability {
  if (capability.outputs.some((output) => output.role === "entity-identity")) return capability;
  const kind = entityType ? `${entityType} ` : "";
  return {
    ...capability,
    outputs: [
      ...capability.outputs,
      {
        name: "candidates",
        description:
          `Matching ${kind}records, each carrying \`id\` — the application's own stable identity for it — and ` +
          "`name`, the label the application shows. The list may be empty and may hold several entries; nothing " +
          "here chooses between them.",
        type: "array",
        role: "entity-identity",
        ...(entityType ? { entityType } : {})
      }
    ]
  };
}

/**
 * Records WHICH entity a targeting parameter selects, when the contract
 * did not already say.
 *
 * Needed because contracts confirmed before this declaration existed are
 * already published and already running. Their accepted execution binding
 * states the entity type — `context.target` is how the runtime knows what
 * to verify against — so the fact is recovered from there rather than
 * guessed from the parameter's name or left unavailable until someone
 * teaches the capability again.
 *
 * Never overwrites a declaration the contract already carries, and
 * returns the SAME object when there is nothing to add.
 */
export function withDeclaredIdentityEntity(
  capability: SemanticCapability,
  target: { inputName: string; entityType: string }
): SemanticCapability {
  const input = capability.inputs.find((entry) => entry.name === target.inputName);
  if (!input || input.role !== "target-identity" || input.entityType) return capability;
  return {
    ...capability,
    inputs: capability.inputs.map((entry) =>
      entry.name === target.inputName ? { ...entry, entityType: target.entityType } : entry
    )
  };
}

/** What this capability hands back that another one could target. */
export function identityProductions(capability: SemanticCapability): IdentityProducer[] {
  return capability.outputs
    .filter((output) => output.role === "entity-identity" && Boolean(output.entityType))
    .map((output) => ({
      capabilityId: capability.id,
      entityType: output.entityType as string,
      outputName: output.name,
      readOnly: capability.safety.readOnly
    }));
}

/** What this capability must be given before it can act. */
export function identityRequirements(capability: SemanticCapability): IdentityRequirement[] {
  return capability.inputs
    .filter((input) => input.role === "target-identity" && Boolean(input.entityType))
    .map((input) => ({ inputName: input.name, entityType: input.entityType as string }));
}

/** Tool ids joined the way a sentence needs them, deduplicated and stable. */
function nameList(ids: readonly string[]): string {
  const unique = [...new Set(ids)];
  if (unique.length <= 1) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} or ${unique[unique.length - 1]}`;
}

/**
 * Derives this capability's composition hints from the capabilities
 * published alongside it.
 *
 * Pure and order-independent: the same capability against the same peer
 * set always produces the same sentences, and a peer set that loses its
 * producer loses the hint with it. A capability is never its own peer —
 * a search that both produced and required the same identity would
 * otherwise be told to call itself.
 */
export function compositionHintsFor(
  capability: SemanticCapability,
  peers: readonly SemanticCapability[]
): CompositionHints {
  const others = peers.filter((peer) => peer.id !== capability.id);
  const tool: string[] = [];
  const inputs: Record<string, string> = {};

  const availableProducers = others.flatMap(identityProductions);
  const availableRequirements = others.flatMap((peer) =>
    identityRequirements(peer).map((requirement) => ({ ...requirement, capabilityId: peer.id }))
  );

  /* --- this tool needs an identity someone else hands out -------------- *
   * The wording keeps the choosing with the caller, deliberately. A search
   * may return several candidates and picks none, so "use the search and
   * update the result" would promise a uniqueness that does not exist —
   * the honest instruction is to obtain candidates and then choose.
   */
  for (const requirement of identityRequirements(capability)) {
    const producers = availableProducers.filter((producer) => producer.entityType === requirement.entityType);
    if (producers.length === 0) continue;
    const names = nameList(producers.map((producer) => producer.capabilityId));
    tool.push(
      `If ${requirement.inputName} is not already known, ${names} returns candidate ${requirement.entityType} ` +
        "records; choose the intended one and pass its identity here."
    );
    inputs[requirement.inputName] =
      `If unknown, ${names} returns candidate ${requirement.entityType} records to choose from.`;
  }

  /* --- this tool hands out an identity someone else needs --------------- */
  for (const production of identityProductions(capability)) {
    const consumers = availableRequirements.filter(
      (requirement) => requirement.entityType === production.entityType
    );
    if (consumers.length === 0) continue;
    const names = nameList(consumers.map((requirement) => requirement.capabilityId));
    const parameters = [...new Set(consumers.map((requirement) => requirement.inputName))];
    tool.push(
      `The identity on each candidate is what ${names} needs in order to act on one specific ` +
        `${production.entityType} (${parameters.join(", ")}).`
    );
  }

  return { tool, inputs };
}
