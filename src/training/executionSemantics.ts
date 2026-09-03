import type { TargetIdentityRequirement } from "../applicationIntelligence/targetIdentity";
import type { ExecutionGuarantee } from "../semantic/description";

/* ------------------------------------------------------------------ *
 * The half of a capability's description that is not the model's to write.
 *
 * Everything here is derived from facts the system has already
 * established elsewhere and can point at code for. Nothing is inferred
 * from the demonstration, nothing is phrased optimistically, and nothing
 * is emitted "because it is probably true" — a guarantee an agent reads
 * is a promise the runtime has to keep, and the only ones worth making
 * are the ones something refuses to break.
 *
 * The facts, and where each is established:
 *
 *   targetIdentity     `applicationIntelligence/targetIdentity.ts`, from a
 *                      platform that declares an entity identity it is
 *                      willing to gate a write on, plus the entity the
 *                      capability was demonstrated against.
 *   readOnly           the confirmed capability's own safety contract,
 *                      carried to the tool surface as `readOnlyHint` and
 *                      held to at publication.
 *   entityResolution   a read-only capability on a platform whose pages
 *                      expose stable identities: what a search returns is
 *                      candidates carrying those identities.
 *
 * Platform-neutral: the entity TYPE arrives as a string that a platform's
 * own declared knowledge produced, and nothing here knows which vendor,
 * application, or record type it names.
 * ------------------------------------------------------------------ */

export interface EstablishedExecutionFacts {
  /** The identity parameter the runtime gates writes on, when there is one. */
  targetIdentity?: TargetIdentityRequirement;
  /** The capability writes nothing. */
  readOnly: boolean;
  /**
   * The capability resolves entities and hands back their identities.
   *
   * `entityType` is optional because a demonstration may establish that a
   * search resolves entities without establishing what KIND — a route
   * whose identifier prefix the platform does not declare, most often.
   * The guarantees still hold; they simply stop naming a kind rather than
   * naming a wrong one.
   */
  entityResolution?: { entityType?: string };
}

const ENFORCED_BY = {
  identityRequired:
    "webmcp/compiler.ts marks the parameter required in the published input schema, and " +
    "binding/browserExecution/execute.ts stops an autonomous invocation that supplies none before touching the page.",
  identityVerified:
    "binding/browserExecution/execute.ts — establishTarget blocks on a mismatch before any control is touched, and " +
    "confirmTargetAfterSave re-reads the identity once the commit has landed.",
  readOnly:
    "webmcp/compiler.ts publishes readOnlyHint from the confirmed safety contract, and webmcp/publication.ts refuses " +
    "to publish a read-only capability with a mutation execution binding.",
  candidates:
    "binding/browserExecution/query.ts — candidatesOnPage returns every identifiable match in the application's own " +
    "order and has no path that selects one.",
  candidateIdentity:
    "binding/browserExecution/query.ts reads each candidate's id from the route the application itself linked, using " +
    "the platform's declared identity pattern, and drops any candidate whose identity or type it cannot establish."
} as const;

/**
 * The guarantees that hold for this capability, in the order they should
 * be read: what it needs, what it refuses, what it will and will not do.
 *
 * An empty result is a legitimate and common answer — a capability on a
 * platform that declares no identity scheme genuinely has nothing
 * enforceable to promise, and saying so by silence is better than
 * reaching for a weaker sentence.
 */
export function executionGuarantees(facts: EstablishedExecutionFacts): ExecutionGuarantee[] {
  const guarantees: ExecutionGuarantee[] = [];

  const target = facts.targetIdentity;
  if (target) {
    guarantees.push({
      id: "requires-target-identity",
      statement: `Requires ${target.inputName}: the ${target.entityType} record identity to act on.`,
      enforcedBy: ENFORCED_BY.identityRequired
    });
    guarantees.push({
      id: "refuses-on-target-mismatch",
      statement:
        `Refuses to write anything unless that ${target.entityType} is the record the application currently has ` +
        "open, and re-checks the identity after saving.",
      enforcedBy: ENFORCED_BY.identityVerified
    });
  }

  if (facts.readOnly) {
    guarantees.push({
      id: "read-only",
      statement: "Read-only: it does not create, modify, or delete anything in the application.",
      enforcedBy: ENFORCED_BY.readOnly
    });
  }

  const resolution = facts.entityResolution;
  if (resolution) {
    const kind = resolution.entityType ? `${resolution.entityType} ` : "";
    guarantees.push({
      id: "returns-candidates",
      statement: `May return zero, one, or several matching ${kind}candidates, and never chooses between them.`,
      enforcedBy: ENFORCED_BY.candidates
    });
    guarantees.push({
      id: "returns-record-identity",
      statement: `Each candidate carries the ${kind}record identity that identity-gated tools require.`,
      enforcedBy: ENFORCED_BY.candidateIdentity
    });
  }

  return guarantees;
}
