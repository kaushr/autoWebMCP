import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import { resolveFieldMapping } from "../src/binding/fieldMapping";
import { proposeBrowserBinding } from "../src/binding/browserExecution/propose";
import { applicationIntelligenceForPlatform } from "../src/binding/browserExecution/adapters";
import { emptyTenantIntelligence, tenantIntelligenceFrom } from "../src/applicationIntelligence/tenant";
import { defaultPlatformIntelligenceProvider } from "../src/platformIntelligence";
import { buildTestFormFields } from "../src/training/executionTestForm";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { FieldClarification, TenantIntelligenceSnapshot } from "../src/applicationIntelligence/model";
import type { CaptureEvent } from "../src/capture/types";
import type { ObservationTrace } from "../src/capture/normalize";
import type { CapabilityInput, SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * Missing knowledge is a need, not a failure.
 *
 * The Stage case exposed the gap: the system knew the object, the label,
 * that a change had been observed, and precisely which fact it lacked —
 * and still reported nothing but "no binding". These cases pin the
 * distinction between the outcomes, and the rule that a human is asked
 * only for the residual unknown.
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";
const SALESFORCE = sourceApplicationFor(PLATFORM, "nvent-dev-ed.lightning.force.com");
const page = { host: "nvent-dev-ed.lightning.force.com", path: "/lightning/r/Opportunity/006/view" };

const STANDARD_ONLY = applicationIntelligenceForPlatform(PLATFORM, emptyTenantIntelligence());
const NO_KNOWLEDGE = { platform: PLATFORM };

function traceOf(events: CaptureEvent[]): ObservationTrace {
  const session = new CaptureSession("sess-epistemic", 0, {
    host: page.host,
    platform: PLATFORM,
    title: "PS Project Test | Opportunity"
  });
  session.addMany([{ id: "nav", kind: "navigate", t: 100, page }, ...events, { id: "save", kind: "click", t: 9_000, page, actionLabel: "Save" }]);
  session.stop(10_000);
  return session.toTrace();
}

function fieldChange(id: string, label: string, name?: string): CaptureEvent {
  return {
    id,
    kind: "field_change",
    t: 2_000,
    page,
    element: { tag: "lightning-combobox", ...(name ? { name } : {}), label },
    field: { label, section: "Opportunity Details", control: "other" },
    value: { masked: false }
  } as CaptureEvent;
}

function capabilityWith(inputs: CapabilityInput[]): SemanticCapability {
  return {
    id: "update_opportunity",
    name: "Update opportunity",
    description: "Change an opportunity field and save.",
    inputs,
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true }
  };
}

const STAGE: CapabilityInput = { name: "stage", description: "stage", type: "string", required: true };
const REGION: CapabilityInput = {
  name: "implementation_region",
  description: "implementation_region",
  type: "string",
  required: true
};

const STAGE_TRACE = traceOf([fieldChange("stage", "*Stage")]);
const REGION_TRACE = traceOf([fieldChange("region", "*Implementation Region")]);

function tenantWith(fields: TenantIntelligenceSnapshot["objects"][number]["fields"]) {
  return applicationIntelligenceForPlatform(
    PLATFORM,
    tenantIntelligenceFrom({
      platform: PLATFORM,
      orgId: "00Dxx0000000000",
      capturedAt: "2026-08-27T09:00:00.000Z",
      mechanism: "injected-snapshot",
      objects: [{ apiName: "Opportunity", fields }]
    })
  );
}

/* ------------------- knowledge first, human last ------------------- */

describe("1–4 — a human is never asked for what knowledge already answers", () => {
  it("1 — tenant intelligence resolves Stage, and asks nothing", () => {
    const result = resolveFieldMapping(
      capabilityWith([STAGE]),
      STAGE_TRACE,
      tenantWith([{ apiName: "StageName", label: "Stage", type: "picklist", options: ["Closed Won"] }])
    );
    expect(result.mapping).toEqual({ stage: "StageName" });
    expect(result.statuses.stage).toBe("resolved");
    expect(result.needs).toEqual([]);
  });

  it("2 — a tenant custom field resolves, and asks nothing", () => {
    const result = resolveFieldMapping(
      capabilityWith([REGION]),
      REGION_TRACE,
      tenantWith([
        { apiName: "Implementation_Region__c", label: "Implementation Region", type: "picklist", options: ["EMEA"], custom: true }
      ])
    );
    expect(result.mapping).toEqual({ implementation_region: "Implementation_Region__c" });
    expect(result.needs).toEqual([]);
  });

  it("3 — tenant-configured values become the domain, with no question", () => {
    const capability = capabilityWith([STAGE]);
    const intelligence = tenantWith([
      { apiName: "StageName", label: "Stage", type: "picklist", options: ["Qualify", "Closed Won"] }
    ]);
    const proposal = proposeBrowserBinding(capability, STAGE_TRACE, intelligence);
    expect(proposal.needs ?? []).toEqual([]);
    const stage = buildTestFormFields(capability, proposal.binding!)[0];
    expect(stage.control).toBe("select");
    expect(stage.options).toEqual(["Qualify", "Closed Won"]);
  });

  it("4 — with no tenant metadata, standard knowledge resolves Stage and still asks nothing blocking", () => {
    const result = resolveFieldMapping(capabilityWith([STAGE]), STAGE_TRACE, STANDARD_ONLY);
    expect(result.mapping).toEqual({ stage: "StageName" });
    expect(result.statuses.stage).toBe("resolved");
    expect(result.needs.filter((need) => need.blocking)).toEqual([]);
  });

  it("11 — clarifications already given are ignored while knowledge can answer", () => {
    // A human answer exists, but tenant metadata knows the field. The
    // tenant's account wins and the human is not consulted.
    const clarifications: FieldClarification[] = [
      { platform: PLATFORM, objectApiName: "Opportunity", observedLabel: "Stage", apiName: "StageName", source: "human-confirmed", scope: "capability" }
    ];
    const intelligence = {
      ...tenantWith([{ apiName: "StageName", label: "Stage", type: "picklist", options: ["Closed Won"] }]),
      clarifications
    };
    const result = resolveFieldMapping(capabilityWith([STAGE]), STAGE_TRACE, intelligence);
    expect(result.grounding.stage.knowledge).toBe("tenant");
  });
});

/* ----------------------- needs information ----------------------- */

describe("5 & 2 — an unresolvable field becomes a question, not a null", () => {
  const result = resolveFieldMapping(capabilityWith([REGION]), REGION_TRACE, STANDARD_ONLY);

  it("5 — status is needs-information rather than a bare failure", () => {
    expect(result.mapping).toEqual({});
    expect(result.statuses.implementation_region).toBe("needs-information");
    expect(result.needs).toHaveLength(1);
  });

  it("2 — the question names the residual unknown, and only that", () => {
    const need = result.needs[0];
    expect(need.kind).toBe("field-api-name");
    expect(need.question).toMatch(/API name/i);
    expect(need.question).toMatch(/Implementation Region/);
    expect(need.blocking).toBe(true);
  });

  it("3 — everything already established travels with the need", () => {
    const need = result.needs[0];
    expect(need.knownEvidence).toMatchObject({
      inputName: "implementation_region",
      platform: PLATFORM,
      objectApiName: "Opportunity",
      observedLabel: "Implementation Region"
    });
    // The reason says a single answer is enough — not that setup is required.
    expect(need.reason).toMatch(/One answer unblocks this capability/i);
    expect(need.resolutionSources).toContain("human");
  });

  it("the proposal carries the need, so the Studio can ask instead of shrugging", () => {
    const proposal = proposeBrowserBinding(capabilityWith([REGION]), REGION_TRACE, STANDARD_ONLY);
    expect(proposal.binding).toBeNull();
    expect(proposal.needs?.[0].kind).toBe("field-api-name");
  });
});

describe("6–9 — a human answer feeds back into resolution", () => {
  const answer: FieldClarification[] = [
    {
      platform: PLATFORM,
      objectApiName: "Opportunity",
      observedLabel: "Implementation Region",
      apiName: "Implementation_Region__c",
      source: "human-confirmed",
      answeredAt: "2026-08-27T10:00:00.000Z",
      scope: "capability"
    }
  ];

  it("9 — re-running resolution with the answer resolves the field", () => {
    const result = resolveFieldMapping(capabilityWith([REGION]), REGION_TRACE, { ...STANDARD_ONLY, clarifications: answer });
    expect(result.mapping).toEqual({ implementation_region: "Implementation_Region__c" });
    expect(result.statuses.implementation_region).toBe("resolved");
    expect(result.needs.filter((need) => need.blocking)).toEqual([]);
  });

  it("8 & 12 — the answer keeps human provenance and is never promoted to vendor truth", () => {
    const result = resolveFieldMapping(capabilityWith([REGION]), REGION_TRACE, { ...STANDARD_ONLY, clarifications: answer });
    expect(result.grounding.implementation_region.knowledge).toBe("human-confirmed");
    expect(result.grounding.implementation_region.release).toBeUndefined();
    expect(result.grounding.implementation_region.detail).toMatch(/supplied by a human/i);
  });

  it("7 — a typed answer and a confirmed suggestion are the same kind of fact", () => {
    // Both paths produce a FieldClarification; nothing distinguishes an
    // accepted suggestion from a typed one once recorded, which is why a
    // suggestion is only a suggestion until a person accepts it.
    const proposal = proposeBrowserBinding(capabilityWith([REGION]), REGION_TRACE, { ...STANDARD_ONLY, clarifications: answer });
    expect(proposal.binding?.inputs[0].applicationField).toMatchObject({
      apiName: "Implementation_Region__c",
      knowledge: "human-confirmed"
    });
    // Not dressed up as vendor knowledge: no release is claimed for it.
    expect(proposal.binding?.inputs[0].applicationField?.release).toBeUndefined();
  });

  it("10 — with no tenant metadata, a human may name a field the vendor default does not ship", () => {
    // Standard knowledge describes how Salesforce ships, not how this org
    // is configured, so this is not a contradiction — it is a person
    // telling us their org is customized. Marked unverified, not accepted
    // as vendor truth. Tenant-backed contradiction is covered separately in
    // tests/intent-disambiguation.test.ts.
    const contradicting: FieldClarification[] = [
      { platform: PLATFORM, objectApiName: "Opportunity", observedLabel: "Stage", apiName: "Custom_Stage__c", source: "human-confirmed", scope: "capability" }
    ];
    const result = resolveFieldMapping(capabilityWith([STAGE]), STAGE_TRACE, { ...STANDARD_ONLY, clarifications: contradicting });
    expect(result.mapping).toEqual({ stage: "Custom_Stage__c" });
    expect(result.grounding.stage.tenantUnverified).toBe(true);
    expect(result.grounding.stage.detail).toMatch(/Tenant metadata has not verified this/i);
  });
});

/* ------------------------- the other outcomes ------------------------- */

describe("11 & 12 & 13 — the outcomes stay distinct", () => {
  it("11 — two plausible fields produce a choice, never a guess", () => {
    const ambiguous = traceOf([fieldChange("a", "*Status", "StageName"), fieldChange("b", "*Status", "Support_Status__c")]);
    const result = resolveFieldMapping(
      capabilityWith([{ name: "status", description: "status", type: "string", required: true }]),
      ambiguous,
      STANDARD_ONLY
    );
    expect(result.statuses.status).toBe("ambiguous");
    expect(result.needs[0].kind).toBe("field-choice");
    expect(result.needs[0].suggestedAnswers?.length).toBe(2);
    expect(result.mapping).toEqual({});
  });

  it("12 — needs-setup is a different thing from needs-information, and does not block", () => {
    // Stage resolves; only its value domain is missing, and no answer a
    // person can type in one line would supply it.
    const result = resolveFieldMapping(capabilityWith([STAGE]), STAGE_TRACE, STANDARD_ONLY);
    expect(result.statuses.stage).toBe("resolved");
    const setup = result.needs.find((need) => need.status === "needs-setup");
    expect(setup?.kind).toBe("tenant-metadata");
    expect(setup?.blocking).toBe(false);
    expect(setup?.resolutionSources).toContain("tenant-metadata");
    expect(setup?.resolutionSources).not.toContain("human");
  });

  it("13 — a prohibited execution mechanism is blocked, and no question can unblock it", () => {
    // Learning another field name does not make Aura replay safe, so the
    // platform's prohibition must never be dressed up as an epistemic need.
    const policy = defaultPlatformIntelligenceProvider.getBindingPolicy(PLATFORM, {
      method: "POST",
      pathPattern: "/aura?aura.RecordUi.updateRecord",
      origin: page.host,
      status: 200
    });
    expect(policy?.warnings.join(" ")).toMatch(/replay/i);
    expect(policy?.maximumEligibility).not.toBe("ready");

    const proposal = proposeBrowserBinding(capabilityWith([STAGE]), STAGE_TRACE, STANDARD_ONLY);
    expect(proposal.needs?.some((need) => need.status === "blocked")).toBeFalsy();
    expect(proposal.binding?.safety.noPrivateTransportReplay).toBe(true);
  });

  it("14 — a field in metadata but never observed is blocked, not asked about", () => {
    const result = resolveFieldMapping(
      capabilityWith([{ name: "amount", description: "amount", type: "number", required: true }]),
      STAGE_TRACE,
      tenantWith([
        { apiName: "StageName", label: "Stage", type: "picklist", options: ["Closed Won"] },
        { apiName: "Amount", label: "Amount", type: "currency" }
      ])
    );
    expect(result.mapping).toEqual({});
    expect(result.statuses.amount).toBe("blocked");
    // No question, because no answer would make an undemonstrated field
    // part of what the human taught.
    expect(result.needs).toEqual([]);
  });

  it("an anonymous signal produces no question either — there is nothing to ask about", () => {
    const result = resolveFieldMapping(capabilityWith([STAGE]), STAGE_TRACE, NO_KNOWLEDGE);
    expect(result.statuses.stage).toBe("needs-information");
    expect(result.needs[0].reason).toMatch(/No tenant metadata is available/i);
  });
});

/* --------------------------- no regressions --------------------------- */

describe("15 & 16 — existing flows are unchanged", () => {
  it("16 — Stage still resolves automatically from standard knowledge", () => {
    const proposal = proposeBrowserBinding(capabilityWith([STAGE]), STAGE_TRACE, STANDARD_ONLY);
    expect(proposal.binding?.inputs[0].applicationField?.apiName).toBe("StageName");
    expect(proposal.binding?.inputs[0].valueKind).toBe("select");
  });

  it("15 — Close Date still grounds on the identifier the control exposed", () => {
    const closeDateTrace = traceOf([
      {
        id: "cd",
        kind: "click",
        t: 1_000,
        page,
        element: { tag: "input", name: "CloseDate", label: "*Close Date" },
        actionLabel: "*Close Date"
      } as CaptureEvent
    ]);
    const capability = capabilityWith([{ name: "close_date", description: "close_date", type: "date", required: true }]);
    const proposal = proposeBrowserBinding(capability, closeDateTrace, STANDARD_ONLY);
    expect(proposal.binding?.inputs[0].semanticTarget.applicationIdentifier).toBe("CloseDate");
    expect(proposal.binding?.inputs[0].valueKind).toBe("date");
    expect(proposal.needs ?? []).toEqual([]);
  });
});
