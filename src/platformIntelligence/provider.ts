import type { BindingEligibility } from "../binding/model";
import type { TransportObservation } from "../binding/policy";
import type {
  AntiPatternEntry,
  BindingKnowledgeEntry,
  DeterministicRuleEntry,
  KnowledgeEntry,
  PlatformIntelligencePack,
  PlatformIntelligenceTrace,
  PolicyEntry,
  SourceReference,
  SupportedInterfaceEntry
} from "./schema";
import { assertPlatformIntelligencePack, traceFor } from "./schema";

export interface BindingPolicyIntelligence {
  platform: string;
  transportClass?: DeterministicRuleEntry["rule"]["transportClass"];
  maximumEligibility?: BindingEligibility;
  preferredBindingFamily?: string;
  notes: string[];
  warnings: string[];
  validationRequired: string[];
  provenance: PlatformIntelligenceTrace;
}

export interface SupportedInterfaceQuery {
  family?: string;
}

export interface PlatformIntelligenceProvider {
  getPack(platformId: string): PlatformIntelligencePack | undefined;
  getObservationSemantics(platformId: string): KnowledgeEntry[];
  getSupportedInterfaces(platformId: string, query?: SupportedInterfaceQuery): SupportedInterfaceEntry[];
  getBindingKnowledge(platformId: string, transport?: TransportObservation): BindingKnowledgeEntry[];
  getBindingPolicy(platformId: string, transport?: TransportObservation): BindingPolicyIntelligence | undefined;
  getReferences(platformId: string, sourceReferenceIds?: readonly string[]): SourceReference[];
}

const DETERMINISTIC_STRENGTHS = new Set(["documented-policy", "validated-platform-rule"]);

function active(entries: readonly KnowledgeEntry[]): KnowledgeEntry[] {
  return entries.filter((entry) => entry.lifecycle?.status !== "deprecated");
}

function transportMatches(entry: KnowledgeEntry, transport: TransportObservation | undefined): boolean {
  const matcher = "transport" in entry ? entry.transport : undefined;
  if (!matcher) return true;
  if (!transport) return false;
  if (matcher.method && matcher.method.toUpperCase() !== transport.method.toUpperCase()) return false;
  if (matcher.pathPattern && !matcher.pathPattern.test(transport.pathPattern)) return false;
  if (matcher.operationPattern && !matcher.operationPattern.test(transport.pathPattern)) return false;
  return true;
}

function isDeterministicEntry(entry: KnowledgeEntry): entry is DeterministicRuleEntry | PolicyEntry {
  return (
    (entry.category === "deterministic-rule" || entry.category === "policy") &&
    DETERMINISTIC_STRENGTHS.has(entry.strength)
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function createPlatformIntelligenceProvider(
  packs: readonly PlatformIntelligencePack[]
): PlatformIntelligenceProvider {
  const byPlatform = new Map<string, PlatformIntelligencePack>();
  for (const pack of packs.map(assertPlatformIntelligencePack)) byPlatform.set(pack.platform.id, pack);

  return {
    getPack(platformId) {
      return byPlatform.get(platformId);
    },

    getObservationSemantics(platformId) {
      const pack = byPlatform.get(platformId);
      if (!pack) return [];
      return active(pack.knowledge).filter(
        (entry) => entry.category === "observation-semantics" || entry.category === "component-framework-behavior"
      );
    },

    getSupportedInterfaces(platformId, query = {}) {
      const pack = byPlatform.get(platformId);
      if (!pack) return [];
      return active(pack.knowledge).filter(
        (entry): entry is SupportedInterfaceEntry =>
          entry.category === "supported-interface" &&
          (!query.family || entry.interface.family === query.family || entry.interface.operationFamilies.includes(query.family))
      );
    },

    getBindingKnowledge(platformId, transport) {
      const pack = byPlatform.get(platformId);
      if (!pack) return [];
      return active(pack.knowledge).filter(
        (entry): entry is BindingKnowledgeEntry => entry.category === "binding-knowledge" && transportMatches(entry, transport)
      );
    },

    getBindingPolicy(platformId, transport) {
      const pack = byPlatform.get(platformId);
      if (!pack) return undefined;

      const entries = active(pack.knowledge);
      const matched = entries.filter((entry) => transportMatches(entry, transport));
      const deterministic = matched.filter(isDeterministicEntry);
      const bindingKnowledge = matched.filter((entry): entry is BindingKnowledgeEntry => entry.category === "binding-knowledge");
      const antiPatterns = matched.filter((entry): entry is AntiPatternEntry => entry.category === "anti-pattern");
      const contextEntries = matched.filter(
        (entry) =>
          entry.category === "execution-semantics" ||
          entry.category === "observation-semantics" ||
          entry.category === "heuristic" ||
          entry.category === "supported-interface"
      );

      const ruleEntries = deterministic.filter((entry): entry is DeterministicRuleEntry => entry.category === "deterministic-rule");
      const policyEntries = deterministic.filter((entry): entry is PolicyEntry => entry.category === "policy");
      const relevantEntries = [...ruleEntries, ...policyEntries, ...bindingKnowledge, ...antiPatterns, ...contextEntries];
      if (relevantEntries.length === 0) return undefined;

      return {
        platform: platformId,
        transportClass: ruleEntries.find((entry) => entry.rule.transportClass)?.rule.transportClass,
        maximumEligibility: ruleEntries.find((entry) => entry.rule.maximumEligibility)?.rule.maximumEligibility,
        preferredBindingFamily: bindingKnowledge[0]?.binding.preferredBindingFamily,
        notes: unique([...contextEntries.map((entry) => entry.summary), ...bindingKnowledge.map((entry) => entry.summary)]),
        warnings: unique([
          ...policyEntries.map((entry) => entry.policy.warning),
          ...antiPatterns.map((entry) => entry.antiPattern.warning)
        ]),
        validationRequired: unique([
          ...policyEntries.flatMap((entry) => entry.policy.validationRequired ?? []),
          ...bindingKnowledge.flatMap((entry) => entry.binding.validationRequired)
        ]),
        provenance: traceFor(pack, relevantEntries)
      };
    },

    getReferences(platformId, sourceReferenceIds) {
      const pack = byPlatform.get(platformId);
      if (!pack) return [];
      if (!sourceReferenceIds) return [...pack.sourceReferences];
      const wanted = new Set(sourceReferenceIds);
      return pack.sourceReferences.filter((source) => wanted.has(source.id));
    }
  };
}
