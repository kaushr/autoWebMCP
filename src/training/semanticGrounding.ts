import type { ObservationTrace } from "../capture/normalize";
import type { EpistemicNeed } from "../applicationIntelligence/model";
import type { SemanticCapability } from "../semantic/model";
import { resolveFieldMapping, type ApplicationIntelligence } from "../binding/fieldMapping";
import { canonicalizeCapabilityInputs, type InputCanonicalization } from "./canonicalInputs";
import { observedRecordType } from "../binding/fieldMapping";
import { targetIdentityFor, type TargetIdentityRequirement } from "../applicationIntelligence/targetIdentity";
import {
  composeDescription,
  humanizeInputName,
  type ComposedDescription
} from "../semantic/description";
import { executionGuarantees } from "./executionSemantics";
import {
  canonicalIdentityFromPath,
  entityIdentityPolicyForPlatform
} from "../binding/browserExecution/entityIdentity";
import type { CapabilityInput } from "../semantic/model";

/* ------------------------------------------------------------------ *
 * Semantic grounding — the stage between a model's proposal and a
 * human's confirmation.
 *
 * The lifecycle used to run canonicalization once, at proposal time, on
 * whatever knowledge happened to exist then. But field identity can arrive
 * later — most often from a person answering which field a label meant —
 * and by then the contract had been confirmed. Renaming it afterwards
 * would publish something the human never approved; leaving it would
 * publish one org's vocabulary to every agent forever.
 *
 * The fix is ordering, not a new mechanism. Everything that can change an
 * agent-facing name is settled here, while the contract is still open, and
 * this stage owns exactly one question: WHAT DOES THE AGENT SEE. It is
 * deliberately not the binding stage — it never resolves a live control,
 * never touches the DOM, and produces no execution state. A semantic
 * identity and a DOM locator remain different things; the second is still
 * re-resolved fresh at execution time.
 *
 * Pure: same capability, trace, and knowledge in, same result out.
 * ------------------------------------------------------------------ */

export interface GroundedCapability {
  /** The capability as an agent would see it, given what is currently known. */
  capability: SemanticCapability;
  /** Questions whose answers could still change a parameter name. Ask these BEFORE confirming. */
  needs: EpistemicNeed[];
  /** Where a canonical name replaced the label the human demonstrated, and why. */
  renames: InputCanonicalization[];
  /**
   * Inputs that ARE grounded, but whose names stay in this org's
   * vocabulary because the vendor's model has no name for the field —
   * a custom field, typically. A legitimate resting state: the capability
   * works and can execute. What it is not is portable to another tenant,
   * so that is said rather than left to be inferred.
   */
  noncanonical: string[];
  /**
   * Inputs nothing could ground at all.
   *
   * Deliberately separate from `noncanonical`: one is a contract that
   * works and travels badly, the other cannot be executed at all. Reporting
   * them as one thing would tell a person their capability is merely
   * org-specific when in fact it will not bind.
   */
  unresolved: string[];
  /**
   * The identity parameter this capability requires, when it operates on an
   * existing entity. Present on `capability.inputs` too; surfaced here so
   * the Studio can explain WHY an input nobody demonstrated is in the
   * contract a human is about to approve.
   */
  targetIdentity?: TargetIdentityRequirement;
  /**
   * How the agent-facing description was composed: what the model
   * inferred, what the system contributed, and what the model tried to
   * promise and was not allowed to.
   *
   * Surfaced rather than folded silently into `capability.description`
   * because a person confirming the contract should be able to see which
   * half is which — a sentence they can rewrite versus one the runtime
   * owns — and because a rejected claim is a thing worth knowing the
   * model attempted.
   */
  descriptionComposition: ComposedDescription;
  /**
   * A confirmed contract had to change, so the confirmation behind it no
   * longer describes what would be published.
   *
   * Correct ordering means this should not arise. It exists so that it
   * cannot pass silently if it ever does.
   */
  confirmationWithdrawn: boolean;
}

/**
 * Settles a capability's agent-facing contract from the evidence and
 * knowledge currently available.
 *
 * Re-runnable by design: answering one question and grounding again is the
 * whole interaction model, and nothing here accumulates state between
 * calls.
 *
 * On a capability a human has already confirmed, a rename is not applied
 * quietly. The contract is corrected AND its confirmation withdrawn
 * together, because those are one fact: the approval described a contract
 * that no longer exists. Publication already requires
 * `confirmedByHuman`, so a withdrawn confirmation cannot reach an agent —
 * the gate holds without anything here having to enforce it.
 */
export function groundCapability(
  capability: SemanticCapability,
  trace: ObservationTrace,
  intelligence: ApplicationIntelligence = {}
): GroundedCapability {
  const canonical = canonicalizeCapabilityInputs(capability, trace, intelligence);

  /* --- the system's own contribution to the contract -------------------- *
   * The human taught which FIELDS to change. Platform and Application
   * Intelligence contribute which RECORD to change them on, because an
   * agent invoking this later has opened nothing and chosen nothing.
   *
   * Added here, before confirmation, precisely because it changes the
   * agent-facing contract — the same reason canonical renaming happens
   * here. A person must approve the contract that gets published, and that
   * contract includes a parameter they did not demonstrate.
   */
  const identity = requiredTargetIdentity(capability, trace, intelligence);
  const withIdentity = identity ? withTargetIdentityInput(canonical.capability, identity) : canonical.capability;
  const identityAdded = withIdentity !== canonical.capability;

  /* --- the description an agent will read -------------------------------- *
   * Composed here for the same reason the identity parameter is added
   * here: it is part of the contract a human is about to approve, and
   * approving a description that gets rewritten afterwards would approve
   * nothing. The model's business intent survives; anything it tried to
   * promise about the runtime does not, and the guarantees the system can
   * actually name enforcement for are added in its place.
   */
  const resolution = entityResolution(capability, trace, intelligence);
  const guarantees = executionGuarantees({
    ...(identity ? { targetIdentity: identity } : {}),
    readOnly: capability.safety.readOnly,
    ...(resolution ? { entityResolution: resolution } : {})
  });
  const descriptionComposition = composeDescription(withIdentity.description, guarantees);
  const entityType = identity?.entityType ?? resolution?.entityType;
  const described = withComposedDescriptions(withIdentity, descriptionComposition.text, {
    ...(entityType ? { entityType } : {}),
    mutating: Boolean(identity) || (!capability.safety.readOnly && committed(trace)),
    resolving: Boolean(resolution)
  });

  // A rename, a newly added identity parameter, and a changed description
  // all change what an agent would receive, so all three invalidate a
  // confirmation given for the old contract. Composition is idempotent, so
  // re-grounding an already-composed contract reaches none of this.
  const withdraw =
    (canonical.renames.length > 0 || identityAdded || described !== withIdentity) &&
    capability.provenance.confirmedByHuman;

  const grounded: SemanticCapability = withdraw
    ? { ...described, provenance: { ...described.provenance, source: "inferred", confirmedByHuman: false } }
    : described;

  // Resolved again under the names the contract now carries, so every
  // question a human is asked describes the capability in front of them
  // rather than the one the model first proposed.
  const mapping = resolveFieldMapping(grounded, trace, intelligence);

  // `canonicalizeCapabilityInputs` reports one bucket — "not renamed" —
  // which covers both a custom field it has no vendor name for and an input
  // that grounded to nothing. The grounding stage has the mapping in hand
  // and can tell them apart, so it does.
  const tenantDerived = canonical.tenantDerived;
  return {
    capability: grounded,
    needs: mapping.needs.filter((need) => need.blocking),
    renames: canonical.renames,
    noncanonical: tenantDerived.filter((name) => mapping.mapping[name] !== undefined),
    unresolved: tenantDerived.filter((name) => mapping.mapping[name] === undefined),
    ...(identity ? { targetIdentity: identity } : {}),
    descriptionComposition,
    confirmationWithdrawn: withdraw
  };
}

/** A trace that saved something demonstrated a write, whatever else it also did. */
function committed(trace: ObservationTrace): boolean {
  return trace.observations.some((observation) => observation.action === "save");
}

/**
 * Whether this capability resolves entities and hands back their
 * identities — a search, in other words.
 *
 * Deliberately the mirror image of `requiredTargetIdentity`, and gated on
 * the same platform fact. A read-only capability that never saved anything
 * is not a mutation; if the platform also declares an identity its pages
 * expose, then what a search over it can return is candidates carrying
 * those identities, because that is precisely what
 * `browserExecution/query.ts` reads out of the links the application
 * itself rendered. Where the platform declares no identity scheme, this
 * says nothing: a search that cannot hand back an id has no candidate
 * guarantee to make.
 *
 * The narrower reading — "only a capability whose query binding has been
 * accepted" — was rejected because acceptance happens AFTER confirmation,
 * and a description settled after confirmation is a description nobody
 * approved.
 */
function entityResolution(
  capability: SemanticCapability,
  trace: ObservationTrace,
  intelligence: ApplicationIntelligence
): { entityType?: string } | undefined {
  if (!capability.safety.readOnly) return undefined;
  if (committed(trace)) return undefined;
  const policy = intelligence.platform ? entityIdentityPolicyForPlatform(intelligence.platform) : undefined;
  if (!policy) return undefined;

  /*
   * The entity type comes from the record the demonstration ENDED on,
   * read with the platform's own declared route pattern rather than a
   * pattern of ours. That matters here more than anywhere: a live search
   * recording ends at `/lightning/r/<id>/view` with no object segment at
   * all, and only the platform's declared identifier prefixes can say
   * that the id belongs to an Opportunity. A cruder read would have
   * announced that this capability returns "0065w00002AZ0GeAAL
   * candidates".
   *
   * A type nothing can establish is left out rather than guessed — the
   * candidate guarantees still hold, they just stop naming a kind.
   */
  for (let index = trace.observations.length - 1; index >= 0; index--) {
    const path = trace.observations[index]?.page?.path;
    if (!path) continue;
    const parsed = canonicalIdentityFromPath(path, policy);
    if (parsed?.entityType) return { entityType: parsed.entityType };
  }
  return {};
}

/** What the fallback wording needs to know when an input arrived undescribed. */
interface DescriptionContext {
  entityType?: string;
  /** The demonstration wrote to a record, so a business input is a value being set. */
  mutating: boolean;
  /** The capability finds records, so a business input narrows the search. */
  resolving: boolean;
}

/**
 * A description for an input that arrived without a usable one.
 *
 * Derived, not invented. The name came from the label the human
 * demonstrated, and what the capability DOES with that input is already
 * established: a demonstration that saved a record sets values on it, and
 * a search narrows by them. Both readings come from evidence, not from a
 * guess about what the field means.
 *
 * A thin description is the honest floor here. The alternative that was
 * rejected is a model asked to elaborate on a name it has no evidence
 * for, which produces fluent text about a field nobody described.
 */
function fallbackInputDescription(input: CapabilityInput, context: DescriptionContext): string {
  const label = humanizeInputName(input.name);
  if (input.role === "query") {
    return context.entityType
      ? `Search term used to find matching ${context.entityType} records.`
      : "Search term used to find matching records.";
  }
  if (context.mutating) {
    return context.entityType ? `${label} to set on the ${context.entityType}.` : `${label} to set.`;
  }
  if (context.resolving) {
    return context.entityType
      ? `${label} used to narrow the ${context.entityType} search.`
      : `${label} used to narrow the search.`;
  }
  return `${label}.`;
}

/**
 * Settles the capability's description and every input's, returning the
 * SAME object when nothing changed.
 *
 * Identity-return matters: it is what tells the caller whether a standing
 * confirmation still describes the contract, exactly as it does for the
 * identity parameter.
 *
 * Input descriptions get the same fabrication guard the capability
 * description does, with one exception. A `target-identity` input's
 * description is system-authored end to end — it comes from the same
 * machinery that decided the parameter had to exist at all — so running a
 * guard designed to catch a model promising things over it would strip
 * the system's own honest statement of what it enforces.
 */
function withComposedDescriptions(
  capability: SemanticCapability,
  description: string,
  context: DescriptionContext
): SemanticCapability {
  let changed = description !== capability.description;
  const inputs = capability.inputs.map((input) => {
    if (input.role === "target-identity") return input;
    // No guarantees to re-add at this level: an input describes a value,
    // and a promise about what the runtime does with it belongs in the
    // capability's own description where it can be read once.
    const composed = composeDescription(input.description, []);
    const text = composed.intent || fallbackInputDescription(input, context);
    if (text === input.description) return input;
    changed = true;
    return { ...input, description: text };
  });

  return changed ? { ...capability, description, inputs } : capability;
}

/**
 * Whether this capability operates on an existing entity, and what would
 * identify it.
 *
 * The signal for "operates on an existing record" is the same one the
 * binding proposal already trusts: the trace shows a commit against a
 * record page. A capability that never saved anything is not a mutation,
 * and a page that named no record type gives nothing to identify.
 */
function requiredTargetIdentity(
  capability: SemanticCapability,
  trace: ObservationTrace,
  intelligence: ApplicationIntelligence
): TargetIdentityRequirement | undefined {
  if (capability.safety.readOnly) return undefined;
  if (!committed(trace)) return undefined;
  return targetIdentityFor(intelligence.platform, observedRecordType(trace));
}

/**
 * Adds the identity parameter, unless the contract already carries it.
 *
 * Returns the SAME object when nothing changed, so the caller can tell an
 * addition from a no-op by identity — which is what decides whether a
 * standing confirmation still describes the contract.
 *
 * It goes first in the input list because it selects what everything else
 * applies to, and reading a contract in that order is how a person
 * understands it.
 */
function withTargetIdentityInput(
  capability: SemanticCapability,
  identity: TargetIdentityRequirement
): SemanticCapability {
  if (capability.inputs.some((input) => input.name === identity.inputName)) return capability;
  return {
    ...capability,
    inputs: [
      {
        name: identity.inputName,
        description: identity.description,
        type: "string",
        required: true,
        role: "target-identity"
      },
      ...capability.inputs
    ]
  };
}

/**
 * The sentence shown when a confirmed contract had to be corrected.
 *
 * A rename is the common cause and names itself. It is not the only one —
 * an identity parameter or a recomposed description changes the contract
 * just as much — so the message says what it can and never renders an
 * empty parenthesis for a withdrawal it cannot attribute to a rename.
 */
export function describeWithdrawnConfirmation(renames: readonly InputCanonicalization[]): string {
  const cause = renames.length
    ? "A stronger field identity was established after you confirmed, so the contract an agent would see changed " +
      `(${renames.map((rename) => `${rename.from} → ${rename.to}`).join(", ")}). `
    : "The contract an agent would see changed after you confirmed it. ";
  return cause + "Confirmation was withdrawn: review and confirm the contract that will actually be published.";
}
