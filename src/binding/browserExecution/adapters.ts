import { defaultPlatformIntelligenceProvider, type PlatformIntelligenceProvider } from "../../platformIntelligence";
import { emptyTenantIntelligence } from "../../applicationIntelligence/tenant";
import type { TenantIntelligenceSource } from "../../applicationIntelligence/model";
import type { ApplicationIntelligence } from "../fieldMapping";
import { createSalesforceResolverAdapter } from "./salesforceAdapter";
import { DEFAULT_RESOLUTION_POLICY, type ResolutionPolicy } from "./resolutionPolicy";
import type { EntityIdentityPolicy } from "./entityIdentity";
import { DEFAULT_PAGE_STATE_POLICY, type PageStatePolicy } from "./pageState";
import { DEFAULT_VERIFICATION_POLICY, type VerificationPolicy } from "./verificationPolicy";
import type { PlatformResolverAdapter } from "./engine";

/* ------------------------------------------------------------------ *
 * The composition root for browser execution.
 *
 * The one place where Platform Intelligence (knowledge) is translated into
 * a resolution policy (deterministic mechanism config) and paired with a
 * platform's adapter (platform-specific mechanics). Keeping the
 * translation here is what lets `engine.ts` stay generic — it never
 * imports a pack, and a new platform can declare entirely different
 * traversal behaviour without the engine changing at all.
 *
 * The translation is a plain data mapping, performed once per execution.
 * No model is consulted; a DOM lookup must stay deterministic.
 * ------------------------------------------------------------------ */

const ADAPTERS: Record<
  string,
  (
    pageState: PageStatePolicy,
    verification: VerificationPolicy,
    entityIdentity: EntityIdentityPolicy | undefined
  ) => PlatformResolverAdapter
> = {
  "salesforce-lightning": createSalesforceResolverAdapter
};

/**
 * The resolution policy for a platform, from its pack. Falls back to the
 * generic default when a pack says nothing — an unrecognized platform is
 * never given another platform's traversal rules.
 */
export function resolutionPolicyForPlatform(
  platform: string,
  intelligence: PlatformIntelligenceProvider = defaultPlatformIntelligenceProvider
): ResolutionPolicy {
  const declared = intelligence.getResolutionPolicy(platform);
  if (!declared) return DEFAULT_RESOLUTION_POLICY;
  return {
    traversal: declared.resolution.traversal,
    shadowRoots: declared.resolution.shadowRoots,
    eventRetargeting: declared.resolution.eventRetargeting,
    identityPriority: [...declared.resolution.identityPriority]
  };
}

/**
 * How this platform's record-edit state is recognized, from its pack —
 * every independently-provenanced pattern it declares, compiled into one
 * policy. The conservative generic default applies when a pack declares
 * nothing. `commitActionLabels`/`dismissActionLabels` are the union of
 * whatever every structural pattern declares, since that vocabulary is
 * shared platform knowledge ("what Save looks like here"), not something
 * that varies per recognition pattern; a platform declaring no structural
 * pattern at all falls back to the generic Save/Cancel wording so
 * restoration still has something to look for.
 */
export function pageStatePolicyForPlatform(
  platform: string,
  intelligence: PlatformIntelligenceProvider = defaultPlatformIntelligenceProvider
): PageStatePolicy {
  const declared = intelligence.getPageStateSemantics(platform);
  if (!declared || declared.entries.length === 0) return DEFAULT_PAGE_STATE_POLICY;

  const patterns: PageStatePolicy["patterns"] = declared.entries.map((entry) => {
    const surface = entry.pageState.editSurface;
    return {
      id: entry.id,
      strength: entry.strength,
      evidence:
        surface.kind === "component-identity"
          ? { kind: "component-identity" as const, componentIdentities: [...surface.componentIdentities] }
          : { kind: "structural" as const, minimumEditableFields: surface.minimumEditableFields }
    };
  });

  const structural = declared.entries
    .map((entry) => entry.pageState.editSurface)
    .filter((surface): surface is Extract<typeof surface, { kind: "structural" }> => surface.kind === "structural");

  const commitActionLabels =
    structural.length > 0
      ? [...new Set(structural.flatMap((surface) => surface.commitActionLabels))]
      : [...DEFAULT_PAGE_STATE_POLICY.commitActionLabels];
  const dismissActionLabels =
    structural.length > 0
      ? [...new Set(structural.flatMap((surface) => surface.dismissActionLabels))]
      : [...DEFAULT_PAGE_STATE_POLICY.dismissActionLabels];

  return { patterns, commitActionLabels, dismissActionLabels };
}

/**
 * How this platform's entity identity is read, compiled from its pack.
 *
 * `undefined` when a platform declares nothing: identity is then
 * unobservable, and a binding that requires one refuses rather than
 * guessing. There is deliberately no generic fallback — inventing a
 * route shape for an unknown platform is exactly the kind of guess that
 * would put a write on the wrong record.
 */
export function entityIdentityPolicyForPlatform(
  platform: string,
  intelligence: PlatformIntelligenceProvider = defaultPlatformIntelligenceProvider
): EntityIdentityPolicy | undefined {
  const declared = intelligence.getEntityIdentity(platform);
  if (!declared) return undefined;
  return {
    routePattern: declared.entityIdentity.routePattern,
    trustworthyForMutation: declared.entityIdentity.trustworthyForMutation,
    routeTemplate: declared.entityIdentity.routeTemplate
  };
}

/**
 * How this platform's committed saves are verified, from its pack. The
 * conservative generic default applies when a pack declares nothing.
 */
export function verificationPolicyForPlatform(
  platform: string,
  intelligence: PlatformIntelligenceProvider = defaultPlatformIntelligenceProvider
): VerificationPolicy {
  const declared = intelligence.getVerificationSemantics(platform);
  if (!declared) return DEFAULT_VERIFICATION_POLICY;
  return {
    blockingValidationHoldsEditSurfaceOpen: declared.verification.blockingValidationHoldsEditSurfaceOpen,
    successNotificationMatchesAlertRole: declared.verification.successNotificationMatchesAlertRole,
    notificationComponentClasses: [...declared.verification.notificationComponentClasses],
    notificationRoles: [...declared.verification.notificationRoles]
  };
}

/** Which pack knowledge produced the policy in force, for execution evidence. */
export function resolutionProvenanceForPlatform(
  platform: string,
  intelligence: PlatformIntelligenceProvider = defaultPlatformIntelligenceProvider
): string | undefined {
  const declared = intelligence.getResolutionPolicy(platform);
  if (!declared) return undefined;
  const { packId, packVersion, knowledgeEntryIds } = declared.provenance;
  const pageState = intelligence.getPageStateSemantics(platform);
  const verification = intelligence.getVerificationSemantics(platform);
  const entryIds = [
    ...knowledgeEntryIds,
    ...(pageState?.provenance.knowledgeEntryIds ?? []),
    ...(verification?.provenance.knowledgeEntryIds ?? [])
  ];
  return `Resolution policy from ${packId}@${packVersion} (${entryIds.join(", ")}).`;
}

/**
 * The application knowledge available for a platform: what the vendor
 * ships, refined by whatever this installation knows about the tenant.
 *
 * The tenant source is a parameter rather than a lookup because who
 * supplies it differs by installation — a rep's own limited access, an
 * admin's central capture, or nothing at all. `emptyTenantIntelligence()`
 * is the honest default: no supported metadata path is installed today, so
 * the system says it knows nothing about this org and grounds fields from
 * standard knowledge and observed evidence alone.
 */
export function applicationIntelligenceForPlatform(
  platform: string,
  tenant: TenantIntelligenceSource = emptyTenantIntelligence(),
  intelligence: PlatformIntelligenceProvider = defaultPlatformIntelligenceProvider
): ApplicationIntelligence {
  const declared = intelligence.getApplicationSchema(platform);
  return {
    platform,
    ...(declared ? { standard: declared.schema } : {}),
    tenant
  };
}

/**
 * The adapter for a platform, already carrying its resolution policy.
 * `undefined` means "run with the generic engine alone" — a legitimate
 * choice, not a missing one.
 */
export function resolverAdapterForPlatform(
  platform: string,
  intelligence: PlatformIntelligenceProvider = defaultPlatformIntelligenceProvider
): PlatformResolverAdapter | undefined {
  const factory = ADAPTERS[platform];
  if (!factory) return undefined;
  const adapter = factory(
    pageStatePolicyForPlatform(platform, intelligence),
    verificationPolicyForPlatform(platform, intelligence),
    entityIdentityPolicyForPlatform(platform, intelligence)
  );
  return { ...adapter, resolutionPolicy: resolutionPolicyForPlatform(platform, intelligence) };
}
