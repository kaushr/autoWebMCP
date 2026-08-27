import { describe, expect, it } from "vitest";
import { deriveStudioLifecycle, type StudioLifecycleInput } from "../src/training/studioLifecycle";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BindingCandidateRecord } from "../src/training/bindingInference";
import type { BindingCandidateProposal } from "../src/binding/model";
import type { BindingValidationResult, ExecutionBinding } from "../src/binding/validation";
import type { SemanticCapability } from "../src/semantic/model";

const SALESFORCE = sourceApplicationFor("salesforce-lightning", "acme.lightning.force.com");
const SIGNALBASE = sourceApplicationFor("prospect-intelligence", "127.0.0.1:5173");

function capability(overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  return {
    id: "update_opportunity_close_date",
    name: "Update opportunity close date",
    description: "Change an opportunity's close date and save the record.",
    inputs: [{ name: "close_date", description: "close_date", type: "string", required: true }],
    outputs: [],
    provenance: { source: "inferred", observationIds: [], confirmedByHuman: false, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true },
    ...overrides
  };
}

function confirmed(overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  return capability({
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    ...overrides
  });
}

function proposal(overrides: Partial<BindingCandidateProposal> = {}): BindingCandidateProposal {
  return {
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
    evidence: ["Save was followed by RecordUi.updateRecord within 17ms"],
    warnings: [],
    validationRequired: [],
    ...overrides
  };
}

function candidateRecord(overrides: Partial<BindingCandidateRecord> = {}): BindingCandidateRecord {
  return { state: "proposed", proposal: proposal(), ...overrides };
}

function requiresSetupResult(overrides: Partial<BindingValidationResult> = {}): BindingValidationResult {
  return {
    capabilityId: "update_opportunity_close_date",
    sourceApplication: SALESFORCE,
    adapter: "salesforce-record-update/0.1",
    status: "requires-setup",
    checks: [],
    evidence: [],
    warnings: [],
    requirements: [
      "A supported way to reach UI API / Lightning Data Service from the runtime context.",
      "Confirmation of object and field-level permissions.",
      "A sandbox record and a test-safe value."
    ],
    validatedAt: "2026-08-27T06:00:00.000Z",
    ...overrides
  };
}

function validatedBinding(): ExecutionBinding {
  return {
    id: "signalbase-find-relevant-contacts",
    application: "prospect-intelligence",
    bindingFamily: "cooperative-application-binding",
    operation: "find_relevant_contacts",
    inputMapping: { company: "company" },
    contextRequirements: [],
    safety: {
      usesSupportedInterface: true,
      replaysPrivateTransport: false,
      extractsCredentials: false,
      runsAsCurrentUser: true
    },
    validationEvidence: ["read → write → read-back → restore all succeeded"]
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

describe("CASE A — semantic candidate proposed", () => {
  it("shows the capability as proposed, awaiting confirmation", () => {
    const view = derive();
    expect(view.capability).toEqual({ status: "proposed", label: "Proposed" });
    expect(view.publication.reason).toMatch(/confirm the capability/i);
    expect(view.publication.canPublish).toBe(false);
  });
});

describe("CASE B — semantic confirmed", () => {
  it("reads as confirmed rather than a disabled action", () => {
    const view = derive({ capability: confirmed() });
    expect(view.capability).toEqual({ status: "confirmed", label: "Confirmed" });
  });
});

describe("CASE C — binding candidate exists", () => {
  it("offers validation once a candidate is investigable", () => {
    const view = derive({ capability: confirmed(), bindingCandidate: candidateRecord() });
    expect(view.execution.status).toBe("candidate");
    expect(view.execution.canValidate).toBe(true);
    expect(view.execution.family).toBe("salesforce-record-update");
  });

  it("does not offer validation for a candidate with no safe mechanism", () => {
    const view = derive({
      capability: confirmed(),
      bindingCandidate: candidateRecord({ proposal: proposal({ candidate: null, eligibility: "no-safe-candidate" }) })
    });
    expect(view.execution.status).toBe("no-safe-candidate");
    expect(view.execution.canValidate).toBe(false);
  });

  it("does not offer validation for an ineligible mechanism", () => {
    const view = derive({
      capability: confirmed(),
      bindingCandidate: candidateRecord({ proposal: proposal({ eligibility: "private-observed-transport" }) })
    });
    expect(view.execution.status).toBe("candidate");
    expect(view.execution.canValidate).toBe(false);
  });
});

describe("CASE D — candidate accepted-for-validation is not an execution binding", () => {
  it("keeps publication blocked, and does not report it as bound", () => {
    const view = derive({
      capability: confirmed(),
      bindingCandidate: candidateRecord({ state: "accepted-for-validation" })
    });
    expect(view.publication.canPublish).toBe(false);
    expect(view.execution.status).toBe("candidate");
    // Nothing about "accepted-for-validation" state resembles a binding.
    expect(view.publication.reason).toMatch(/not been validated yet/i);
  });
});

describe("CASE E — Salesforce requires-setup", () => {
  const view = derive({
    capability: confirmed(),
    bindingCandidate: candidateRecord({ state: "accepted-for-validation" }),
    validation: { state: "none", result: requiresSetupResult() }
  });

  it("shows setup required, not failure", () => {
    expect(view.validation.status).toBe("requires-setup");
    expect(view.validation.label).toBe("Setup required");
  });

  it("offers no accept-execution-binding control", () => {
    expect(view.validation.canAccept).toBe(false);
    expect(view.validation.accepted).toBe(false);
  });

  it("blocks publication with an explicit, specific reason", () => {
    expect(view.publication.status).toBe("blocked");
    expect(view.publication.canPublish).toBe(false);
    expect(view.publication.reason).toMatch(/setup is required/i);
  });

  it("surfaces the concrete requirements rather than raw checks", () => {
    expect(view.validation.requirements.length).toBeGreaterThan(0);
    expect(view.validation.requirements[0]).toMatch(/UI API|Lightning Data Service/i);
  });
});

describe("CASE F — validated binding exists but not yet accepted", () => {
  const view = derive({
    capability: confirmed(),
    bindingCandidate: candidateRecord({ state: "accepted-for-validation" }),
    validation: {
      state: "validated",
      result: requiresSetupResult({ status: "validated", binding: validatedBinding(), requirements: [] })
    }
  });

  it("offers accept execution binding", () => {
    expect(view.validation.status).toBe("validated");
    expect(view.validation.canAccept).toBe(true);
    expect(view.validation.accepted).toBe(false);
  });

  it("keeps publication blocked until accepted", () => {
    expect(view.publication.canPublish).toBe(false);
    expect(view.publication.reason).toMatch(/accept it to publish/i);
  });
});

describe("CASE G — validated binding accepted", () => {
  it("enables publication", () => {
    const view = derive({
      capability: confirmed(),
      bindingCandidate: candidateRecord({ state: "accepted-for-validation" }),
      validation: {
        state: "accepted",
        result: requiresSetupResult({ status: "validated", binding: validatedBinding(), requirements: [] })
      }
    });
    expect(view.validation.accepted).toBe(true);
    expect(view.validation.canAccept).toBe(false);
    expect(view.publication.status).toBe("ready");
    expect(view.publication.canPublish).toBe(true);
  });

  it("reads as published once it is", () => {
    const view = derive({
      capability: confirmed(),
      bindingCandidate: candidateRecord({ state: "accepted-for-validation" }),
      validation: {
        state: "accepted",
        result: requiresSetupResult({ status: "validated", binding: validatedBinding(), requirements: [] })
      },
      published: true
    });
    expect(view.publication.status).toBe("published");
  });
});

describe("CASE H — semantic contract changes invalidate confirmation upstream", () => {
  // The invalidation rule itself lives in main.ts's applyCandidateEdits and is
  // exercised there; this asserts the lifecycle view reacts correctly once
  // confirmedByHuman flips back to false, which is what that rule produces.
  it("reverts to proposed once confirmation is withdrawn", () => {
    const view = derive({ capability: capability({ provenance: { source: "inferred", observationIds: [], confirmedByHuman: false, sourceApplication: SALESFORCE } }) });
    expect(view.capability.status).toBe("proposed");
    expect(view.publication.canPublish).toBe(false);
  });
});

describe("CASE I — a changed or rejected candidate is not silently retained", () => {
  it("does not let a rejected candidate imply anything is bound", () => {
    const view = derive({ capability: confirmed(), bindingCandidate: candidateRecord({ state: "rejected" }) });
    expect(view.execution.status).toBe("rejected");
    expect(view.execution.canValidate).toBe(false);
    expect(view.publication.reason).toMatch(/rejected/i);
  });

  it("treats no binding candidate as not-analyzed, never as a stale validated state", () => {
    const view = derive({ capability: confirmed(), bindingCandidate: undefined, validation: undefined });
    expect(view.execution.status).toBe("not-analyzed");
    expect(view.validation.status).toBe("not-started");
    expect(view.publication.reason).toMatch(/no execution path has been identified/i);
  });
});

describe("CASE J — SignalBase green path", () => {
  it("reaches ready-to-publish through the advertised-binding route with no validation step", () => {
    const view = derive({
      capability: confirmed({
        id: "find_relevant_contacts",
        provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SIGNALBASE }
      }),
      advertisedBound: true
    });

    expect(view.capability.status).toBe("confirmed");
    expect(view.execution.status).toBe("advertised");
    expect(view.validation.status).toBe("not-applicable");
    expect(view.publication.status).toBe("ready");
    expect(view.publication.canPublish).toBe(true);
  });

  it("reads as published once SignalBase's capability is in the publication list", () => {
    const view = derive({
      capability: confirmed({ id: "find_relevant_contacts" }),
      advertisedBound: true,
      published: true
    });
    expect(view.publication.status).toBe("published");
  });
});

describe("Unconfirmed capability never reaches ready, however bound", () => {
  it("stays blocked even with an advertised binding", () => {
    const view = derive({ capability: capability(), advertisedBound: true });
    expect(view.publication.status).toBe("blocked");
    expect(view.publication.reason).toMatch(/confirm the capability/i);
  });
});
