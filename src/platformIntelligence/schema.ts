import type { BindingEligibility } from "../binding/model";
import type { TransportClass } from "../binding/policy";
import type { StandardApplicationSchema } from "../applicationIntelligence/model";

export const PLATFORM_INTELLIGENCE_SCHEMA_VERSION = "0.1";

export type EpistemicStrength =
  | "documented-fact"
  | "documented-policy"
  | "validated-platform-rule"
  | "heuristic"
  | "observed-pattern"
  | "experimental";

export type KnowledgeCategory =
  | "documented-fact"
  | "observation-semantics"
  | "execution-semantics"
  | "deterministic-rule"
  | "policy"
  | "heuristic"
  | "supported-interface"
  | "component-framework-behavior"
  | "resolution-policy"
  | "page-state-semantics"
  | "entity-identity"
  | "verification-semantics"
  | "application-schema"
  | "binding-knowledge"
  | "anti-pattern"
  | "reference";

export type SourceReferenceKind = "official-doc" | "internal-architecture" | "internal-evidence";

export interface PlatformIdentity {
  id: string;
  label: string;
  vendor?: string;
}

export interface SourceReference {
  id: string;
  kind: SourceReferenceKind;
  title: string;
  url?: string;
  document?: string;
  retrievedAt?: string;
  reviewedAt?: string;
  note?: string;
}

export interface KnowledgeLifecycle {
  status: "active" | "deprecated";
  since?: string;
  deprecatedAt?: string;
  replacementId?: string;
  reason?: string;
}

export interface TransportMatcher {
  method?: string;
  pathPattern?: RegExp;
  operationPattern?: RegExp;
}

export interface KnowledgeEntryBase {
  id: string;
  category: KnowledgeCategory;
  strength: EpistemicStrength;
  summary: string;
  sourceReferenceIds: string[];
  lifecycle?: KnowledgeLifecycle;
  tags?: string[];
}

export interface DocumentedFactEntry extends KnowledgeEntryBase {
  category: "documented-fact";
}

export interface ObservationSemanticsEntry extends KnowledgeEntryBase {
  category: "observation-semantics";
  appliesTo: "events" | "values" | "dom" | "network" | "records";
}

export interface ExecutionSemanticsEntry extends KnowledgeEntryBase {
  category: "execution-semantics";
  transport?: TransportMatcher;
}

export interface DeterministicRuleEntry extends KnowledgeEntryBase {
  category: "deterministic-rule";
  strength: "documented-policy" | "validated-platform-rule";
  rule: {
    id: string;
    when: string;
    effect: "cap-eligibility" | "classify-transport" | "prohibit-direct-replay" | "require-validation";
    transportClass?: TransportClass;
    maximumEligibility?: BindingEligibility;
  };
  transport?: TransportMatcher;
}

export interface PolicyEntry extends KnowledgeEntryBase {
  category: "policy";
  strength: "documented-policy" | "validated-platform-rule";
  policy: {
    id: string;
    effect: "prohibit-direct-replay" | "prohibit-credential-extraction" | "require-validation";
    warning: string;
    validationRequired?: string[];
  };
  transport?: TransportMatcher;
}

export interface HeuristicEntry extends KnowledgeEntryBase {
  category: "heuristic";
  transport?: TransportMatcher;
}

export interface SupportedInterfaceEntry extends KnowledgeEntryBase {
  category: "supported-interface";
  interface: {
    id: string;
    family: string;
    label: string;
    status: "supported";
    operationFamilies: string[];
    notes: string[];
  };
}

export interface ComponentFrameworkBehaviorEntry extends KnowledgeEntryBase {
  category: "component-framework-behavior";
  appliesTo: "events" | "shadow-dom" | "forms" | "selectors" | "routing";
}

/**
 * How a platform's UI must be traversed and identified at execution time.
 *
 * The runtime-actionable counterpart to `component-framework-behavior`:
 * that category *states* that Lightning hides native controls behind
 * component boundaries, and this one says what a resolver must therefore
 * *do* about it. Deterministic and declarative — a browser runtime reads
 * it once and applies it mechanically; no model is consulted for a DOM
 * lookup. Kept as knowledge here, compiled to mechanism at the
 * composition root, exactly like every other pack entry.
 */
export interface ResolutionPolicyEntry extends KnowledgeEntryBase {
  category: "resolution-policy";
  strength: "documented-fact" | "documented-policy" | "validated-platform-rule";
  resolution: {
    traversal: "flat-dom" | "composed-tree";
    shadowRoots: "ignore" | "recursive";
    eventRetargeting: boolean;
    /** Ordered strongest-first; a resolver uses the first signal that disambiguates. */
    identityPriority: Array<"applicationIdentifier" | "accessibleName" | "section">;
  };
}

export interface BindingKnowledgeEntry extends KnowledgeEntryBase {
  category: "binding-knowledge";
  binding: {
    observedOperationPattern?: RegExp;
    preferredBindingFamily: string;
    eligibilityCeiling: BindingEligibility;
    mechanism: string;
    validationRequired: string[];
  };
  transport?: TransportMatcher;
}

export interface AntiPatternEntry extends KnowledgeEntryBase {
  category: "anti-pattern";
  antiPattern: {
    id: string;
    prohibited: boolean;
    warning: string;
  };
  transport?: TransportMatcher;
}

export interface ReferenceEntry extends KnowledgeEntryBase {
  category: "reference";
}

/**
 * What establishes that a record is genuinely being edited on this platform,
 * as opposed to merely showing some dialog.
 *
 * Exists because a live Salesforce run proved the distinction matters: a
 * Lightning record page carries visible dialog-role surfaces (docked
 * utility bar, panels) while in plain read-only view, and an executor that
 * read "visible dialog" as "record edit mode" skipped entering edit mode
 * entirely. Like `resolution-policy`, this is declarative knowledge a
 * runtime compiles once and applies mechanically — element identities and
 * evidence thresholds, never DOM operations or selector chains.
 *
 * One entry declares exactly one independently-provenanced *pattern* for
 * recognizing record-edit, not the whole rule. A platform commonly declares
 * more than one: a documented component identity is one way to recognize
 * an edit surface, a structural signature (enough editable fields plus a
 * commit action) is a different kind of evidence entirely, and the two do
 * not have to share a strength. Collapsing every pattern into one flat
 * evidence bundle was tried first and failed a live case: a genuine,
 * 16-field Salesforce edit form matched neither the declared component
 * tags nor a generic dialog role, so it never even reached this knowledge
 * — the observation layer had already decided, on its own, what counted
 * as a candidate surface. Each pattern here is evaluated against
 * observations the generic engine already made, never the other way
 * around.
 */
/**
 * How a platform exposes the identity of the entity currently on screen.
 *
 * Platform knowledge, deliberately, not application knowledge: "a Lightning
 * record page carries its object and record id in the route" is true of
 * every object Salesforce ships, while "an Opportunity's identity parameter
 * is called opportunity_id" belongs to the application layer. Keeping the
 * split means the generic engine can ask "what entity is open?" without
 * knowing what a Salesforce record id looks like.
 *
 * `routePattern` is a regular expression over the page path with two named
 * groups, `entity` and `id`. A pattern rather than code so that a platform's
 * routing is declared, versioned and provenanced like every other fact here
 * — and so a second platform needs a pack entry, not an engine change.
 */
export interface EntityIdentityEntry extends KnowledgeEntryBase {
  category: "entity-identity";
  entityIdentity: {
    /**
     * Identifies the record a path refers to, INCLUDING sub-pages of it.
     * Must contain a named group `id` and may contain one named `entity`.
     */
    routePattern: string;
    /**
     * Identifies a path that is the record's OWN page, and not something
     * beneath it. A live page linked `/lightning/r/<id>/related/Products/view`,
     * which is a valid identity for "which record am I on" and emphatically
     * not a search result for it.
     */
    canonicalRoutePattern: string;
    /**
     * Entity type per identifier prefix, for routes that omit the object.
     *
     * Salesforce emits both `/lightning/r/Opportunity/<id>/view` and
     * `/lightning/r/<id>/view`; list and search results use the second, so
     * a link's type has to come from the identifier itself. Standard
     * prefixes are vendor-stable, which is what makes this platform
     * knowledge — a custom object's prefix is assigned per org and is not
     * declared here.
     */
    identifierPrefixes?: Record<string, string>;
    /**
     * Whether an identity read from the route is stable enough to gate a
     * write on. False would mean "observable, but do not trust it alone".
     */
    trustworthyForMutation: boolean;
    /**
     * How a caller would navigate to one, as a path template using `{entity}`
     * and `{id}`. Declared even though V0.1 does not navigate, because the
     * refusal message can then say what navigating WOULD look like.
     */
    routeTemplate: string;
  };
}

export interface PageStateSemanticsEntry extends KnowledgeEntryBase {
  category: "page-state-semantics";
  pageState: {
    /** A generic visible dialog must never, alone, be read as record-edit. */
    genericDialogIsNotEditEvidence: true;
    editSurface:
      | {
          kind: "component-identity";
          /** Tag names that themselves signify this platform's record-edit component. */
          componentIdentities: string[];
        }
      | {
          kind: "structural";
          /** At least this many editable fields inside the surface… */
          minimumEditableFields: number;
          /** …together with a commit action carrying one of these accessible labels. */
          commitActionLabels: string[];
          /** Supporting (never sufficient) evidence: a dismiss action with one of these labels. */
          dismissActionLabels: string[];
        };
  };
}

/**
 * How a committed save is verified on this platform — specifically, what
 * distinguishes a blocking validation error from the platform's own success
 * notification.
 *
 * Twice-observed evidence behind it: Salesforce's post-save notification
 * satisfies generic alert semantics (`role="alert"`), so the original Teach
 * capture flagged "validation message shown" and "confirmation toast shown"
 * on the same successful human save, and a live executed save that
 * ground-truth succeeded was misreported as failed by a document-wide alert
 * sweep. Meanwhile a genuinely blocking validation was observed to hold the
 * record-edit surface open with the error rendered inside it.
 */
export interface VerificationSemanticsEntry extends KnowledgeEntryBase {
  category: "verification-semantics";
  strength: "documented-fact" | "documented-policy" | "validated-platform-rule";
  verification: {
    /** A validation error that blocks a save keeps the record-edit surface open. */
    blockingValidationHoldsEditSurfaceOpen: boolean;
    /** The platform's success notification may itself carry `role="alert"`. */
    successNotificationMatchesAlertRole: boolean;
    /** Component identities (class names) of notification/toast regions — never validation evidence. */
    notificationComponentClasses: string[];
    /** ARIA roles that identify notification regions. */
    notificationRoles: string[];
  };
}

/**
 * What the vendor's application ships with in a given release — the
 * standard business object model, not platform behaviour.
 *
 * The distinction is the point. "Lightning retargets events across shadow
 * boundaries" is how the *platform* behaves and belongs to
 * `component-framework-behavior`. "Opportunity has a picklist field
 * `StageName` labelled Stage" is what the *application* is, and no amount
 * of platform knowledge implies it. A live capture proved the gap: the
 * platform layer correctly reported that a Lightning picklist host exposes
 * no native name, and nothing could say what the field was.
 *
 * `release` makes this refutable: vendor application shape evolves, and
 * knowledge that cannot be dated cannot be retired. A tenant's own
 * configuration refines what is declared here — see
 * `applicationIntelligence/model.ts` — but tenant knowledge is never
 * carried in a pack, because a pack is shared across every org.
 */
export interface ApplicationSchemaEntry extends KnowledgeEntryBase {
  category: "application-schema";
  strength: "documented-fact";
  applicationSchema: StandardApplicationSchema;
}

export type KnowledgeEntry =
  | DocumentedFactEntry
  | ObservationSemanticsEntry
  | ExecutionSemanticsEntry
  | DeterministicRuleEntry
  | PolicyEntry
  | HeuristicEntry
  | SupportedInterfaceEntry
  | ComponentFrameworkBehaviorEntry
  | ResolutionPolicyEntry
  | PageStateSemanticsEntry
  | EntityIdentityEntry
  | VerificationSemanticsEntry
  | ApplicationSchemaEntry
  | BindingKnowledgeEntry
  | AntiPatternEntry
  | ReferenceEntry;

export interface PlatformIntelligencePack {
  packId: string;
  packVersion: string;
  schemaVersion: typeof PLATFORM_INTELLIGENCE_SCHEMA_VERSION;
  platform: PlatformIdentity;
  sourceReferences: SourceReference[];
  knowledge: KnowledgeEntry[];
}

export interface PlatformIntelligenceTrace {
  packId: string;
  packVersion: string;
  schemaVersion: string;
  knowledgeEntryIds: string[];
  sourceReferenceIds: string[];
}

export function traceFor(pack: PlatformIntelligencePack, entries: readonly KnowledgeEntry[]): PlatformIntelligenceTrace {
  return {
    packId: pack.packId,
    packVersion: pack.packVersion,
    schemaVersion: pack.schemaVersion,
    knowledgeEntryIds: [...new Set(entries.map((entry) => entry.id))],
    sourceReferenceIds: [...new Set(entries.flatMap((entry) => entry.sourceReferenceIds))]
  };
}

function expectString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
}

export function assertPlatformIntelligencePack(pack: PlatformIntelligencePack): PlatformIntelligencePack {
  expectString(pack.packId, "packId");
  expectString(pack.packVersion, "packVersion");
  if (pack.schemaVersion !== PLATFORM_INTELLIGENCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported platform intelligence schema version ${pack.schemaVersion}.`);
  }
  expectString(pack.platform.id, "platform.id");
  expectString(pack.platform.label, "platform.label");

  const sourceIds = new Set<string>();
  for (const source of pack.sourceReferences) {
    expectString(source.id, "sourceReference.id");
    if (sourceIds.has(source.id)) throw new Error(`Duplicate source reference ${source.id}.`);
    sourceIds.add(source.id);
  }

  const entryIds = new Set<string>();
  for (const entry of pack.knowledge) {
    expectString(entry.id, "knowledge.id");
    if (entryIds.has(entry.id)) throw new Error(`Duplicate knowledge entry ${entry.id}.`);
    entryIds.add(entry.id);
    if (entry.sourceReferenceIds.length === 0) {
      throw new Error(`Knowledge entry ${entry.id} must carry source provenance.`);
    }
    for (const sourceId of entry.sourceReferenceIds) {
      if (!sourceIds.has(sourceId)) throw new Error(`Knowledge entry ${entry.id} references unknown source ${sourceId}.`);
    }
    if (
      (entry.category === "deterministic-rule" || entry.category === "policy") &&
      entry.strength !== "documented-policy" &&
      entry.strength !== "validated-platform-rule"
    ) {
      throw new Error(`Deterministic entry ${entry.id} must use policy or validated-rule strength.`);
    }
  }

  return pack;
}
