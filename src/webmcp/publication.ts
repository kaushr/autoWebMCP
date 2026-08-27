import { assertSemanticCapability, type SemanticCapability } from "../semantic/model";

/** One capability a human confirmed and then published to the control plane. */
export interface PublicationRecord {
  capability: SemanticCapability;
  publishedAt: string;
}

/**
 * Confirmation is the gate on publication, and the gate is enforced on both
 * sides of the wire. A capability the model merely proposed can never reach a
 * site's tool surface.
 */
export function assertPublishable(capability: SemanticCapability): SemanticCapability {
  assertSemanticCapability(capability);
  if (capability.provenance.source !== "confirmed" || !capability.provenance.confirmedByHuman) {
    throw new Error("Only a human-confirmed capability can be published.");
  }
  return capability;
}

export function parsePublicationRecord(value: unknown): PublicationRecord {
  if (typeof value !== "object" || value === null) throw new Error("A publication record is required.");
  const record = value as Partial<PublicationRecord>;
  if (typeof record.publishedAt !== "string") throw new Error("Publication timestamp is required.");
  if (!record.capability) throw new Error("Publication capability is required.");
  return { capability: assertPublishable(record.capability), publishedAt: record.publishedAt };
}

export function parsePublicationList(value: unknown): PublicationRecord[] {
  const body = value as { publications?: unknown };
  if (!Array.isArray(body?.publications)) throw new Error("Publication list is required.");
  return body.publications.map(parsePublicationRecord);
}

export async function publishCapability(capability: SemanticCapability): Promise<PublicationRecord> {
  assertPublishable(capability);

  const response = await fetch("/api/capabilities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability })
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

export async function unpublishAll(): Promise<number> {
  const response = await fetch("/api/capabilities", { method: "DELETE" });
  if (!response.ok) throw new Error(`Could not unpublish (${response.status}).`);
  const body = (await response.json()) as { removed?: number };
  return body.removed ?? 0;
}
