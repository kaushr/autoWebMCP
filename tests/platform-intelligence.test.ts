import { describe, expect, it } from "vitest";
import {
  PLATFORM_INTELLIGENCE_SCHEMA_VERSION,
  assertPlatformIntelligencePack,
  defaultPlatformIntelligenceProvider,
  salesforceIntelligencePack,
  type DeterministicRuleEntry,
  type HeuristicEntry,
  type PolicyEntry
} from "../src/platformIntelligence";

describe("Platform Intelligence schema and Salesforce pack", () => {
  it("validates the hand-authored pack identity and version", () => {
    const pack = assertPlatformIntelligencePack(salesforceIntelligencePack);

    expect(pack.packId).toBe("salesforce-intelligence-pack");
    expect(pack.packVersion).toBe("0.2.0");
    expect(pack.schemaVersion).toBe(PLATFORM_INTELLIGENCE_SCHEMA_VERSION);
    expect(pack.platform.id).toBe("salesforce-lightning");
  });

  it("preserves epistemic strength and category as machine-readable fields", () => {
    const documented = salesforceIntelligencePack.knowledge.find(
      (entry) => entry.id === "sf-lwc-host-event-retargeting"
    );
    const heuristic = salesforceIntelligencePack.knowledge.find(
      (entry) => entry.id === "sf-recordui-update-record-suggests-record-update"
    );

    expect(documented?.category).toBe("observation-semantics");
    expect(documented?.strength).toBe("documented-fact");
    expect(heuristic?.category).toBe("binding-knowledge");
    expect(heuristic?.strength).toBe("heuristic");
  });

  it("retains source provenance for important assertions", () => {
    const entry = salesforceIntelligencePack.knowledge.find((item) => item.id === "sf-no-aura-replay");
    expect(entry?.sourceReferenceIds).toEqual(["awmcp-platform-intelligence", "awmcp-binding-decisions"]);

    const references = defaultPlatformIntelligenceProvider.getReferences(
      "salesforce-lightning",
      entry?.sourceReferenceIds ?? []
    );
    expect(references.map((reference) => reference.id)).toEqual([
      "awmcp-platform-intelligence",
      "awmcp-binding-decisions"
    ]);
  });

  it("keeps deterministic policies distinguishable from heuristics", () => {
    const deterministic = salesforceIntelligencePack.knowledge.filter(
      (entry): entry is DeterministicRuleEntry | PolicyEntry =>
        entry.category === "deterministic-rule" || entry.category === "policy"
    );
    const heuristics = salesforceIntelligencePack.knowledge.filter(
      (entry): entry is HeuristicEntry => entry.category === "heuristic"
    );

    expect(deterministic.every((entry) => ["documented-policy", "validated-platform-rule"].includes(entry.strength))).toBe(
      true
    );
    expect(heuristics.every((entry) => entry.strength === "heuristic")).toBe(true);
  });
});

describe("PlatformIntelligenceProvider", () => {
  it("resolves Salesforce to the versioned pack", () => {
    const pack = defaultPlatformIntelligenceProvider.getPack("salesforce-lightning");
    expect(pack?.packId).toBe("salesforce-intelligence-pack");
    expect(pack?.packVersion).toBe("0.2.0");
  });

  it("returns undefined or empty slices for unknown platforms", () => {
    expect(defaultPlatformIntelligenceProvider.getPack("generic")).toBeUndefined();
    expect(defaultPlatformIntelligenceProvider.getObservationSemantics("generic")).toEqual([]);
    expect(defaultPlatformIntelligenceProvider.getSupportedInterfaces("generic")).toEqual([]);
    expect(defaultPlatformIntelligenceProvider.getBindingPolicy("generic")).toBeUndefined();
  });

  it("returns narrow observation semantics without binding mechanisms", () => {
    const semantics = defaultPlatformIntelligenceProvider.getObservationSemantics("salesforce-lightning");

    expect(semantics.map((entry) => entry.id)).toContain("sf-lwc-host-event-retargeting");
    expect(semantics.some((entry) => entry.category === "binding-knowledge")).toBe(false);
    expect(semantics.some((entry) => entry.category === "supported-interface")).toBe(false);
  });

  it("exposes supported interfaces as a catalog", () => {
    const interfaces = defaultPlatformIntelligenceProvider.getSupportedInterfaces("salesforce-lightning", {
      family: "salesforce-record-update"
    });

    expect(interfaces.map((entry) => entry.interface.id)).toEqual([
      "salesforce-lds-ui-api",
      "salesforce-rest-record-api"
    ]);
    expect(interfaces.every((entry) => entry.strength === "documented-fact")).toBe(true);
  });

  it("returns pack-backed binding policy with provenance for Aura record updates", () => {
    const policy = defaultPlatformIntelligenceProvider.getBindingPolicy("salesforce-lightning", {
      method: "POST",
      pathPattern: "/aura?aura.RecordUi.updateRecord,r",
      origin: "https://acme.lightning.force.com",
      status: 200
    });

    expect(policy?.transportClass).toBe("private-internal");
    expect(policy?.maximumEligibility).toBe("needs-validation");
    expect(policy?.preferredBindingFamily).toBe("salesforce-record-update");
    expect(policy?.provenance.packId).toBe("salesforce-intelligence-pack");
    expect(policy?.provenance.knowledgeEntryIds).toContain("sf-aura-private-internal");
    expect(policy?.provenance.knowledgeEntryIds).toContain("sf-recordui-update-record-suggests-record-update");
    expect(policy?.provenance.sourceReferenceIds).toContain("sf-ui-record-api");
  });
});
