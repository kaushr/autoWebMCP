import type { ObservationTrace } from "../capture/normalize";
import type { EpistemicNeed } from "../applicationIntelligence/model";
import type { SemanticCapability } from "../semantic/model";
import { resolveFieldMapping, type ApplicationIntelligence } from "../binding/fieldMapping";
import { canonicalizeCapabilityInputs, type InputCanonicalization } from "./canonicalInputs";
import { observedRecordType } from "../binding/fieldMapping";
import { targetIdentityFor, type TargetIdentityRequirement } from "../applicationIntelligence/targetIdentity";

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

  // A rename or a newly added identity parameter both change what an agent
  // would receive, so both invalidate a confirmation given for the old one.
  const withdraw = (canonical.renames.length > 0 || identityAdded) && capability.provenance.confirmedByHuman;

  const grounded: SemanticCapability = withdraw
    ? { ...withIdentity, provenance: { ...withIdentity.provenance, source: "inferred", confirmedByHuman: false } }
    : withIdentity;

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
    confirmationWithdrawn: withdraw
  };
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
  if (!trace.observations.some((observation) => observation.action === "save")) return undefined;
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

/** The sentence shown when a confirmed contract had to be corrected. */
export function describeWithdrawnConfirmation(renames: readonly InputCanonicalization[]): string {
  return (
    "A stronger field identity was established after you confirmed, so the contract an agent would see changed " +
    `(${renames.map((rename) => `${rename.from} → ${rename.to}`).join(", ")}). ` +
    "Confirmation was withdrawn: review and confirm the contract that will actually be published."
  );
}
