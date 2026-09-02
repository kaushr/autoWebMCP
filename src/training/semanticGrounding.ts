import type { ObservationTrace } from "../capture/normalize";
import type { EpistemicNeed } from "../applicationIntelligence/model";
import type { SemanticCapability } from "../semantic/model";
import { resolveFieldMapping, type ApplicationIntelligence } from "../binding/fieldMapping";
import { canonicalizeCapabilityInputs, type InputCanonicalization } from "./canonicalInputs";

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
  const withdraw = canonical.renames.length > 0 && capability.provenance.confirmedByHuman;

  const grounded: SemanticCapability = withdraw
    ? {
        ...canonical.capability,
        provenance: { ...canonical.capability.provenance, source: "inferred", confirmedByHuman: false }
      }
    : canonical.capability;

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
    confirmationWithdrawn: withdraw
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
