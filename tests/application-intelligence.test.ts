import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import { resolveFieldMapping } from "../src/binding/fieldMapping";
import { proposeBrowserBinding } from "../src/binding/browserExecution/propose";
import { applicationIntelligenceForPlatform } from "../src/binding/browserExecution/adapters";
import { emptyTenantIntelligence, tenantIntelligenceFrom } from "../src/applicationIntelligence/tenant";
import { defaultPlatformIntelligenceProvider } from "../src/platformIntelligence";
import { buildTestFormFields, validateTestInputs } from "../src/training/executionTestForm";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { TenantIntelligenceSnapshot } from "../src/applicationIntelligence/model";
import type { CaptureEvent } from "../src/capture/types";
import type { ObservationTrace } from "../src/capture/normalize";
import type { CapabilityInput, SemanticCapability } from "../src/semantic/model";

const PLATFORM = "salesforce-lightning";
const SALESFORCE = sourceApplicationFor(PLATFORM, "nvent-dev-ed.lightning.force.com");
const page = { host: "nvent-dev-ed.lightning.force.com", path: "/lightning/r/Opportunity/006/view" };

/** Standard knowledge alone — the rep who has no metadata access. */
const STANDARD_ONLY = applicationIntelligenceForPlatform(PLATFORM, emptyTenantIntelligence());

/** The observed Aura transport, used to prove its policy is untouched by tenant data. */
const AURA_TRANSPORT = {
  method: "POST",
  pathPattern: "/aura?aura.RecordUi.updateRecord",
  origin: "nvent-dev-ed.lightning.force.com",
  status: 200
};

/**
 * The real observed shape of the two-field capture: Close Date's native
 * input named itself, and every Stage event came through a shadow host
 * with no name at all — only the visible label.
 */
function twoFieldTrace(events?: CaptureEvent[]): ObservationTrace {
  const session = new CaptureSession("sess-app-intel", 0, {
    host: page.host,
    platform: PLATFORM,
    title: "PS Project Test | Opportunity"
  });
  session.addMany(
    events ?? [
      { id: "nav", kind: "navigate", t: 100, page },
      {
        id: "close-date-focus",
        kind: "click",
        t: 1_000,
        page,
        element: { tag: "input", name: "CloseDate", label: "*Close Date" },
        actionLabel: "*Close Date"
      },
      {
        id: "close-date-change",
        kind: "field_change",
        t: 1_500,
        page,
        element: { tag: "lightning-datepicker", label: "*Close Date" },
        field: { label: "*Close Date", section: "Opportunity Details", control: "other" },
        value: { masked: false, to: "2027-03-01" }
      },
      {
        id: "stage-open",
        kind: "click",
        t: 2_000,
        page,
        element: { tag: "button", label: "Stage" },
        actionLabel: "Stage"
      },
      {
        id: "stage-change",
        kind: "field_change",
        t: 2_500,
        page,
        element: { tag: "lightning-combobox", label: "*Stage" },
        field: { label: "*Stage", section: "Opportunity Details", control: "other" },
        value: { masked: false }
      },
      { id: "save", kind: "click", t: 3_000, page, actionLabel: "Save" }
    ]
  );
  session.stop(4_000);
  return session.toTrace();
}

function capabilityWith(inputs: CapabilityInput[]): SemanticCapability {
  return {
    id: "update_opportunity_close_date_and_stage",
    name: "Update opportunity close date and stage",
    description: "Change an opportunity's close date and stage, then save.",
    inputs,
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true }
  };
}

const CLOSE_DATE: CapabilityInput = { name: "close_date", description: "close_date", type: "date", required: true };
const STAGE: CapabilityInput = { name: "stage", description: "stage", type: "string", required: true };

function tenantSnapshot(overrides: Partial<TenantIntelligenceSnapshot> = {}): TenantIntelligenceSnapshot {
  return {
    platform: PLATFORM,
    orgId: "00Dxx0000000000",
    capturedAt: "2026-08-27T09:00:00.000Z",
    mechanism: "injected-snapshot",
    objects: [
      {
        apiName: "Opportunity",
        fields: [
          { apiName: "CloseDate", label: "Close Date", type: "date" },
          {
            apiName: "StageName",
            label: "Stage",
            type: "picklist",
            options: ["Prospecting", "Negotiation/Review", "Closed Won", "Closed Lost"]
          }
        ]
      }
    ],
    ...overrides
  };
}

function withTenant(snapshot: TenantIntelligenceSnapshot) {
  return applicationIntelligenceForPlatform(PLATFORM, tenantIntelligenceFrom(snapshot));
}

/* ------------------------------ grounding ------------------------------ */

describe("1 — Close Date resolves from the identifier the application exposed", () => {
  it("grounds on the control's own name, confirmed by standard application knowledge", () => {
    const result = resolveFieldMapping(capabilityWith([CLOSE_DATE]), twoFieldTrace(), STANDARD_ONLY);
    expect(result.mapping).toEqual({ close_date: "CloseDate" });
    expect(result.grounding.close_date).toMatchObject({
      evidence: "application-identifier",
      knowledge: "standard",
      release: "summer-26"
    });
  });
});

describe("2 — Stage resolves from the visible label plus object context", () => {
  it("grounds Opportunity.StageName with no identifier anywhere in the capture", () => {
    const result = resolveFieldMapping(capabilityWith([STAGE]), twoFieldTrace(), STANDARD_ONLY);
    expect(result.mapping).toEqual({ stage: "StageName" });
    expect(result.fields.stage).toMatchObject({ objectApiName: "Opportunity", apiName: "StageName", type: "picklist" });
    expect(result.grounding.stage).toMatchObject({ evidence: "visible-label", knowledge: "standard" });
    expect(result.ambiguities).toEqual([]);
  });

  it("says how it got there, in a sentence a human can audit", () => {
    const result = resolveFieldMapping(capabilityWith([STAGE]), twoFieldTrace(), STANDARD_ONLY);
    expect(result.grounding.stage.detail).toMatch(/observed in the recording/i);
    expect(result.grounding.stage.detail).toMatch(/Opportunity\.StageName/);
  });
});

describe("3 — tenant metadata confirms and refines standard knowledge", () => {
  it("resolves through the tenant, and carries the tenant's configured options", () => {
    const result = resolveFieldMapping(capabilityWith([STAGE]), twoFieldTrace(), withTenant(tenantSnapshot()));
    expect(result.mapping).toEqual({ stage: "StageName" });
    expect(result.grounding.stage.knowledge).toBe("tenant");
    expect(result.fields.stage.options).toEqual(["Prospecting", "Negotiation/Review", "Closed Won", "Closed Lost"]);
    expect(result.fields.stage.optionsSource).toBe("tenant");
  });
});

describe("4 — a tenant's renamed label resolves to the underlying API name", () => {
  it("maps an org's own wording onto the standard field it actually is", () => {
    const renamedTrace = twoFieldTrace([
      { id: "nav", kind: "navigate", t: 100, page },
      {
        id: "stage-change",
        kind: "field_change",
        t: 2_500,
        page,
        element: { tag: "lightning-combobox", label: "*Deal Stage" },
        field: { label: "*Deal Stage", section: "Opportunity Details", control: "other" },
        value: { masked: false }
      },
      { id: "save", kind: "click", t: 3_000, page, actionLabel: "Save" }
    ]);
    const renamed = tenantSnapshot({
      objects: [
        {
          apiName: "Opportunity",
          fields: [{ apiName: "StageName", label: "Deal Stage", type: "picklist", options: ["Closed Won"] }]
        }
      ]
    });
    const capability = capabilityWith([{ name: "deal_stage", description: "deal_stage", type: "string", required: true }]);
    const result = resolveFieldMapping(capability, renamedTrace, withTenant(renamed));
    expect(result.mapping).toEqual({ deal_stage: "StageName" });
    expect(result.grounding.deal_stage.knowledge).toBe("tenant");
  });
});

describe("5 & 7 — a custom field binds only when tenant intelligence describes it", () => {
  const customTrace = twoFieldTrace([
    { id: "nav", kind: "navigate", t: 100, page },
    {
      id: "custom-change",
      kind: "field_change",
      t: 2_500,
      page,
      element: { tag: "lightning-input", label: "*Contract Start Date" },
      field: { label: "*Contract Start Date", section: "Opportunity Details", control: "other" },
      value: { masked: false }
    },
    { id: "save", kind: "click", t: 3_000, page, actionLabel: "Save" }
  ]);
  const capability = capabilityWith([
    { name: "contract_start_date", description: "contract_start_date", type: "date", required: true }
  ]);

  it("5 — resolves to the custom API name when the tenant knows it", () => {
    const snapshot = tenantSnapshot({
      objects: [
        {
          apiName: "Opportunity",
          fields: [{ apiName: "Contract_Start_Date__c", label: "Contract Start Date", type: "date", custom: true }]
        }
      ]
    });
    const result = resolveFieldMapping(capability, customTrace, withTenant(snapshot));
    expect(result.mapping).toEqual({ contract_start_date: "Contract_Start_Date__c" });
    expect(result.fields.contract_start_date.custom).toBe(true);
  });

  it("7 — without tenant intelligence it does not bind, and says precisely what it needs", () => {
    const result = resolveFieldMapping(capability, customTrace, STANDARD_ONLY);
    expect(result.mapping).toEqual({});
    // Not a dead end: the system knows exactly which fact would unblock it.
    expect(result.statuses.contract_start_date).toBe("needs-information");
    expect(result.needs[0].question).toMatch(/API name.*Contract Start Date/i);
  });
});

describe("6 — standard fields keep working when no tenant intelligence exists", () => {
  it("grounds both demonstrated fields from standard knowledge alone", () => {
    const result = resolveFieldMapping(capabilityWith([CLOSE_DATE, STAGE]), twoFieldTrace(), STANDARD_ONLY);
    expect(result.mapping).toEqual({ close_date: "CloseDate", stage: "StageName" });
    expect(result.ambiguities).toEqual([]);
  });
});

describe("8 — two different fields sharing a visible label block", () => {
  it("refuses rather than choosing one, when the evidence cannot separate them", () => {
    const ambiguousTrace = twoFieldTrace([
      { id: "nav", kind: "navigate", t: 100, page },
      {
        id: "stage-a",
        kind: "field_change",
        t: 2_400,
        page,
        element: { tag: "lightning-combobox", name: "StageName", label: "*Stage" },
        field: { label: "*Stage", control: "other" },
        value: { masked: false }
      },
      {
        id: "stage-b",
        kind: "field_change",
        t: 2_500,
        page,
        element: { tag: "lightning-combobox", name: "Partner_Stage__c", label: "*Stage" },
        field: { label: "*Stage", control: "other" },
        value: { masked: false }
      },
      { id: "save", kind: "click", t: 3_000, page, actionLabel: "Save" }
    ]);
    const result = resolveFieldMapping(capabilityWith([STAGE]), ambiguousTrace, STANDARD_ONLY);
    expect(result.mapping).toEqual({});
    expect(result.ambiguities.join(" ")).toMatch(/A human must choose/i);
  });
});

describe("9 — knowledge never substitutes for demonstration", () => {
  it("does not bind a field the tenant fully describes but the human never touched", () => {
    // The snapshot knows Amount completely. The recording never touched it.
    const snapshot = tenantSnapshot({
      objects: [
        {
          apiName: "Opportunity",
          fields: [
            { apiName: "StageName", label: "Stage", type: "picklist", options: ["Closed Won"] },
            { apiName: "Amount", label: "Amount", type: "currency" }
          ]
        }
      ]
    });
    const capability = capabilityWith([{ name: "amount", description: "amount", type: "number", required: true }]);
    const result = resolveFieldMapping(capability, twoFieldTrace(), withTenant(snapshot));
    expect(result.mapping).toEqual({});
    expect(result.ambiguities.join(" ")).toMatch(/No observed field identifier or visible label matches "amount"/);
  });
});

/* -------------------------- execution contract -------------------------- */

describe("10 & 19 — the execution contract carries type and option provenance", () => {
  it("10 — Stage becomes a select because the application says picklist", () => {
    const proposal = proposeBrowserBinding(capabilityWith([CLOSE_DATE, STAGE]), twoFieldTrace(), STANDARD_ONLY);
    const stage = proposal.binding?.inputs.find((input) => input.semanticInput === "stage");
    expect(stage?.valueKind).toBe("select");
    expect(stage?.applicationField).toMatchObject({ apiName: "StageName", type: "picklist", knowledge: "standard" });
  });

  it("10 — the semantic target still resolves by what is on screen, never by the API name", () => {
    const proposal = proposeBrowserBinding(capabilityWith([STAGE]), twoFieldTrace(), STANDARD_ONLY);
    const stage = proposal.binding?.inputs[0];
    expect(stage?.semanticTarget.label).toBe("*Stage");
    // Lightning renders no DOM name for a picklist; claiming one would send
    // the resolver looking for something that does not exist.
    expect(stage?.semanticTarget.applicationIdentifier).toBeUndefined();
    expect(JSON.stringify(stage?.semanticTarget)).not.toContain("StageName");
  });

  it("19 — materialized options record which layer supplied them", () => {
    const proposal = proposeBrowserBinding(capabilityWith([STAGE]), twoFieldTrace(), withTenant(tenantSnapshot()));
    const stage = proposal.binding?.inputs[0];
    expect(stage?.applicationField?.options).toContain("Closed Won");
    expect(stage?.applicationField?.optionsSource).toBe("tenant");
    expect(stage?.applicationField?.knowledge).toBe("tenant");
  });

  it("19 — standard knowledge alone materializes no options, rather than inventing a domain", () => {
    const proposal = proposeBrowserBinding(capabilityWith([STAGE]), twoFieldTrace(), STANDARD_ONLY);
    expect(proposal.binding?.inputs[0].applicationField?.options).toBeUndefined();
    expect(proposal.binding?.inputs[0].applicationField?.release).toBe("summer-26");
  });

  it("15 — the Close Date path is unchanged: still a date, still resolved by its own identifier", () => {
    const proposal = proposeBrowserBinding(capabilityWith([CLOSE_DATE, STAGE]), twoFieldTrace(), STANDARD_ONLY);
    const closeDate = proposal.binding?.inputs.find((input) => input.semanticInput === "close_date");
    expect(closeDate?.valueKind).toBe("date");
    expect(closeDate?.semanticTarget.applicationIdentifier).toBe("CloseDate");
    expect(proposal.binding?.commit).toEqual({ semanticAction: { role: "button", label: "Save" } });
  });
});

/* ------------------------------ typed form ------------------------------ */

describe("11 & 12 & 20 — the typed test form follows the resolved contract", () => {
  function fieldsFor(intelligence: ReturnType<typeof applicationIntelligenceForPlatform>) {
    const capability = capabilityWith([CLOSE_DATE, STAGE]);
    const proposal = proposeBrowserBinding(capability, twoFieldTrace(), intelligence);
    return buildTestFormFields(capability, proposal.binding!);
  }

  it("11 — known tenant options render a real dropdown", () => {
    const fields = fieldsFor(withTenant(tenantSnapshot()));
    const stage = fields.find((field) => field.name === "stage");
    expect(stage?.control).toBe("select");
    expect(stage?.options).toEqual(["Prospecting", "Negotiation/Review", "Closed Won", "Closed Lost"]);
    expect(fields.find((field) => field.name === "close_date")?.control).toBe("date");
  });

  it("12 — an option outside the known domain is rejected before anything is written", () => {
    const fields = fieldsFor(withTenant(tenantSnapshot()));
    const result = validateTestInputs(fields, { close_date: "2027-03-01", stage: "Closed Sideways" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/must be one of/i);
  });

  it("12 — an option inside the domain passes validation unchanged", () => {
    const fields = fieldsFor(withTenant(tenantSnapshot()));
    expect(validateTestInputs(fields, { close_date: "2027-03-01", stage: "Closed Won" })).toEqual({
      ok: true,
      values: { close_date: "2027-03-01", stage: "Closed Won" }
    });
  });

  it("20 — without a known domain the field stays a fixed set of choices, never a text box", () => {
    const fields = fieldsFor(STANDARD_ONLY);
    const stage = fields.find((field) => field.name === "stage");
    // A picklist whose values nobody has listed is still constrained. The
    // live run that motivated this let an arbitrary Stage value through.
    expect(stage?.control).toBe("select");
    expect(stage?.domainUnknown).toBe(true);
    expect(stage?.options).toBeUndefined();

    const result = validateTestInputs(fields, { close_date: "2027-03-01", stage: "Closed Won" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/valid values are not known yet/i);
  });

  it("live options read from the application take precedence over any stored domain", () => {
    const capability = capabilityWith([CLOSE_DATE, STAGE]);
    const proposal = proposeBrowserBinding(capability, twoFieldTrace(), withTenant(tenantSnapshot()));
    // The org's snapshot says four stages; the live record currently offers
    // two, because a record type narrows it. The application wins.
    const fields = buildTestFormFields(capability, proposal.binding!, { stage: ["Qualify", "Closed Won"] });
    const stage = fields.find((field) => field.name === "stage");
    expect(stage?.options).toEqual(["Qualify", "Closed Won"]);
    expect(stage?.domainUnknown).toBeUndefined();
  });
});

/* -------------------------------- safety -------------------------------- */

describe("17 & 18 — tenant knowledge cannot reach platform safety", () => {
  it("18 — a tenant snapshot leaves every platform policy exactly as the pack declares it", () => {
    const before = JSON.stringify({
      resolution: defaultPlatformIntelligenceProvider.getResolutionPolicy(PLATFORM),
      pageState: defaultPlatformIntelligenceProvider.getPageStateSemantics(PLATFORM),
      verification: defaultPlatformIntelligenceProvider.getVerificationSemantics(PLATFORM),
      policy: defaultPlatformIntelligenceProvider.getBindingPolicy(PLATFORM, AURA_TRANSPORT)
    });

    // A snapshot that tries to carry policy-shaped material alongside its
    // fields. The type system gives it nowhere to land, and the runtime
    // ignores it: application knowledge describes what a field is, never
    // what the platform is allowed to do.
    const hostile = {
      ...tenantSnapshot(),
      allowAuraReplay: true,
      resolution: { traversal: "flat-dom" },
      safety: { noXPath: false }
    } as TenantIntelligenceSnapshot;
    const intelligence = withTenant(hostile);
    const proposal = proposeBrowserBinding(capabilityWith([STAGE]), twoFieldTrace(), intelligence);

    const after = JSON.stringify({
      resolution: defaultPlatformIntelligenceProvider.getResolutionPolicy(PLATFORM),
      pageState: defaultPlatformIntelligenceProvider.getPageStateSemantics(PLATFORM),
      verification: defaultPlatformIntelligenceProvider.getVerificationSemantics(PLATFORM),
      policy: defaultPlatformIntelligenceProvider.getBindingPolicy(PLATFORM, AURA_TRANSPORT)
    });
    expect(after).toBe(before);
    expect(proposal.binding?.safety).toEqual({
      noCoordinates: true,
      noXPath: true,
      noPrivateTransportReplay: true,
      noCredentialExtraction: true
    });
  });

  it("17 — a tenant-enriched binding still carries no credential, transport, or selector material", () => {
    const proposal = proposeBrowserBinding(capabilityWith([CLOSE_DATE, STAGE]), twoFieldTrace(), withTenant(tenantSnapshot()));
    const { safety: _safety, ...rest } = proposal.binding as NonNullable<typeof proposal.binding>;
    const serialized = JSON.stringify(rest);
    expect(serialized).not.toMatch(/cookie|token|bearer|aura|sessionid/i);
    expect(serialized).not.toMatch(/xpath|querySelector|css[_-]?selector|nodeId/i);
    expect(serialized).not.toMatch(/coordinate/i);
  });

  it("20 — an absent tenant source degrades rather than crashing", () => {
    expect(() => resolveFieldMapping(capabilityWith([STAGE]), twoFieldTrace(), {})).not.toThrow();
    const bare = resolveFieldMapping(capabilityWith([STAGE]), twoFieldTrace(), {});
    // No standard knowledge either: a label alone is not a field identity.
    expect(bare.mapping).toEqual({});
    expect(bare.ambiguities).toHaveLength(1);
  });
});

/* ----------------------------- the pack ----------------------------- */

describe("standard application knowledge lives in the versioned pack", () => {
  it("declares the standard Opportunity fields the vendor ships, with provenance", () => {
    // A gap here is not neutral. A standard field the pack omits is
    // indistinguishable from a custom one, so grounding stops and asks a
    // human for an API name the vendor has always published — which is
    // exactly what a live run did for Lead Source, a standard picklist
    // that had been left out of a list "limited to what was demonstrated".
    const declared = defaultPlatformIntelligenceProvider.getApplicationSchema(PLATFORM);
    expect(declared?.schema.release).toBe("summer-26");
    const opportunity = declared?.schema.objects.find((object) => object.apiName === "Opportunity");
    const fields = opportunity?.fields ?? [];
    for (const apiName of ["CloseDate", "StageName", "LeadSource", "Amount", "Name"]) {
      expect(fields.map((field) => field.apiName)).toContain(apiName);
    }
    // The closed sets are declared as closed, which is a vendor fact —
    // unlike WHICH values they hold, which is the tenant's.
    expect(fields.find((field) => field.apiName === "LeadSource")?.type).toBe("picklist");
    expect(fields.find((field) => field.apiName === "StageName")?.type).toBe("picklist");
    expect(declared?.provenance.sourceReferenceIds.length).toBeGreaterThan(0);
  });

  it("carries no tenant configuration: picklist values are never a vendor fact", () => {
    const declared = defaultPlatformIntelligenceProvider.getApplicationSchema(PLATFORM);
    expect(JSON.stringify(declared?.schema)).not.toMatch(/options|Closed Won|Prospecting/);
  });
});
