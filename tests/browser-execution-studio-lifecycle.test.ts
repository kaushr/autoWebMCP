import { describe, expect, it } from "vitest";
import { deriveStudioLifecycle, type StudioLifecycleInput } from "../src/training/studioLifecycle";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserBindingCandidateRecord, BrowserExecutionBinding } from "../src/binding/browserExecution/model";
import type { SemanticCapability } from "../src/semantic/model";
import type { ExecutionResult } from "../src/binding/browserExecution/result";

const SALESFORCE = sourceApplicationFor("salesforce-lightning", "acme.lightning.force.com");
const SIGNALBASE = sourceApplicationFor("prospect-intelligence", "127.0.0.1:5173");

function capability(overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  return {
    id: "update_opportunity_close_date",
    name: "Update opportunity close date",
    description: "Change an opportunity's close date and save the record.",
    inputs: [{ name: "close_date", description: "close_date", type: "string", required: true }],
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true },
    ...overrides
  };
}

const BINDING: BrowserExecutionBinding = {
  id: "browser-update_opportunity_close_date-salesforce-lightning",
  capabilityId: "update_opportunity_close_date",
  sourceApplication: SALESFORCE,
  platform: "salesforce-lightning",
  context: { recordType: "Opportunity", pageMode: "edit-or-record" },
  inputs: [
    {
      semanticInput: "close_date",
      semanticTarget: { role: "field", label: "Close Date", applicationIdentifier: "CloseDate" },
      valueKind: "date"
    }
  ],
  commit: { semanticAction: { role: "button", label: "Save" } },
  verification: ["no-validation-error-visible", "field-value-observable"],
  safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
  evidence: []
};

function candidateRecord(overrides: Partial<BrowserBindingCandidateRecord> = {}): BrowserBindingCandidateRecord {
  return { state: "proposed", proposal: { binding: BINDING, warnings: [] }, ...overrides };
}

function result(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    status: "succeeded",
    checks: [],
    evidence: [],
    warnings: [],
    executedAt: "2026-08-27T06:00:00.000Z",
    ...overrides
  };
}

function derive(overrides: Partial<StudioLifecycleInput> = {}): ReturnType<typeof deriveStudioLifecycle> {
  return deriveStudioLifecycle({
    capability: capability(),
    advertisedBound: false,
    bindingCandidate: undefined,
    validation: undefined,
    published: false,
    ...overrides
  });
}

describe("browser execution stage — not analyzed / suggested / rejected", () => {
  it("starts not-analyzed with nothing suggested yet", () => {
    const view = derive();
    expect(view.browserExecution.status).toBe("not-analyzed");
    expect(view.browserExecution.canPropose).toBe(true);
    expect(view.browserExecution.canTest).toBe(false);
  });

  it("offers testing once a binding is proposed", () => {
    const view = derive({ browserBindingCandidate: candidateRecord() });
    expect(view.browserExecution.status).toBe("proposed");
    expect(view.browserExecution.binding).toEqual(BINDING);
    expect(view.browserExecution.canTest).toBe(true);
  });

  it("does not offer testing for a rejected suggestion", () => {
    const view = derive({ browserBindingCandidate: candidateRecord({ state: "rejected" }) });
    expect(view.browserExecution.status).toBe("rejected");
    expect(view.browserExecution.canTest).toBe(false);
  });

  it("does not describe a rejected suggestion as still awaiting a test in the publication reason", () => {
    const view = derive({ browserBindingCandidate: candidateRecord({ state: "rejected" }) });
    expect(view.publication.reason).not.toMatch(/test it to continue/i);
    expect(view.publication.reason).toMatch(/no execution path has been identified/i);
  });

  it("does not offer testing when no safe candidate could be proposed", () => {
    const view = derive({
      browserBindingCandidate: candidateRecord({ proposal: { binding: null, warnings: ["no commit action observed"] } })
    });
    expect(view.browserExecution.status).toBe("no-safe-candidate");
    expect(view.browserExecution.canTest).toBe(false);
  });
});

describe("browser validation stage", () => {
  it("is not-started before any test has run", () => {
    const view = derive({ browserBindingCandidate: candidateRecord() });
    expect(view.browserValidation.status).toBe("not-started");
    expect(view.browserValidation.canAccept).toBe(false);
  });

  it("offers acceptance once a test succeeds", () => {
    const view = derive({
      browserBindingCandidate: candidateRecord(),
      browserBindingValidation: { state: "tested", binding: BINDING, result: result({ status: "succeeded" }) }
    });
    expect(view.browserValidation.status).toBe("succeeded");
    expect(view.browserValidation.canAccept).toBe(true);
  });

  it("offers acceptance for a save that succeeded but could not be read back", () => {
    const view = derive({
      browserBindingCandidate: candidateRecord(),
      browserBindingValidation: { state: "tested", binding: BINDING, result: result({ status: "partially_verified" }) }
    });
    expect(view.browserValidation.status).toBe("partially_verified");
    expect(view.browserValidation.label).toMatch(/read-back unavailable/i);
    expect(view.browserValidation.canAccept).toBe(true);
  });

  it("never offers acceptance for a failed test", () => {
    const view = derive({
      browserBindingCandidate: candidateRecord(),
      browserBindingValidation: { state: "tested", binding: BINDING, result: result({ status: "failed" }) }
    });
    expect(view.browserValidation.canAccept).toBe(false);
  });

  it("never offers acceptance for a blocked test", () => {
    const view = derive({
      browserBindingCandidate: candidateRecord(),
      browserBindingValidation: { state: "tested", binding: BINDING, result: result({ status: "blocked" }) }
    });
    expect(view.browserValidation.canAccept).toBe(false);
  });

  it("no longer offers acceptance once already accepted", () => {
    const view = derive({
      browserBindingCandidate: candidateRecord({ state: "accepted" }),
      browserBindingValidation: { state: "accepted", binding: BINDING, result: result({ status: "succeeded" }) }
    });
    expect(view.browserValidation.accepted).toBe(true);
    expect(view.browserValidation.canAccept).toBe(false);
  });
});

describe("publication gate — the browser route", () => {
  it("stays blocked while a validated browser binding awaits acceptance", () => {
    const view = derive({
      browserBindingCandidate: candidateRecord(),
      browserBindingValidation: { state: "tested", binding: BINDING, result: result({ status: "succeeded" }) }
    });
    expect(view.publication.canPublish).toBe(false);
    expect(view.publication.reason).toMatch(/ready to publish|accept it to publish/i);
  });

  it("unblocks once the browser binding is accepted, even though the supported-API route requires setup", () => {
    const view = derive({
      bindingCandidate: undefined,
      validation: undefined,
      browserBindingCandidate: candidateRecord({ state: "accepted" }),
      browserBindingValidation: { state: "accepted", binding: BINDING, result: result({ status: "succeeded" }) }
    });
    expect(view.publication.status).toBe("ready");
    expect(view.publication.canPublish).toBe(true);
  });

  it("also unblocks on an accepted partially_verified browser binding — a proven save with unreadable value counts", () => {
    const view = derive({
      browserBindingCandidate: candidateRecord({ state: "accepted" }),
      browserBindingValidation: { state: "accepted", binding: BINDING, result: result({ status: "partially_verified" }) }
    });
    expect(view.publication.canPublish).toBe(true);
  });

  it("reads as published once the capability is in the publication list", () => {
    const view = derive({
      browserBindingCandidate: candidateRecord({ state: "accepted" }),
      browserBindingValidation: { state: "accepted", binding: BINDING, result: result({ status: "succeeded" }) },
      published: true
    });
    expect(view.publication.status).toBe("published");
  });

  it("does not publish from an untested proposal alone", () => {
    const view = derive({ browserBindingCandidate: candidateRecord() });
    expect(view.publication.canPublish).toBe(false);
  });

  it("still requires confirmation first, whichever route bound it", () => {
    const view = derive({
      capability: capability({ provenance: { source: "inferred", observationIds: [], confirmedByHuman: false, sourceApplication: SALESFORCE } }),
      browserBindingCandidate: candidateRecord({ state: "accepted" }),
      browserBindingValidation: { state: "accepted", binding: BINDING, result: result({ status: "succeeded" }) }
    });
    expect(view.publication.canPublish).toBe(false);
    expect(view.publication.reason).toMatch(/confirm the capability/i);
  });
});

describe("SignalBase regression — the advertised-binding route is untouched", () => {
  it("reports the browser strategy as not-applicable when a direct application binding already exists", () => {
    const view = derive({
      capability: capability({
        id: "find_relevant_contacts",
        provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SIGNALBASE }
      }),
      advertisedBound: true
    });
    expect(view.execution.status).toBe("advertised");
    expect(view.browserExecution.status).toBe("not-applicable");
    expect(view.browserValidation.status).toBe("not-applicable");
    expect(view.publication.status).toBe("ready");
    expect(view.publication.canPublish).toBe(true);
  });
});
