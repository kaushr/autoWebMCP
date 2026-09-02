import type { BrowserExecutionBinding } from "../binding/browserExecution/model";
import type { ApplicationFieldType, TenantIntelligenceSnapshot } from "../applicationIntelligence/model";
import { observedTenantSnapshot, type ObservedTenantField } from "../applicationIntelligence/observedTenant";

/* ------------------------------------------------------------------ *
 * What this session learned about the org, in the tenant layer's terms.
 *
 * The adapter sits here rather than in `applicationIntelligence/` on
 * purpose: knowing what a binding is would make the knowledge layer depend
 * on the execution layer, and the whole point of the seam is that the
 * resolver cannot tell where a snapshot came from. Application Intelligence
 * receives tenant facts; it does not know about bindings, Studio state, or
 * live inspections.
 * ------------------------------------------------------------------ */

const FIELD_TYPES = new Set<ApplicationFieldType>([
  "string",
  "date",
  "datetime",
  "number",
  "currency",
  "boolean",
  "picklist",
  "reference"
]);

/** A required-field marker is presentation, not part of what the org calls the field. */
function tenantLabel(label: string): string {
  return label.replace(/^\*/, "").trim();
}

function fieldType(value: string | undefined): ApplicationFieldType | undefined {
  return value && FIELD_TYPES.has(value as ApplicationFieldType) ? (value as ApplicationFieldType) : undefined;
}

/**
 * Turns an accepted binding plus whatever the live application was read to
 * offer into a tenant snapshot.
 *
 * Only grounded inputs contribute: an input with no `applicationField` has
 * no identity to attach a tenant fact to, and inventing one from a label
 * would be exactly the guess this layer exists to avoid. An input read
 * live but ungrounded is simply left out.
 *
 * Returns `undefined` when nothing was learned, so a caller never installs
 * an empty snapshot that would claim to know this org.
 */
export function observedTenantFromBinding(
  binding: BrowserExecutionBinding,
  liveOptions: Readonly<Record<string, readonly string[]>>,
  observedAt: string
): TenantIntelligenceSnapshot | undefined {
  const byObject = new Map<string, ObservedTenantField[]>();

  for (const input of binding.inputs) {
    const applicationField = input.applicationField;
    const objectApiName = applicationField?.objectApiName;
    const type = fieldType(applicationField?.type);
    if (!applicationField || !objectApiName || !type) continue;

    const label = tenantLabel(input.semanticTarget.label);
    if (!label) continue;

    const options = liveOptions[input.semanticInput];
    const fields = byObject.get(objectApiName) ?? [];
    fields.push({
      apiName: applicationField.apiName,
      label,
      type,
      ...(options && options.length > 0 ? { options: [...options] } : {})
    });
    byObject.set(objectApiName, fields);
  }

  // V0.1 observes one record type per capture, which is what a single
  // demonstration can honestly speak to.
  const [objectApiName, fields] = [...byObject.entries()][0] ?? [];
  if (!objectApiName || !fields || fields.length === 0) return undefined;

  return observedTenantSnapshot({ platform: binding.platform, objectApiName, fields, observedAt });
}
