import type { TenantIntelligenceSnapshot, TenantIntelligenceSource, TenantObjectSchema } from "./model";
import { foldIdentity } from "./model";

/* ------------------------------------------------------------------ *
 * Tenant intelligence sources.
 *
 * The whole of V0.1's tenant layer: a seam and two implementations. There
 * is deliberately no acquisition code here — no describe call, no crawler,
 * no cache, no store. Obtaining a snapshot safely is a separate problem
 * with its own prerequisites (see `docs/APPLICATION_INTELLIGENCE.md`), and
 * a resolver that works against an injected snapshot works unchanged
 * against one an admin captured centrally.
 *
 * `emptyTenantIntelligence()` is what production runs today, and it is an
 * honest answer rather than a placeholder: no tenant metadata path is
 * installed, so the system says it knows nothing and falls back to
 * standard knowledge plus observed evidence.
 * ------------------------------------------------------------------ */

/** Knows nothing, says so. The default everywhere. */
export function emptyTenantIntelligence(): TenantIntelligenceSource {
  return {
    describe: () => undefined,
    getObject: () => undefined
  };
}

/**
 * An in-memory source over one captured snapshot.
 *
 * Object lookup folds identity so `Opportunity` and `opportunity` agree,
 * matching how the rest of the system compares application identifiers.
 */
export function tenantIntelligenceFrom(snapshot: TenantIntelligenceSnapshot): TenantIntelligenceSource {
  const byObject = new Map<string, TenantObjectSchema>();
  for (const object of snapshot.objects) byObject.set(foldIdentity(object.apiName), object);

  const provenance = {
    ...(snapshot.orgId ? { orgId: snapshot.orgId } : {}),
    ...(snapshot.capturedAt ? { capturedAt: snapshot.capturedAt } : {}),
    ...(snapshot.mechanism ? { mechanism: snapshot.mechanism } : {})
  };

  return {
    describe(platform) {
      return platform === snapshot.platform ? provenance : undefined;
    },
    getObject(platform, objectApiName) {
      if (platform !== snapshot.platform) return undefined;
      return byObject.get(foldIdentity(objectApiName));
    }
  };
}
