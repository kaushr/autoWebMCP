import { createPlatformIntelligenceProvider } from "./provider";
import { salesforceIntelligencePack } from "./packs/salesforce";

export { SALESFORCE_PLATFORM_ID, salesforceIntelligencePack } from "./packs/salesforce";
export type {
  BindingPolicyIntelligence,
  PlatformIntelligenceProvider,
  SupportedInterfaceQuery
} from "./provider";
export { createPlatformIntelligenceProvider } from "./provider";
export type {
  AntiPatternEntry,
  BindingKnowledgeEntry,
  DeterministicRuleEntry,
  EpistemicStrength,
  HeuristicEntry,
  KnowledgeCategory,
  KnowledgeEntry,
  PlatformIntelligencePack,
  PlatformIntelligenceTrace,
  PolicyEntry,
  SourceReference,
  SupportedInterfaceEntry
} from "./schema";
export { PLATFORM_INTELLIGENCE_SCHEMA_VERSION, assertPlatformIntelligencePack } from "./schema";

export const defaultPlatformIntelligenceProvider = createPlatformIntelligenceProvider([
  salesforceIntelligencePack
]);
