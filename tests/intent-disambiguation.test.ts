import { describe, expect, it } from "vitest";
import { resolveApplicationField } from "../src/applicationIntelligence/resolveField";
import { emptyTenantIntelligence, tenantIntelligenceFrom } from "../src/applicationIntelligence/tenant";
import type {
  FieldClarification,
  StandardApplicationSchema,
  TenantFieldSchema
} from "../src/applicationIntelligence/model";

/* ------------------------------------------------------------------ *
 * Candidate gathering, deterministic disambiguation, and human intent.
 *
 * The rule these cases pin down: having knowledge is not the same as
 * having resolved the observation. Two fields labelled "Stage" is a set of
 * two known candidates, not a failure and not a coin toss — and the
 * question a person is finally asked must be the smallest one left, using
 * the candidate names the system already possesses.
 *
 * The three sources answer different questions, so none of them is simply
 * "highest authority":
 *
 *   metadata     what exists, and its technical properties
 *   observation  what happened
 *   a human      what they MEANT, when evidence cannot distinguish it
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";

const STANDARD: StandardApplicationSchema = {
  release: "summer-26",
  objects: [
    {
      apiName: "Opportunity",
      fields: [
        { apiName: "CloseDate", defaultLabel: "Close Date", type: "date" },
        { apiName: "StageName", defaultLabel: "Stage", type: "picklist" }
      ]
    }
  ]
};

const ONE_STAGE: TenantFieldSchema[] = [
  { apiName: "StageName", label: "Stage", type: "picklist", options: ["Prospecting", "Closed Won"] }
];

const TWO_STAGES: TenantFieldSchema[] = [
  { apiName: "StageName", label: "Stage", type: "picklist", options: ["Prospecting", "Closed Won"] },
  { apiName: "Custom_Stage__c", label: "Stage", type: "picklist", options: ["Phase 1", "Phase 2"], custom: true }
];

function withTenant(fields: TenantFieldSchema[]) {
  return tenantIntelligenceFrom({
    platform: PLATFORM,
    orgId: "00Dxx0000000000",
    capturedAt: "2026-08-27T09:00:00.000Z",
    mechanism: "injected-snapshot",
    objects: [{ apiName: "Opportunity", fields }]
  });
}

const base = {
  inputName: "stage",
  objectApiName: "Opportunity",
  platform: PLATFORM,
  standard: STANDARD
};

const humanChose = (apiName: string): FieldClarification[] => [
  {
    platform: PLATFORM,
    objectApiName: "Opportunity",
    observedLabel: "Stage",
    apiName,
    source: "human-confirmed",
    scope: "capability"
  }
];

/* --------------------------- A through H --------------------------- */

describe("A — one tenant candidate resolves without asking", () => {
  it("resolves StageName and asks nothing", () => {
    const result = resolveApplicationField({
      ...base,
      tenant: withTenant(ONE_STAGE),
      observed: [{ label: "*Stage", strength: 2 }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.field.apiName).toBe("StageName");
    expect(result.grounding.knowledge).toBe("tenant");
    expect(result.grounding.path.at(-1)).toBe("No user clarification required.");
  });
});

describe("B — an identifier observed anywhere in the trace settles it", () => {
  it("resolves without asking, even though the identifier and the label came from different events", () => {
    // The real Lightning shape: the click named the control, the retargeted
    // change carried only the label. Resolving each signal in isolation used
    // to throw the identifier away and block.
    const result = resolveApplicationField({
      ...base,
      tenant: withTenant(TWO_STAGES),
      observed: [
        { applicationIdentifier: "StageName", strength: 1 },
        { label: "*Stage", strength: 2 }
      ]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.field.apiName).toBe("StageName");
    expect(result.grounding.path.join(" ")).toMatch(/Found 2 candidates/);
    expect(result.grounding.path.join(" ")).toMatch(/Observed identifier "StageName" matched 1 of them/);
  });
});

describe("C — an incompatible candidate is eliminated by evidence, not preference", () => {
  it("uses the value the human actually set to rule out the candidate that cannot hold it", () => {
    const result = resolveApplicationField({
      ...base,
      tenant: withTenant(TWO_STAGES),
      observed: [{ label: "*Stage", control: "other", value: "Phase 2", strength: 2 }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.field.apiName).toBe("Custom_Stage__c");
    expect(result.grounding.path.join(" ")).toMatch(/The observed value "Phase 2" is offered by 1 of them/);
  });

  it("uses the declared type to rule out a candidate that cannot hold that kind of value", () => {
    const result = resolveApplicationField({
      inputName: "stage",
      objectApiName: "Opportunity",
      platform: PLATFORM,
      inputType: "date",
      tenant: withTenant([
        { apiName: "StageName", label: "Stage", type: "picklist" },
        { apiName: "Stage_Date__c", label: "Stage", type: "date", custom: true }
      ]),
      observed: [{ label: "*Stage", strength: 2 }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.field.apiName).toBe("Stage_Date__c");
  });

  it("does not eliminate anything when the evidence contradicts every candidate", () => {
    // Evidence that rules out everything is more likely evidence we
    // misread than proof of nothing, so it is treated as non-discriminating.
    const result = resolveApplicationField({
      ...base,
      tenant: withTenant(TWO_STAGES),
      observed: [{ label: "*Stage", value: "Something Else Entirely", strength: 2 }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.need?.suggestedAnswers).toHaveLength(2);
  });
});

describe("D — with nothing to distinguish them, the question names both candidates", () => {
  const result = resolveApplicationField({
    ...base,
    tenant: withTenant(TWO_STAGES),
    observed: [{ label: "*Stage", strength: 2 }]
  });

  it("is ambiguous rather than a guess", () => {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("ambiguous");
    expect(result.need?.subreason).toBe("insufficient-evidence");
  });

  it("asks which field, not what the API name is — both names are already known", () => {
    if (result.ok) return;
    expect(result.need?.question).toMatch(/Which field did you change/i);
    expect(result.need?.question).not.toMatch(/what is the api name/i);
    expect(result.need?.suggestedAnswers?.map((suggestion) => suggestion.value)).toEqual([
      "StageName",
      "Custom_Stage__c"
    ]);
  });

  it("carries each candidate's provenance and type into the choice", () => {
    if (result.ok) return;
    const custom = result.need?.suggestedAnswers?.find((suggestion) => suggestion.value === "Custom_Stage__c");
    expect(custom).toMatchObject({ source: "tenant", type: "picklist" });
    expect(custom?.detail).toMatch(/custom field/i);
  });

  it("explains the path it took before giving up", () => {
    if (result.ok) return;
    expect(result.need?.resolutionPath).toEqual([
      'Observed "Stage" on Opportunity.',
      "Found 2 candidates in tenant metadata: StageName, Custom_Stage__c.",
      "Available evidence could not distinguish them."
    ]);
  });
});

describe("E — the person's choice is intent, not a technical assertion", () => {
  const result = resolveApplicationField({
    ...base,
    tenant: withTenant(TWO_STAGES),
    observed: [{ label: "*Stage", strength: 2 }],
    clarifications: humanChose("Custom_Stage__c")
  });

  it("resolves to the chosen candidate", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.field.apiName).toBe("Custom_Stage__c");
    expect(result.grounding.intentDisambiguatedByHuman).toBe(true);
  });

  it("takes the field's technical properties from metadata, not from the person", () => {
    if (!result.ok) return;
    expect(result.grounding.knowledge).toBe("tenant");
    expect(result.field.type).toBe("picklist");
    expect(result.field.options).toEqual(["Phase 1", "Phase 2"]);
    expect(result.field.optionsSource).toBe("tenant");
  });

  it("does not become vendor knowledge", () => {
    if (!result.ok) return;
    expect(result.grounding.release).toBeUndefined();
    expect(result.grounding.path.join(" ")).toMatch(/A person identified Custom_Stage__c/);
  });
});

describe("F — an answer that authoritative tenant metadata does not list is a conflict", () => {
  const result = resolveApplicationField({
    ...base,
    tenant: withTenant(ONE_STAGE),
    observed: [{ label: "*Stage", strength: 2 }],
    clarifications: humanChose("Custom_Stage__c")
  });

  it("does not silently override tenant metadata, and does not silently discard the answer", () => {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("ambiguous");
    expect(result.need?.subreason).toBe("conflicting");
    expect(result.need?.suggestedAnswers?.map((suggestion) => suggestion.value)).toEqual([
      "StageName",
      "Custom_Stage__c"
    ]);
  });

  it("labels the human answer as unverified rather than as metadata", () => {
    if (result.ok) return;
    const human = result.need?.suggestedAnswers?.find((suggestion) => suggestion.source === "human-confirmed");
    expect(human?.detail).toMatch(/unverified by tenant metadata/i);
  });
});

describe("G — standard knowledge alone may resolve when nothing contradicts it", () => {
  it("resolves Stage from the vendor model with no tenant metadata installed", () => {
    const result = resolveApplicationField({
      ...base,
      tenant: emptyTenantIntelligence(),
      observed: [{ label: "*Stage", strength: 2 }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.field.apiName).toBe("StageName");
    expect(result.grounding.knowledge).toBe("standard");
    expect(result.grounding.release).toBe("summer-26");
  });
});

describe("H — with tenant metadata unavailable and several standard candidates, ask only the residual question", () => {
  it("presents the known candidates rather than asking for an API name", () => {
    const twoStandard: StandardApplicationSchema = {
      release: "summer-26",
      objects: [
        {
          apiName: "Opportunity",
          fields: [
            { apiName: "StageName", defaultLabel: "Stage", type: "picklist" },
            { apiName: "ForecastCategoryName", defaultLabel: "Stage", type: "picklist" }
          ]
        }
      ]
    };
    const result = resolveApplicationField({
      ...base,
      standard: twoStandard,
      tenant: emptyTenantIntelligence(),
      observed: [{ label: "*Stage", strength: 2 }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.need?.kind).toBe("field-choice");
    expect(result.need?.suggestedAnswers?.map((suggestion) => suggestion.source)).toEqual(["standard", "standard"]);
  });
});

/* ------------- the three human/tenant cases, stated directly ------------- */

describe("a human answer means three different things depending on what is known", () => {
  it("1 — selecting among tenant-known candidates is disambiguation, not conflict", () => {
    const result = resolveApplicationField({
      ...base,
      tenant: withTenant(TWO_STAGES),
      observed: [{ label: "*Stage", strength: 2 }],
      clarifications: humanChose("Custom_Stage__c")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grounding.intentDisambiguatedByHuman).toBe(true);
    expect(result.grounding.tenantUnverified).toBeUndefined();
  });

  it("2 — asserting a field authoritative tenant metadata does not list is a conflict", () => {
    const result = resolveApplicationField({
      ...base,
      tenant: withTenant(ONE_STAGE),
      observed: [{ label: "*Stage", strength: 2 }],
      clarifications: humanChose("Custom_Stage__c")
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.need?.subreason).toBe("conflicting");
  });

  it("3 — with tenant metadata unavailable, a human may override the vendor default", () => {
    const result = resolveApplicationField({
      ...base,
      tenant: emptyTenantIntelligence(),
      observed: [{ label: "*Stage", strength: 2 }],
      clarifications: humanChose("Custom_Stage__c")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.field.apiName).toBe("Custom_Stage__c");
    expect(result.grounding.tenantUnverified).toBe(true);
    expect(result.grounding.knowledge).toBe("human-confirmed");
  });

  it("4 — choosing StageName from known candidates asserts nothing about StageName's type", () => {
    const result = resolveApplicationField({
      ...base,
      tenant: withTenant(TWO_STAGES),
      observed: [{ label: "*Stage", strength: 2 }],
      // The person also (wrongly) believes it is a number. That belief is
      // not a technical fact and must not reach the resolved field.
      clarifications: [{ ...humanChose("StageName")[0], type: "number" }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.field.type).toBe("picklist");
    expect(result.grounding.knowledge).toBe("tenant");
    expect(result.grounding.intentDisambiguatedByHuman).toBe(true);
  });
});

describe("the technical/identity split holds even when the human names an unknown field", () => {
  it("takes metadata's type when metadata knows the named field, whatever the person believes", () => {
    const result = resolveApplicationField({
      inputName: "region",
      objectApiName: "Opportunity",
      platform: PLATFORM,
      standard: STANDARD,
      tenant: emptyTenantIntelligence(),
      observed: [{ label: "*Region", strength: 2 }],
      clarifications: [
        {
          platform: PLATFORM,
          objectApiName: "Opportunity",
          observedLabel: "Region",
          apiName: "CloseDate",
          type: "number",
          source: "human-confirmed",
          scope: "capability"
        }
      ]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // They named CloseDate; the vendor model says it is a date, not a number.
    expect(result.field.type).toBe("date");
    expect(result.grounding.knowledge).toBe("standard");
    expect(result.grounding.tenantUnverified).toBe(true);
  });
});
