import type {
  ApplicationFieldType,
  TenantFieldSchema,
  TenantIntelligenceSnapshot,
  TenantObjectSchema
} from "./model";
import { foldIdentity } from "./model";

/* ------------------------------------------------------------------ *
 * The tenant layer's first producer.
 *
 * The seam in `tenant.ts` was built for metadata that no supported path
 * can currently reach, and so production always ran the empty source: a
 * declared layer with nothing in it. Meanwhile the system was already
 * learning tenant facts and throwing them away — the label this org uses
 * for a field, and the values its picklist actually offered when the live
 * control was opened and read. Those landed in Studio variables that died
 * on reload, carrying no provenance and no expiry.
 *
 * They are tenant knowledge. This turns them into it, at the honest
 * strength: `observed-live`, dated, and never promoted to metadata. What a
 * describe call would state about configuration, an observation only
 * reports about one record, one user, and one moment.
 *
 * Deliberately NOT a store. Nothing here persists, caches across sessions,
 * or learns over time. It converts what one session observed into the shape
 * the resolver already consumes, which is the whole of V0.1.
 * ------------------------------------------------------------------ */

/** One field this session actually observed in the running application. */
export interface ObservedTenantField {
  /** The application's own identity, as already grounded, e.g. `StageName`. */
  apiName: string;
  /** What THIS org calls it on screen. */
  label: string;
  type: ApplicationFieldType;
  /** The values the live control offered, when it was read. Absent means not read, never unrestricted. */
  options?: string[];
}

export interface ObservedTenantInput {
  platform: string;
  objectApiName: string;
  fields: readonly ObservedTenantField[];
  observedAt: string;
}

/**
 * Builds a tenant snapshot from what one live session observed.
 *
 * `mechanism` says plainly how it was obtained, so a consumer never has to
 * infer whether it is looking at configuration or at a reading.
 */
export function observedTenantSnapshot(input: ObservedTenantInput): TenantIntelligenceSnapshot {
  const fields: TenantFieldSchema[] = input.fields.map((field) => ({
    apiName: field.apiName,
    label: field.label,
    type: field.type,
    source: "observed-live",
    observedAt: input.observedAt,
    ...(field.options && field.options.length > 0 ? { options: [...field.options] } : {})
  }));

  return {
    platform: input.platform,
    capturedAt: input.observedAt,
    mechanism: "observed-live-application",
    objects: [{ apiName: input.objectApiName, fields }]
  };
}

/** Two sources describing one field differently. Surfaced, never silently resolved. */
export interface TenantFactConflict {
  objectApiName: string;
  apiName: string;
  fact: "label" | "type" | "options";
  fromMetadata: string;
  fromObservation: string;
  detail: string;
}

export interface MergedTenantIntelligence {
  snapshot: TenantIntelligenceSnapshot;
  conflicts: TenantFactConflict[];
}

function describeOptions(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "none";
}

/**
 * Combines org metadata with what this session saw, without letting either
 * quietly overwrite the other.
 *
 * Metadata wins on identity and type: it states how the org is configured,
 * and one screen cannot overrule that. The live reading wins on the value
 * DOMAIN, and that is not an inconsistency — the legal set narrows by
 * record type, by a controlling field, and by the running user's
 * permissions, none of which a snapshot taken elsewhere can know. So a
 * control offering fewer values than metadata lists is the more accurate
 * answer for this execution, and is taken as such.
 *
 * Every disagreement is reported either way. A conflict is evidence that
 * something has changed or been misread, and it is worth a human's
 * attention rather than a silent precedence rule.
 */
export function mergeTenantSnapshots(
  metadata: TenantIntelligenceSnapshot | undefined,
  observed: TenantIntelligenceSnapshot
): MergedTenantIntelligence {
  if (!metadata) return { snapshot: observed, conflicts: [] };
  if (metadata.platform !== observed.platform) return { snapshot: metadata, conflicts: [] };

  const conflicts: TenantFactConflict[] = [];
  const objects = new Map<string, TenantObjectSchema>();
  for (const object of metadata.objects) objects.set(foldIdentity(object.apiName), { ...object, fields: [...object.fields] });

  for (const observedObject of observed.objects) {
    const key = foldIdentity(observedObject.apiName);
    const known = objects.get(key);
    if (!known) {
      objects.set(key, { ...observedObject, fields: [...observedObject.fields] });
      continue;
    }

    for (const observedField of observedObject.fields) {
      const index = known.fields.findIndex(
        (field) => foldIdentity(field.apiName) === foldIdentity(observedField.apiName)
      );
      if (index === -1) {
        known.fields.push(observedField);
        continue;
      }

      const metadataField = known.fields[index];
      if (foldIdentity(metadataField.label) !== foldIdentity(observedField.label)) {
        conflicts.push({
          objectApiName: known.apiName,
          apiName: metadataField.apiName,
          fact: "label",
          fromMetadata: metadataField.label,
          fromObservation: observedField.label,
          detail:
            `Org metadata labels ${known.apiName}.${metadataField.apiName} "${metadataField.label}", but the running ` +
            `application showed "${observedField.label}". The metadata may predate a rename.`
        });
      }
      if (metadataField.type !== observedField.type) {
        conflicts.push({
          objectApiName: known.apiName,
          apiName: metadataField.apiName,
          fact: "type",
          fromMetadata: metadataField.type,
          fromObservation: observedField.type,
          detail:
            `Org metadata declares ${known.apiName}.${metadataField.apiName} a ${metadataField.type}, but the control ` +
            `observed behaves like a ${observedField.type}.`
        });
      }

      const observedOptions = observedField.options;
      if (observedOptions && observedOptions.length > 0) {
        const metadataOptions = metadataField.options;
        const differs =
          !metadataOptions ||
          metadataOptions.length !== observedOptions.length ||
          observedOptions.some((value) => !metadataOptions.some((known) => foldIdentity(known) === foldIdentity(value)));
        if (differs && metadataOptions && metadataOptions.length > 0) {
          conflicts.push({
            objectApiName: known.apiName,
            apiName: metadataField.apiName,
            fact: "options",
            fromMetadata: describeOptions(metadataOptions),
            fromObservation: describeOptions(observedOptions),
            detail:
              `Org metadata lists ${describeOptions(metadataOptions)} for ${metadataField.apiName}; the live control ` +
              `offered ${describeOptions(observedOptions)}. The live set governs this execution — record type, a ` +
              "controlling field, or permissions can all narrow it — and the difference is reported, not hidden."
          });
        }
        // Identity and type stay metadata's; the domain becomes the reading's,
        // and is marked as one so nothing downstream mistakes it for configuration.
        known.fields[index] = {
          ...metadataField,
          options: [...observedOptions],
          source: "observed-live",
          ...(observedField.observedAt ? { observedAt: observedField.observedAt } : {})
        };
      }
    }
  }

  return {
    snapshot: {
      ...metadata,
      mechanism: metadata.mechanism
        ? `${metadata.mechanism} + observed-live-application`
        : "observed-live-application",
      objects: [...objects.values()]
    },
    conflicts
  };
}

/**
 * Whether a live reading is too old to act on.
 *
 * Only observations expire. Metadata describes configuration and is stale
 * in a different, slower sense that a timeout cannot judge, so a snapshot
 * carrying no observed fields is never called stale here.
 */
export function staleObservedFields(
  snapshot: TenantIntelligenceSnapshot,
  now: number,
  maxAgeMs: number
): Array<{ objectApiName: string; apiName: string; ageMs: number }> {
  const stale: Array<{ objectApiName: string; apiName: string; ageMs: number }> = [];
  for (const object of snapshot.objects) {
    for (const field of object.fields) {
      if (field.source !== "observed-live" || !field.observedAt) continue;
      const observedAt = Date.parse(field.observedAt);
      if (Number.isNaN(observedAt)) continue;
      const ageMs = now - observedAt;
      if (ageMs > maxAgeMs) stale.push({ objectApiName: object.apiName, apiName: field.apiName, ageMs });
    }
  }
  return stale;
}
