import { describe, expect, it } from "vitest";
import { planValueDomainAcquisition, hasUnresolvedRequiredDomain } from "../src/training/valueDomainResolution";
import { assessExecutionReadiness } from "../src/training/executionReadiness";
import { buildTestFormFields, validateTestInputs } from "../src/training/executionTestForm";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";
import type { SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * An unknown value domain is a need the system satisfies, not a job it
 * hands to the user.
 *
 * The button asked the person to orchestrate an acquisition they have no
 * special ability to perform: the system already knows the input is
 * grounded to `Opportunity.StageName`, knows that field is constrained,
 * knows execution needs its values, and knows which sources exist. The
 * only thing a human adds is escalation when none of those sources can
 * answer.
 *
 * Precedence: tenant metadata → standard knowledge (identifies the
 * constraint, never supplies values) → live application → a human.
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

const stage = (options?: string[]): BrowserExecutionBinding["inputs"][number] => ({
  semanticInput: "stage",
  semanticTarget: { role: "field", label: "*Stage" },
  valueKind: "select",
  applicationField: {
    objectApiName: "Opportunity",
    apiName: "StageName",
    type: "picklist",
    knowledge: options ? "tenant" : "standard",
    ...(options
      ? { options, optionsSource: "tenant" as const, domain: "known-tenant" as const }
      : { domain: "discoverable-live" as const })
  }
});

function planFor(options?: string[], live?: Record<string, string[]>, required = true, liveAvailable = true) {
  const capability = capabilityWith([{ name: "stage", description: "stage", type: "string", required }]);
  const binding = bindingWith([stage(options)]);
  const fields = buildTestFormFields(capability, binding, live);
  return { plan: planValueDomainAcquisition(fields, binding, liveAvailable), fields, binding };
}

/* ------------------------- precedence ------------------------- */

describe("A & I — tenant metadata answers without touching the application", () => {
  const { plan, fields } = planFor(["Prospecting", "Closed Won"]);

  it("A — the dropdown is ready immediately", () => {
    expect(fields[0]).toMatchObject({ control: "select", options: ["Prospecting", "Closed Won"] });
    expect(fields[0].domainUnknown).toBeUndefined();
  });

  it("I — nothing is queued for live acquisition, so Salesforce is never opened to rediscover it", () => {
    expect(plan.acquirable).toEqual([]);
    expect(plan.unresolvable).toEqual([]);
    expect(plan.trail.join(" ")).toMatch(/Already known from tenant; no acquisition needed/i);
  });
});

describe("B — standard knowledge identifies the constraint but supplies no values", () => {
  const { plan } = planFor();

  it("queues live acquisition automatically, with no user action in the plan", () => {
    expect(plan.acquirable).toHaveLength(1);
    expect(plan.acquirable[0]).toMatchObject({ inputName: "stage", apiName: "StageName", required: true });
  });

  it("states the need and each source considered, in order", () => {
    expect(plan.trail[0]).toMatch(/Need: valid value domain for Opportunity\.StageName/);
    expect(plan.trail[1]).toMatch(/Tenant intelligence: no values available/);
    expect(plan.trail[2]).toMatch(/Standard application knowledge: field identified as a fixed set/);
    expect(plan.trail[3]).toMatch(/Live application acquisition: available/);
  });
});

describe("J — standard knowledge never overrides tenant values", () => {
  it("a tenant-configured domain is used as-is, and no vendor default replaces it", () => {
    const { fields, plan } = planFor(["Qualification", "Closed Won"]);
    expect(fields[0].options).toEqual(["Qualification", "Closed Won"]);
    expect(plan.acquirable).toEqual([]);
  });
});

describe("C — a live acquisition result becomes the domain, and unblocks execution", () => {
  it("populates the dropdown and clears the readiness blocker", () => {
    const { fields, binding, plan } = planFor(undefined, { stage: ["Qualification", "Closed Won"] });
    expect(fields[0].options).toEqual(["Qualification", "Closed Won"]);
    expect(plan.acquirable).toEqual([]);
    expect(assessExecutionReadiness(fields, binding).canRun).toBe(true);
  });
});

describe("D & E — a failed or timed-out acquisition leaves the field constrained", () => {
  const { fields, binding } = planFor();

  it("execution stays blocked", () => {
    const readiness = assessExecutionReadiness(fields, binding);
    expect(readiness.canRun).toBe(false);
    expect(readiness.summary).toMatch(/until valid Stage choices are known/);
  });

  it("M — the control never becomes free text, and no value is accepted", () => {
    expect(fields[0].control).toBe("select");
    expect(fields[0].domainUnknown).toBe(true);
    const result = validateTestInputs(fields, { stage: "anything at all" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/not known yet/i);
  });
});

describe("L — when no machine source can answer, the need escalates rather than disappearing", () => {
  it("reports the need as unresolvable when live acquisition is unavailable", () => {
    const { plan } = planFor(undefined, undefined, true, false);
    expect(plan.acquirable).toEqual([]);
    expect(plan.unresolvable).toHaveLength(1);
    expect(plan.unresolvable[0].inputName).toBe("stage");
    expect(plan.trail.join(" ")).toMatch(/Live application acquisition: unavailable/);
    expect(hasUnresolvedRequiredDomain(plan)).toBe(true);
  });
});

describe("H — an optional constrained field", () => {
  it("does not block execution when its domain is unknown", () => {
    const { fields, binding } = planFor(undefined, undefined, false);
    expect(assessExecutionReadiness(fields, binding).canRun).toBe(true);
  });

  it("still refuses a value until its domain is resolved", () => {
    const { fields } = planFor(undefined, undefined, false);
    const result = validateTestInputs(fields, { stage: "Closed Won" });
    expect(result.ok).toBe(false);
  });

  it("but is acquired anyway, so the user can choose if they want to", () => {
    const { plan } = planFor(undefined, undefined, false);
    expect(plan.acquirable).toHaveLength(1);
    expect(plan.acquirable[0].required).toBe(false);
    // Only required needs gate execution.
    expect(hasUnresolvedRequiredDomain(plan)).toBe(false);
  });
});

describe("G — the plan is idempotent, so repeated rendering asks for the same work once", () => {
  it("produces an identical plan every time for the same inputs", () => {
    const first = planFor().plan;
    const second = planFor().plan;
    expect(second.acquirable).toEqual(first.acquirable);
    // The caller's own guard uses the binding id; the plan itself is pure,
    // so re-rendering can never change what is owed.
    expect(second.trail).toEqual(first.trail);
  });
});

describe("the rule names no field and no platform", () => {
  it("treats any constrained input the same way", () => {
    const capability = capabilityWith([{ name: "region", description: "region", type: "string", required: true }]);
    const binding = bindingWith([
      {
        semanticInput: "region",
        semanticTarget: { role: "field", label: "*Region" },
        valueKind: "select",
        applicationField: {
          objectApiName: "Account",
          apiName: "Region__c",
          type: "picklist",
          knowledge: "tenant",
          domain: "discoverable-live"
        }
      }
    ]);
    const plan = planValueDomainAcquisition(buildTestFormFields(capability, binding), binding);
    expect(plan.acquirable[0]).toMatchObject({ inputName: "region", apiName: "Region__c" });
    expect(plan.trail[0]).toMatch(/Account\.Region__c/);
  });

  it("ignores inputs that are not constrained at all", () => {
    const capability = capabilityWith([{ name: "close_date", description: "close_date", type: "date", required: true }]);
    const binding = bindingWith([
      {
        semanticInput: "close_date",
        semanticTarget: { role: "field", label: "*Close Date", applicationIdentifier: "CloseDate" },
        valueKind: "date",
        applicationField: { objectApiName: "Opportunity", apiName: "CloseDate", type: "date", knowledge: "standard" }
      }
    ]);
    const plan = planValueDomainAcquisition(buildTestFormFields(capability, binding), binding);
    expect(plan.acquirable).toEqual([]);
    expect(plan.trail).toEqual([]);
  });
});
