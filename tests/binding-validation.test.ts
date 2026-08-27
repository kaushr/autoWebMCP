import { describe, expect, it } from "vitest";
import {
  acceptedBinding,
  runBindingValidation,
  type BindingValidationRecord,
  type BindingValidationResult,
  type BindingValidator,
  type ValidationContext
} from "../src/binding/validation";
import { salesforceRecordUpdateValidator } from "../src/binding/validators/salesforce";
import { defaultValidators } from "../src/binding/validators";
import { observedRecordType, resolveFieldMapping } from "../src/binding/fieldMapping";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import { CaptureSession } from "../src/capture/session";
import type { BindingCandidateProposal } from "../src/binding/model";
import type { SemanticCapability } from "../src/semantic/model";
import type { CaptureEvent } from "../src/capture/types";

const SALESFORCE = sourceApplicationFor("salesforce-lightning", "nvent-dev-ed.lightning.force.com");
const AT = "2026-08-27T06:00:00.000Z";
const page = { host: "nvent-dev-ed.lightning.force.com", path: "/lightning/r/Opportunity/006/view" };

/** The real capture: the datepicker's own control named itself CloseDate. */
function salesforceTrace(elementName: string | null = "CloseDate") {
  const session = new CaptureSession("sess-validate", 0, {
    host: page.host,
    platform: "salesforce-lightning",
    title: "PS Project Test | Opportunity"
  });
  const events: CaptureEvent[] = [
    { id: "nav", kind: "navigate", t: 100, page },
    {
      id: "edit",
      kind: "field_change",
      t: 1_000,
      page,
      ...(elementName ? { element: { tag: "input", name: elementName, label: "*Close Date" } } : {}),
      field: { label: "*Close Date", section: "Opportunity Details", control: "date" },
      value: { masked: false, from: "2026-08-31", to: "2026-09-30" }
    },
    { id: "save", kind: "click", t: 2_000, page, actionLabel: "Save" }
  ];
  session.addMany(events);
  session.stop(3_000);
  return session.toTrace();
}

function capability(inputs: string[]): SemanticCapability {
  return {
    id: "update_opportunity_close_date",
    name: "Update opportunity close date",
    description: "Change an opportunity's close date and save the record.",
    inputs: inputs.map((name) => ({ name, description: name, type: "string", required: true })),
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true }
  };
}

const candidate: BindingCandidateProposal = {
  capabilityId: "update_opportunity_close_date",
  sourceApplication: SALESFORCE,
  candidate: {
    bindingFamily: "salesforce-record-update",
    mechanism: "A supported Salesforce record-update interface",
    observedTransport: "/aura?aura.RecordUi.updateRecord,r",
    directReplayAllowed: false
  },
  confidence: "medium",
  eligibility: "needs-validation",
  evidence: [],
  warnings: [],
  validationRequired: []
};

function contextFor(subject: SemanticCapability, trace = salesforceTrace()): ValidationContext {
  const mapping = resolveFieldMapping(subject, trace);
  const recordType = observedRecordType(trace);
  return {
    capabilityId: subject.id,
    capabilityInputs: subject.inputs.map((input) => ({ name: input.name, required: input.required })),
    sourceApplication: SALESFORCE,
    candidate,
    fieldMapping: mapping.mapping,
    fieldMappingAmbiguities: mapping.ambiguities,
    ...(recordType ? { observedRecordType: recordType } : {}),
    validatedAt: AT
  };
}

describe("Field mapping comes from what the application named", () => {
  it("maps close_date onto the observed CloseDate identifier", () => {
    const result = resolveFieldMapping(capability(["close_date"]), salesforceTrace());
    expect(result.mapping).toEqual({ close_date: "CloseDate" });
    expect(result.ambiguities).toEqual([]);
    expect(result.evidence[0]).toContain("CloseDate");
  });

  it("resolves the record type from the captured path, never a record id", () => {
    expect(observedRecordType(salesforceTrace())).toBe("Opportunity");
    expect(JSON.stringify(salesforceTrace())).not.toContain("0065w00002");
  });

  it("refuses to guess when the application named no field", () => {
    const result = resolveFieldMapping(capability(["close_date"]), salesforceTrace(null));
    expect(result.mapping).toEqual({});
    expect(result.ambiguities.join(" ")).toMatch(/no application field identifier/i);
  });

  it("refuses to guess when an input matches nothing observed", () => {
    const result = resolveFieldMapping(capability(["amount"]), salesforceTrace());
    expect(result.mapping).toEqual({});
    expect(result.ambiguities.join(" ")).toMatch(/No observed field identifier matches "amount"/);
  });
});

describe("Identifiers are recovered wherever the application named them", () => {
  /** The live shape: the click names the control, the change does not. */
  function shadowRetargetedTrace() {
    const session = new CaptureSession("sess-shadow", 0, {
      host: page.host,
      platform: "salesforce-lightning"
    });
    session.addMany([
      { id: "nav", kind: "navigate", t: 100, page },
      {
        id: "focus",
        kind: "click",
        t: 5_603,
        page,
        element: { tag: "input", name: "CloseDate" },
        actionLabel: "*Close Date"
      },
      {
        id: "edit",
        kind: "field_change",
        t: 8_351,
        page,
        element: { tag: "lightning-datepicker" },
        field: { label: "*Close Date", section: "Opportunity Details", control: "other" },
        value: { masked: false }
      }
    ] as CaptureEvent[]);
    session.stop(11_000);
    return session.toTrace();
  }

  it("recovers CloseDate from the click when the change was retargeted", () => {
    const result = resolveFieldMapping(capability(["close_date"]), shadowRetargetedTrace());
    expect(result.mapping).toEqual({ close_date: "CloseDate" });
    expect(result.ambiguities).toEqual([]);
  });

  it("does not match an unrelated control that happens to be named", () => {
    const result = resolveFieldMapping(capability(["amount"]), shadowRetargetedTrace());
    expect(result.mapping).toEqual({});
  });

  it("validates the mapping check on the real-world shape", async () => {
    const subject = capability(["close_date"]);
    const result = await salesforceRecordUpdateValidator.validate(contextFor(subject, shadowRetargetedTrace()));
    expect(result.checks.find((check) => check.name === "Field mapping")?.status).toBe("pass");
  });
});

describe("Salesforce validation stops at the reach gate", () => {
  it("proves what it can and blocks on the mechanism it cannot reach", async () => {
    const result = await salesforceRecordUpdateValidator.validate(contextFor(capability(["close_date"])));

    expect(result.status).toBe("requires-setup");
    expect(result.binding).toBeUndefined();
    expect(result.platformIntelligence?.packId).toBe("salesforce-intelligence-pack");
    expect(result.platformIntelligence?.knowledgeEntryIds).toEqual([
      "sf-lds-ui-api-supported",
      "sf-rest-record-api-supported"
    ]);

    const byName = Object.fromEntries(result.checks.map((check) => [check.name, check.status]));
    expect(byName["Record type observed"]).toBe("pass");
    expect(byName["Field mapping"]).toBe("pass");
    expect(byName["Supported mechanism reachable"]).toBe("blocked");
    expect(byName["Controlled write"]).toBe("skipped");
    expect(byName["Read-back verification"]).toBe("skipped");
  });

  it("names what would unblock it without proposing a workaround", async () => {
    const result = await salesforceRecordUpdateValidator.validate(contextFor(capability(["close_date"])));
    expect(result.requirements.join(" ")).toMatch(/uiRecordApi|Connected App|delegated/i);
    expect(result.warnings.join(" ")).toMatch(/no credential, cookie, session id, or token/i);
  });

  it("never falls back to the private transport it was warned about", async () => {
    const result = await salesforceRecordUpdateValidator.validate(contextFor(capability(["close_date"])));
    expect(result.warnings.join(" ")).toMatch(/aura transport remains prohibited/i);
    expect(JSON.stringify(result)).not.toContain("RecordUi.updateRecord,r\",\"replay");
    expect(result.binding).toBeUndefined();
  });

  it("reads and writes nothing, and touches no credential", async () => {
    const serialized = JSON.stringify(await salesforceRecordUpdateValidator.validate(contextFor(capability(["close_date"]))));
    for (const forbidden of ["Authorization", "Bearer ", "Cookie", "sid=", "sessionId"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("Ambiguous or absent mapping is not guessed", () => {
  it("fails the mapping check rather than choosing a field", async () => {
    const subject = capability(["close_date"]);
    const context = { ...contextFor(subject), fieldMapping: {}, fieldMappingAmbiguities: ["\"close_date\" matches several observed fields: CloseDate, CloseDate__c. A human must choose."] };
    const result = await salesforceRecordUpdateValidator.validate(context);

    const mapping = result.checks.find((check) => check.name === "Field mapping")!;
    expect(mapping.status).toBe("fail");
    expect(mapping.detail).toMatch(/human must choose/i);
    expect(result.binding).toBeUndefined();
  });
});

describe("An application nothing can validate", () => {
  it("returns inconclusive rather than attempting something unsupported", async () => {
    const generic = sourceApplicationFor("generic", "shop.example.com");
    const result = await runBindingValidation(
      { ...contextFor(capability(["close_date"])), sourceApplication: generic },
      defaultValidators
    );

    expect(result.status).toBe("inconclusive");
    expect(result.adapter).toBe("none");
    expect(result.binding).toBeUndefined();
  });
});

describe("Permission failure is reported, never bypassed", () => {
  const denying: BindingValidator = {
    id: "fixture-permission/0.1",
    supports: () => true,
    async validate(context): Promise<BindingValidationResult> {
      return {
        capabilityId: context.capabilityId,
        sourceApplication: context.sourceApplication,
        adapter: "fixture-permission/0.1",
        status: "failed",
        checks: [
          { name: "Field mapping", status: "pass", detail: "close_date → Opportunity.CloseDate" },
          {
            name: "Permission check",
            status: "fail",
            detail: "The running user lacks field-level write access to Opportunity.CloseDate."
          },
          { name: "Controlled write", status: "skipped", detail: "Not attempted: permission denied." }
        ],
        evidence: [],
        warnings: ["The permission boundary is the application's decision and is not worked around."],
        requirements: ["Grant field-level write access to the intended user, then re-validate."],
        validatedAt: context.validatedAt
      };
    }
  };

  it("creates no binding and states the boundary", async () => {
    const result = await runBindingValidation(contextFor(capability(["close_date"])), [denying]);
    expect(result.status).toBe("failed");
    expect(result.binding).toBeUndefined();
    expect(result.warnings.join(" ")).toMatch(/not worked around/i);
  });
});

describe("Acceptance is a separate decision from proof", () => {
  const validated: BindingValidationResult = {
    capabilityId: "update_opportunity_close_date",
    sourceApplication: SALESFORCE,
    adapter: "fixture-validated/0.1",
    status: "validated",
    binding: {
      id: "salesforce-record-update:opportunity",
      application: "salesforce-lightning",
      bindingFamily: "salesforce-record-update",
      operation: "supported-record-update",
      inputMapping: { close_date: "CloseDate" },
      contextRequirements: [
        { name: "recordId", description: "The record the runtime is acting on.", satisfiedBy: "page context" },
        { name: "objectType", description: "The record's object type.", satisfiedBy: "Opportunity" }
      ],
      safety: {
        usesSupportedInterface: true,
        replaysPrivateTransport: false,
        extractsCredentials: false,
        runsAsCurrentUser: true
      },
      validationEvidence: ["read → write → read-back → restore all succeeded"]
    },
    checks: [],
    evidence: [],
    warnings: [],
    requirements: [],
    validatedAt: AT
  };

  it("does not become the execution binding merely by being validated", () => {
    const record: BindingValidationRecord = { state: "validated", result: validated };
    expect(acceptedBinding(record)).toBeUndefined();
  });

  it("becomes the execution binding once a human accepts it", () => {
    const record: BindingValidationRecord = { state: "accepted", result: validated };
    expect(acceptedBinding(record)?.inputMapping).toEqual({ close_date: "CloseDate" });
    expect(acceptedBinding(record)?.safety.replaysPrivateTransport).toBe(false);
  });

  it("is not reusable-by-accident: the binding names a context contract, not a record", () => {
    expect(JSON.stringify(validated.binding)).not.toMatch(/006[A-Za-z0-9]{12,}/);
    expect(validated.binding?.contextRequirements.map((entry) => entry.name)).toEqual(["recordId", "objectType"]);
  });

  it("yields nothing on rejection", () => {
    expect(acceptedBinding({ state: "rejected", result: validated })).toBeUndefined();
    expect(acceptedBinding(undefined)).toBeUndefined();
  });
});
