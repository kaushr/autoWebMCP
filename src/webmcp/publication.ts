import { assertSemanticCapability, type SemanticCapability } from "../semantic/model";
import { withDeclaredIdentityEntity, withEntityIdentityOutput } from "../semantic/composition";
import type { BrowserExecutionBinding } from "../binding/browserExecution/model";
import type { BrowserQueryBinding } from "../binding/browserExecution/query";

/**
 * One capability a human confirmed and then published to the control plane.
 *
 * `executionBinding` is carried alongside, not required by, the publication
 * gate below: a capability may also reach publication through an advertised
 * application binding (SignalBase) or an accepted supported-API binding,
 * neither of which needs this field. When present, it is the accepted
 * browser execution binding — declarative and safe to serialize, per
 * `binding/browserExecution/model.ts` — so a runtime invoking this published
 * tool later can find *how* to perform it without re-deriving anything.
 */
export interface PublicationRecord {
  capability: SemanticCapability;
  publishedAt: string;
  executionBinding?: BrowserExecutionBinding;
  /**
   * How a read-only search is performed, when the capability is one.
   *
   * Its own field rather than a variant of `executionBinding`, because the
   * two are different shapes with different rules — a mutation binding has
   * a commit and verification checks a query has no use for, and a query
   * returns results a mutation never produces.
   */
  queryBinding?: BrowserQueryBinding;
}

/**
 * Publication needs both answers: a human confirmed what the capability means,
 * and an execution binding says how the application performs it. Either alone
 * is a legitimate state; only together are they publishable. Enforced on both
 * sides of the wire, so a capability the model merely proposed — or one we
 * understand but cannot run — never reaches a site's tool surface.
 */
export function assertPublishable(capability: SemanticCapability): SemanticCapability {
  assertSemanticCapability(capability);
  if (capability.provenance.source !== "confirmed" || !capability.provenance.confirmedByHuman) {
    throw new Error("Only a human-confirmed capability can be published.");
  }
  if (!capability.binding) {
    throw new Error("A capability with no execution binding cannot be published.");
  }

  const source = capability.provenance.sourceApplication;
  if (source && source.id !== capability.binding.application) {
    throw new Error("An execution binding must belong to the application the capability was learned from.");
  }
  return capability;
}

/**
 * The published contract, with the identity facts its own accepted
 * bindings already establish.
 *
 * Composition hints are derived from contracts, so a contract that does
 * not say which entity its targeting parameter selects produces no hint.
 * That is the right default for something unknown — and the wrong answer
 * here, because the fact IS known and already published: an accepted
 * execution binding carries `context.target`, which is precisely what the
 * runtime verifies a write against, and an accepted query binding carries
 * the `entityType` whose identities its results are read as.
 *
 * So the facts are recovered from the record rather than requiring every
 * capability confirmed before these declarations existed to be taught
 * again. Nothing is invented and nothing is overwritten: a contract that
 * already declares its own identity is returned untouched, and a record
 * with no accepted binding contributes nothing.
 *
 * Deliberately not applied at publication time. This derives a VIEW for
 * registration; writing it back would edit a contract after the human
 * confirmed it, which is the one thing the confirmation gate exists to
 * prevent.
 */
export function publishedCapabilityContract(record: PublicationRecord): SemanticCapability {
  let capability = record.capability;
  const target = record.executionBinding?.context.target;
  if (target) capability = withDeclaredIdentityEntity(capability, target);
  if (record.queryBinding) capability = withEntityIdentityOutput(capability, record.queryBinding.entityType);
  return capability;
}

/**
 * A read-only capability must not be published with a way to write.
 *
 * The description an agent reads says "it does not create, modify, or
 * delete anything in the application", and a promise nothing checks is
 * exactly the kind of sentence the semantic layer refuses to let a model
 * write. So the claim is made checkable here: `safety.readOnly` and a
 * mutation execution binding — which exists to open an edit surface, set
 * values and click a commit control — are contradictory, and the
 * contradiction is refused at the boundary rather than published and
 * hoped about.
 *
 * A query binding is not a mutation and is deliberately unaffected: it
 * has no commit and nothing to verify against a record.
 */
export function assertSafetyMatchesBindings(
  capability: SemanticCapability,
  executionBinding?: BrowserExecutionBinding
): void {
  if (capability.safety.readOnly && executionBinding) {
    throw new Error(
      "A read-only capability cannot be published with a mutation execution binding: its contract states that it " +
        "changes nothing."
    );
  }
}

/**
 * Carries a resolved value domain into the contract that gets published.
 *
 * An agent calling a published tool has only its input schema to go on. A
 * constrained field published without its legal values invites a guess,
 * and the execution layer then (correctly) refuses anything the live
 * control does not offer — so the agent fails on a value it had no way of
 * knowing was wrong. The first live publication had exactly this shape:
 * `stage` went out as a bare string while the six values Salesforce
 * actually offers had already been resolved during testing and then
 * discarded.
 *
 * Only fills a domain that is genuinely known and not already declared;
 * it never invents one, and never overrides a contract that already
 * carries its own.
 */
export function withResolvedValueDomains(
  capability: SemanticCapability,
  domains: Readonly<Record<string, readonly string[]>>
): SemanticCapability {
  return {
    ...capability,
    inputs: capability.inputs.map((input) => {
      const values = domains[input.name];
      if (input.enum || !values || values.length === 0) return input;
      return { ...input, enum: [...values] };
    })
  };
}

export function parsePublicationRecord(value: unknown): PublicationRecord {
  if (typeof value !== "object" || value === null) throw new Error("A publication record is required.");
  const record = value as Partial<PublicationRecord>;
  if (typeof record.publishedAt !== "string") throw new Error("Publication timestamp is required.");
  if (!record.capability) throw new Error("Publication capability is required.");
  const capability = assertPublishable(record.capability);
  assertSafetyMatchesBindings(capability, record.executionBinding);
  return {
    capability,
    publishedAt: record.publishedAt,
    ...(record.executionBinding ? { executionBinding: record.executionBinding } : {}),
    ...(record.queryBinding ? { queryBinding: record.queryBinding } : {})
  };
}

export function parsePublicationList(value: unknown): PublicationRecord[] {
  const body = value as { publications?: unknown };
  if (!Array.isArray(body?.publications)) throw new Error("Publication list is required.");
  return body.publications.map(parsePublicationRecord);
}

export async function publishCapability(
  capability: SemanticCapability,
  executionBinding?: BrowserExecutionBinding,
  queryBinding?: BrowserQueryBinding
): Promise<PublicationRecord> {
  assertPublishable(capability);
  assertSafetyMatchesBindings(capability, executionBinding);

  const response = await fetch("/api/capabilities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability,
      ...(executionBinding ? { executionBinding } : {}),
      ...(queryBinding ? { queryBinding } : {})
    })
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Publishing failed (${response.status}).`);
  }
  return parsePublicationRecord(await response.json());
}

export async function listPublishedCapabilities(): Promise<PublicationRecord[]> {
  const response = await fetch("/api/capabilities");
  if (!response.ok) throw new Error(`Could not read published capabilities (${response.status}).`);
  return parsePublicationList(await response.json());
}

/** Removes one published capability. WebMCP has no unregister, so a reload clears the tool surface. */
export async function unpublishCapability(capabilityId: string): Promise<void> {
  const response = await fetch(`/api/capabilities/${encodeURIComponent(capabilityId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Could not unpublish ${capabilityId} (${response.status}).`);
}

export async function unpublishAll(): Promise<number> {
  const response = await fetch("/api/capabilities", { method: "DELETE" });
  if (!response.ok) throw new Error(`Could not unpublish (${response.status}).`);
  const body = (await response.json()) as { removed?: number };
  return body.removed ?? 0;
}
