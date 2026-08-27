import { describe, expect, it } from "vitest";
import {
  buildTestFormFields,
  displayValue,
  summarizeExecutionPlan,
  validateTestInputs
} from "../src/training/executionTestForm";
import { compileCapability } from "../src/webmcp/compiler";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";
import type { CapabilityInput, SemanticCapability } from "../src/semantic/model";

const SALESFORCE = sourceApplicationFor("salesforce-lightning", "demo.lightning.force.com");

function capabilityWith(inputs: CapabilityInput[]): SemanticCapability {
  return {
    id: "update_opportunity_close_date",
    name: "Update opportunity close date",
    description: "Change an opportunity's close date and save the record.",
    inputs,
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true }
  };
}

function bindingFor(capability: SemanticCapability): BrowserExecutionBinding {
  return {
    id: "browser-test",
    capabilityId: capability.id,
    sourceApplication: SALESFORCE,
    platform: "salesforce-lightning",
    context: { recordType: "Opportunity", pageMode: "edit-or-record" },
    inputs: capability.inputs.map((input) => ({
      semanticInput: input.name,
      semanticTarget: { role: "field", label: `*${input.name.replace(/_/g, " ")}`, applicationIdentifier: input.name },
      valueKind: "text"
    })),
    commit: { semanticAction: { role: "button", label: "Save" } },
    verification: ["no-validation-error-visible"],
    safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
    evidence: []
  };
}

const DATE_INPUT: CapabilityInput = { name: "close_date", description: "Close date", type: "date", required: true };

describe("7 — a date capability renders a date-aware control", () => {
  it("maps canonical type date to the date control, overriding the binding's weaker text kind", () => {
    const capability = capabilityWith([DATE_INPUT]);
    const fields = buildTestFormFields(capability, bindingFor(capability));
    expect(fields).toEqual([{ name: "close_date", label: "close date", control: "date", required: true }]);
  });
});

describe("8 — enum renders a select and rejects out-of-domain values", () => {
  const capability = capabilityWith([
    { name: "stage", description: "Stage", type: "string", required: true, enum: ["Confirm", "Closed"] }
  ]);
  const fields = buildTestFormFields(capability, bindingFor(capability));

  it("renders a select carrying the enum domain", () => {
    expect(fields[0].control).toBe("select");
    expect(fields[0].options).toEqual(["Confirm", "Closed"]);
  });

  it("rejects a value outside the domain", () => {
    const result = validateTestInputs(fields, { stage: "Nonsense" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/must be one of/i);
  });

  it("accepts a value inside the domain", () => {
    expect(validateTestInputs(fields, { stage: "Closed" })).toEqual({ ok: true, values: { stage: "Closed" } });
  });
});

describe("9 — number rejects invalid numeric input and canonicalizes valid input", () => {
  const capability = capabilityWith([{ name: "amount", description: "Amount", type: "number", required: true }]);
  const fields = buildTestFormFields(capability, bindingFor(capability));

  it("rejects non-numeric text", () => {
    const result = validateTestInputs(fields, { amount: "lots" });
    expect(result.ok).toBe(false);
  });

  it("canonicalizes a parseable number", () => {
    expect(validateTestInputs(fields, { amount: "042.50" })).toEqual({ ok: true, values: { amount: "42.5" } });
  });
});

describe("10 — a missing required input blocks before anything is touched", () => {
  it("returns errors, never a values object, when a required field is empty", () => {
    const capability = capabilityWith([DATE_INPUT]);
    const fields = buildTestFormFields(capability, bindingFor(capability));
    const result = validateTestInputs(fields, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/required/i);
  });

  it("an optional empty field simply stays absent", () => {
    const capability = capabilityWith([{ name: "note", description: "Note", type: "string", required: false }]);
    const fields = buildTestFormFields(capability, bindingFor(capability));
    expect(validateTestInputs(fields, {})).toEqual({ ok: true, values: {} });
  });
});

describe("11 — the canonical date contract", () => {
  const capability = capabilityWith([DATE_INPUT]);
  const fields = buildTestFormFields(capability, bindingFor(capability));

  it("passes the canonical YYYY-MM-DD through unchanged — platform display formatting is the adapter's job", () => {
    expect(validateTestInputs(fields, { close_date: "2027-03-01" })).toEqual({
      ok: true,
      values: { close_date: "2027-03-01" }
    });
  });

  it("rejects a locale-formatted date at the contract boundary", () => {
    const result = validateTestInputs(fields, { close_date: "3/1/2027" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/YYYY-MM-DD/);
  });
});

describe("12 — confirmation summarizes the validated values, requesting nothing", () => {
  it("names each change and the commit action, from already-collected values only", () => {
    const capability = capabilityWith([DATE_INPUT]);
    const fields = buildTestFormFields(capability, bindingFor(capability));
    const summary = summarizeExecutionPlan(fields, { close_date: "2027-03-01" }, "Save", "Salesforce");

    expect(summary).toMatch(/^AutoWebMCP is about to:/);
    expect(summary).toMatch(/Change close date to .*2027/);
    expect(summary).toMatch(/activate "Save" on the taught Salesforce record/);
    expect(summary).toMatch(/Continue\?$/);
    expect(summary).not.toMatch(/enter|provide|type/i);
  });

  it("renders a boolean as checked/unchecked rather than a raw string", () => {
    expect(displayValue({ name: "b", label: "Private", control: "checkbox", required: false }, "true")).toBe("checked");
  });
});

describe("13 — checkbox semantics never block, and default to unchecked", () => {
  it("an untouched boolean validates to false rather than failing a required check", () => {
    const capability = capabilityWith([{ name: "private", description: "Private", type: "boolean", required: true }]);
    const fields = buildTestFormFields(capability, bindingFor(capability));
    expect(validateTestInputs(fields, {})).toEqual({ ok: true, values: { private: "false" } });
  });
});

describe("the agent contract matches the Studio contract", () => {
  it("compiles a date input to a string schema that names the canonical format", () => {
    const capability = capabilityWith([DATE_INPUT]);
    const tool = compileCapability(capability, () => ({}));
    expect(tool.inputSchema.properties.close_date.type).toBe("string");
    expect(tool.inputSchema.properties.close_date.description).toMatch(/YYYY-MM-DD/);
  });
});
