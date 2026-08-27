import type { BindingEligibility } from "../binding/model";
import type { TransportClass } from "../binding/policy";

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

export type KnowledgeEntry =
  | DocumentedFactEntry
  | ObservationSemanticsEntry
  | ExecutionSemanticsEntry
  | DeterministicRuleEntry
  | PolicyEntry
  | HeuristicEntry
  | SupportedInterfaceEntry
  | ComponentFrameworkBehaviorEntry
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
