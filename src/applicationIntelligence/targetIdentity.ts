import { defaultPlatformIntelligenceProvider, type PlatformIntelligenceProvider } from "../platformIntelligence";

/* ------------------------------------------------------------------ *
 * The identity an operation on an existing entity must name.
 *
 * Two layers meet here, and neither could answer alone:
 *
 *   PLATFORM   "entities on this platform have stable identities, and a
 *              page exposes which one it is showing"
 *   APPLICATION "this capability acts on the Opportunity object"
 *
 * Together they produce a requirement — `opportunity_id` — that no human
 * demonstrated. That is the point: the human taught which FIELDS to change,
 * and the system contributes which RECORD to change them on, because an
 * agent cannot be trusted to mean "whichever one happens to be open".
 *
 * The naming convention lives here rather than in a pack because it is
 * agent-facing vocabulary, not platform behaviour: `<entity>_id` reads the
 * same way for an Opportunity, a Jira issue, or a customer, and a platform
 * needing something else would declare it rather than have this guessed.
 * ------------------------------------------------------------------ */

export interface TargetIdentityRequirement {
  /** The agent-facing parameter, e.g. `opportunity_id`. */
  inputName: string;
  /** The entity type it identifies, e.g. `Opportunity`. */
  entityType: string;
  /** What to tell an agent, and a human reviewing the contract. */
  description: string;
}

/** `Opportunity` → `opportunity_id`; `Custom_Object__c` → `custom_object_id`. */
export function identityInputNameFor(entityType: string): string {
  const base = entityType
    // A vendor's custom-object suffix is noise in an agent-facing name.
    .replace(/__c$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
  return `${base}_id`;
}

/**
 * What identity, if any, this platform and entity require.
 *
 * `undefined` when the platform declares no identity scheme — the honest
 * answer for an application whose pages expose nothing stable, and one that
 * leaves the capability exactly as it was rather than inventing a parameter
 * nothing could ever verify.
 */
export function targetIdentityFor(
  platform: string | undefined,
  entityType: string | undefined,
  intelligence: PlatformIntelligenceProvider = defaultPlatformIntelligenceProvider
): TargetIdentityRequirement | undefined {
  if (!platform || !entityType) return undefined;
  const declared = intelligence.getEntityIdentity(platform);
  if (!declared?.entityIdentity.trustworthyForMutation) return undefined;

  return {
    inputName: identityInputNameFor(entityType),
    entityType,
    description:
      `Which ${entityType} to act on — the application's own record identity. ` +
      "Not a field on the record: it selects the record."
  };
}
