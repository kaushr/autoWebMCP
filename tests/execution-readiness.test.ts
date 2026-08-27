import { describe, expect, it } from "vitest";
import { assessExecutionReadiness } from "../src/training/executionReadiness";
import { buildTestFormFields } from "../src/training/executionTestForm";
import {
  beginOperation,
  failed,
  isCurrent,
  isWorking,
  succeeded,
  type OperationRegistry
} from "../src/training/operationState";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";
import type { SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * Unresolved knowledge has to control the workflow.
 *
 * The live screenshot showed the system knowing Stage was a fixed set of
 * choices, knowing it did not know the choices, disabling the control —
 * and leaving "Run test" enabled anyway. Recognizing a gap is only half
 * the job; the gap has to gate the action it makes unsafe.
 * ------------------------------------------------------------------ */

const SALESFORCE = sourceApplicationFor("salesforce-lightning", "example.lightning.force.com");

function capabilityWith(inputs: SemanticCapability["inputs"]): SemanticCapability {
  return {
    id: "update_opportunity",
    name: "Update opportunity",
    description: "Change an opportunity and save.",
    inputs,
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true }
  };
}

function bindingWith(inputs: BrowserExecutionBinding["inputs"]): BrowserExecutionBinding {
  return {
    id: "browser-update_opportunity",
    capabilityId: "update_opportunity",
    sourceApplication: SALESFORCE,
    platform: "salesforce-lightning",
    context: { recordType: "Opportunity", pageMode: "edit-or-record" },
    inputs,
    commit: { semanticAction: { role: "button", label: "Save" } },
    verification: ["no-validation-error-visible"],
    safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
    evidence: []
  };
}

const stageInput = (options?: string[]): BrowserExecutionBinding["inputs"][number] => ({
  semanticInput: "stage",
  semanticTarget: { role: "field", label: "*Stage" },
  valueKind: "select",
  applicationField: {
    objectApiName: "Opportunity",
    apiName: "StageName",
    type: "picklist",
    knowledge: "standard",
    ...(options ? { options, optionsSource: "tenant" as const, domain: "known-tenant" as const } : { domain: "discoverable-live" as const })
  }
});

const closeDateInput: BrowserExecutionBinding["inputs"][number] = {
  semanticInput: "close_date",
  semanticTarget: { role: "field", label: "*Close Date", applicationIdentifier: "CloseDate" },
  valueKind: "date",
  applicationField: { objectApiName: "Opportunity", apiName: "CloseDate", type: "date", knowledge: "standard" }
};

function readinessFor(required: boolean, options?: string[], live?: Record<string, string[]>) {
  const capability = capabilityWith([
    { name: "close_date", description: "close_date", type: "date", required: true },
    { name: "stage", description: "stage", type: "string", required }
  ]);
  const binding = bindingWith([closeDateInput, stageInput(options)]);
  const fields = buildTestFormFields(capability, binding, live);
  return assessExecutionReadiness(fields, binding);
}

describe("K — a required constrained input with an unknown domain blocks execution", () => {
  const readiness = readinessFor(true);

  it("cannot run", () => {
    expect(readiness.canRun).toBe(false);
    expect(readiness.blocked).toHaveLength(1);
    expect(readiness.blocked[0]).toMatchObject({ name: "stage", blocker: "domain-unresolved" });
  });

  it("says why, in the words the button needs", () => {
    expect(readiness.summary).toBe("Test unavailable until valid Stage choices are known.");
  });
});

describe("L — the same input becomes runnable once its domain is known", () => {
  it("unblocks when tenant metadata supplied the values", () => {
    expect(readinessFor(true, ["Prospecting", "Closed Won"]).canRun).toBe(true);
  });

  it("unblocks when the live application supplied them", () => {
    expect(readinessFor(true, undefined, { stage: ["Prospecting", "Closed Won"] }).canRun).toBe(true);
  });
});

describe("M — an optional input whose enrichment is missing does not block", () => {
  it("may execute, because the input can simply be omitted", () => {
    const readiness = readinessFor(false);
    expect(readiness.canRun).toBe(true);
    expect(readiness.blocked).toEqual([]);
  });
});

describe("the rule is derived from input state, not from any particular field", () => {
  it("blocks an unrelated constrained field the same way", () => {
    const capability = capabilityWith([
      { name: "region", description: "region", type: "string", required: true, enum: [] }
    ]);
    const binding = bindingWith([
      {
        semanticInput: "region",
        semanticTarget: { role: "field", label: "*Region" },
        valueKind: "select",
        applicationField: {
          objectApiName: "Opportunity",
          apiName: "Region__c",
          type: "picklist",
          knowledge: "tenant",
          domain: "discoverable-live"
        }
      }
    ]);
    const readiness = assessExecutionReadiness(buildTestFormFields(capability, binding), binding);
    expect(readiness.canRun).toBe(false);
    expect(readiness.summary).toMatch(/valid Region choices/);
  });

  it("blocks when the application field behind an input was never established", () => {
    const capability = capabilityWith([{ name: "mystery", description: "mystery", type: "string", required: true }]);
    const binding = bindingWith([
      { semanticInput: "mystery", semanticTarget: { role: "field", label: "*Mystery" }, valueKind: "text" }
    ]);
    const readiness = assessExecutionReadiness(buildTestFormFields(capability, binding), binding);
    expect(readiness.canRun).toBe(false);
    expect(readiness.blocked[0].blocker).toBe("identity-unresolved");
  });

  it("a fully resolved binding runs", () => {
    const capability = capabilityWith([{ name: "close_date", description: "close_date", type: "date", required: true }]);
    const binding = bindingWith([closeDateInput]);
    expect(assessExecutionReadiness(buildTestFormFields(capability, binding), binding).canRun).toBe(true);
  });
});

/* --------------------------- operation state --------------------------- */

describe("A & B — a click is acknowledged immediately and cannot be fired twice", () => {
  it("A — beginning an operation puts it in the working state", () => {
    const state = beginOperation("acquire-domains", "Getting valid choices…", 1_000);
    expect(state).toMatchObject({ kind: "acquire-domains", status: "working", startedAt: 1_000 });
    const registry: OperationRegistry = { "acquire-domains": state };
    expect(isWorking(registry, "acquire-domains")).toBe(true);
  });

  it("B — a second click while working is recognized as a duplicate", () => {
    const registry: OperationRegistry = { "acquire-domains": beginOperation("acquire-domains", "…") };
    // The handler's own guard reads exactly this.
    expect(isWorking(registry, "acquire-domains")).toBe(true);
  });
});

describe("C, D & E — every ending clears the busy state", () => {
  it("C — success replaces the busy message with the result", () => {
    const done = succeeded(beginOperation("acquire-domains", "Getting valid choices…"), "✓ 10 valid choices found.");
    expect(done.status).toBe("succeeded");
    expect(isWorking({ "acquire-domains": done }, "acquire-domains")).toBe(false);
  });

  it("D — failure carries the specific cause and is flagged for attention", () => {
    const done = failed(beginOperation("acquire-domains", "…"), "The Teach Mode extension is out of date.");
    expect(done).toMatchObject({ status: "failed", warning: true });
    expect(done.message).toMatch(/out of date/);
  });

  it("E — a timeout ends the busy state like any other failure", () => {
    const done = failed(beginOperation("acquire-domains", "…"), "The Teach Mode extension did not respond within 25s.");
    expect(isWorking({ "acquire-domains": done }, "acquire-domains")).toBe(false);
  });

  it("a success can still be flagged when it needs attention", () => {
    const done = succeeded(beginOperation("acquire-domains", "…"), "Choices found, but…", true);
    expect(done).toMatchObject({ status: "succeeded", warning: true });
  });
});

describe("F — a stale response cannot overwrite newer state", () => {
  it("recognizes that an earlier operation no longer owns its slot", () => {
    const first = beginOperation("acquire-domains", "Getting valid choices…");
    let registry: OperationRegistry = { "acquire-domains": first };
    // The user clicks again, or switches trace: a newer operation takes the slot.
    const second = beginOperation("acquire-domains", "Getting valid choices…");
    registry = { "acquire-domains": second };

    expect(isCurrent(registry, first)).toBe(false);
    expect(isCurrent(registry, second)).toBe(true);
  });
});

describe("H — independent actions do not block each other", () => {
  it("one action being busy leaves the others free", () => {
    const registry: OperationRegistry = { "acquire-domains": beginOperation("acquire-domains", "…") };
    expect(isWorking(registry, "acquire-domains")).toBe(true);
    expect(isWorking(registry, "refresh-traces")).toBe(false);
    expect(isWorking(registry, "publish-capability")).toBe(false);
  });
});
