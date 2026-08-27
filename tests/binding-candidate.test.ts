import { describe, expect, it } from "vitest";
import { applyPolicyCeiling, prepareBindingInference } from "../src/binding/prefilter";
import { capEligibility, defaultBindingPolicyProvider } from "../src/binding/policy";
import { isInvestigable, noSafeCandidate, type BindingCandidateProposal } from "../src/binding/model";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import { correlateExecutionEvidence } from "../src/capture/execution";
import { normalizeCapture } from "../src/capture/normalize";
import type { CaptureEvent, CaptureNetworkMetadata } from "../src/capture/types";
import type { SemanticCapability } from "../src/semantic/model";

const SALESFORCE = sourceApplicationFor("salesforce-lightning", "acme.lightning.force.com");
const GENERIC = sourceApplicationFor("generic", "shop.example.com");

function request(
  host: string,
  id: string,
  startedAt: number,
  method: string,
  endpoint: string,
  overrides: Partial<CaptureNetworkMetadata> = {}
): CaptureEvent {
  const page = { host, path: "/record" };
  const durationMs = overrides.durationMs ?? 200;
  const status = overrides.status ?? 200;
  return {
    id: `net-${id}`,
    kind: "network",
    t: startedAt + durationMs,
    page,
    network: {
      requestId: id,
      method,
      origin: `https://${host}`,
      endpoint,
      resourceType: "xmlhttprequest",
      category: /^(POST|PUT|PATCH|DELETE)$/.test(method) ? "mutation" : "read",
      status,
      ok: status >= 200 && status < 400,
      failed: status === 0,
      startedAt,
      completedAt: startedAt + durationMs,
      durationMs,
      ...overrides
    }
  };
}

function capability(id: string, source: typeof SALESFORCE, inputs: string[]): SemanticCapability {
  return {
    id,
    name: id.replace(/_/g, " "),
    description: `Demonstrated capability ${id}.`,
    inputs: inputs.map((name) => ({ name, description: name, type: "string", required: true })),
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: source },
    safety: { readOnly: false, requiresConfirmation: true }
  };
}

/** The real recording: Close Date edit, Save, updateRecord at +17ms, then noise. */
function salesforceSession(): CaptureEvent[] {
  const host = "acme.lightning.force.com";
  const page = { host, path: "/record" };
  return [
    {
      id: "edit",
      kind: "field_change",
      t: 1_000,
      page,
      field: { label: "Close Date", section: "Opportunity Details", control: "date" },
      value: { masked: false, from: "2026-08-31", to: "2026-09-30" }
    },
    { id: "click-save", kind: "click", t: 42_600, page, actionLabel: "Save" },
    request(host, "update", 42_617, "POST", "/aura?aura.RecordUi.updateRecord,r", { durationMs: 466 }),
    request(host, "refetch", 43_100, "POST", "/aura?aura.RecordUi.getRecordWithFields,r"),
    request(host, "chart", 44_500, "POST", "/aura?r,ui-analytics-platform-embeddedChart.EmbeddedReportChart.loadChart")
  ];
}

function prepare(events: CaptureEvent[], subject: SemanticCapability) {
  const observations = normalizeCapture(events);
  return prepareBindingInference(subject, correlateExecutionEvidence(events, observations), observations);
}

describe("Salesforce: the observed transport is a lead, never a binding", () => {
  const subject = capability("update_opportunity_close_date", SALESFORCE, ["close_date"]);
  const prepared = prepare(salesforceSession(), subject);

  it("sends only the strongest candidate to the model, not the storm", () => {
    expect(prepared.kind).toBe("infer");
    if (prepared.kind !== "infer") return;

    expect(prepared.input.causalCandidates).toHaveLength(1);
    expect(prepared.input.causalCandidates[0].pathPattern).toContain("RecordUi.updateRecord");
    expect(prepared.input.causalCandidates[0].startedAfterMs).toBe(17);
    expect(prepared.input.causalCandidates[0].action).toBe("Save");
  });

  it("recognizes Aura as an internal transport and caps what may be claimed", () => {
    if (prepared.kind !== "infer") return;
    expect(prepared.policy.transportClass).toBe("private-internal");
    expect(prepared.policy.maximumEligibility).toBe("needs-validation");
    expect(prepared.policy.preferredBindingFamily).toBe("salesforce-record-update");
    expect(prepared.policy.warnings.join(" ")).toMatch(/never be replayed directly/i);
    expect(prepared.policy.platformIntelligence?.packId).toBe("salesforce-intelligence-pack");
    expect(prepared.policy.platformIntelligence?.packVersion).toBe("0.3.0");
    expect(prepared.policy.platformIntelligence?.knowledgeEntryIds).toContain("sf-aura-private-internal");
    expect(prepared.policy.platformIntelligence?.knowledgeEntryIds).toContain(
      "sf-recordui-update-record-suggests-record-update"
    );
  });

  it("refuses to let a model upgrade eligibility past the policy ceiling", () => {
    if (prepared.kind !== "infer") return;
    const overconfident: BindingCandidateProposal = {
      capabilityId: subject.id,
      sourceApplication: SALESFORCE,
      candidate: {
        bindingFamily: "salesforce-record-update",
        mechanism: "Call the observed Aura endpoint",
        observedTransport: "/aura?aura.RecordUi.updateRecord,r",
        directReplayAllowed: false
      },
      confidence: "high",
      eligibility: "supported-candidate",
      evidence: ["Save was followed by RecordUi.updateRecord within 17ms"],
      warnings: [],
      validationRequired: []
    };

    const capped = applyPolicyCeiling(overconfident, prepared.policy);
    expect(capped.eligibility).toBe("needs-validation");
    expect(capped.candidate?.directReplayAllowed).toBe(false);
    expect(capped.warnings.join(" ")).toMatch(/never be replayed directly/i);
    expect(capped.validationRequired.length).toBeGreaterThan(0);
  });

  it("is investigable but still not publishable on its own", () => {
    if (prepared.kind !== "infer") return;
    const proposal = applyPolicyCeiling(
      {
        capabilityId: subject.id,
        sourceApplication: SALESFORCE,
        candidate: {
          bindingFamily: "salesforce-record-update",
          mechanism: "A supported Salesforce record-update interface",
          observedTransport: "/aura?aura.RecordUi.updateRecord,r",
          directReplayAllowed: false
        },
        confidence: "high",
        eligibility: "needs-validation",
        evidence: [],
        warnings: [],
        validationRequired: []
      },
      prepared.policy
    );

    expect(isInvestigable(proposal)).toBe(true);
    // A candidate is not a binding: the capability still carries none.
    expect(subject.binding).toBeUndefined();
  });
});

describe("Generic REST", () => {
  const subject = capability("update_customer_email", GENERIC, ["email"]);
  const host = "shop.example.com";
  const page = { host, path: "/customers" };
  const events: CaptureEvent[] = [
    { id: "click-save", kind: "click", t: 1_000, page, actionLabel: "Save" },
    request(host, "patch", 1_030, "PATCH", "/api/customers/:id")
  ];

  it("proposes a REST resource update family, needing validation", () => {
    const prepared = prepare(events, subject);
    expect(prepared.kind).toBe("infer");
    if (prepared.kind !== "infer") return;

    expect(prepared.policy.transportClass).toBe("documented-rest");
    expect(prepared.policy.preferredBindingFamily).toBe("rest-resource-update");
    expect(prepared.policy.maximumEligibility).toBe("needs-validation");
    expect(prepared.input.causalCandidates[0].method).toBe("PATCH");
    expect(prepared.policy.platformIntelligence).toBeUndefined();
  });

  it("never reaches supported-candidate without validation", () => {
    const prepared = prepare(events, subject);
    if (prepared.kind !== "infer") return;
    expect(capEligibility("supported-candidate", prepared.policy.maximumEligibility)).toBe("needs-validation");
  });
});

describe("No safe candidate is a real answer", () => {
  it("returns one when nothing qualified as causal", () => {
    const subject = capability("find_decision_maker_contact", sourceApplicationFor("prospect-intelligence", "127.0.0.1:5173"), ["company"]);
    const page = { host: "127.0.0.1:5173", path: "/prospect/" };
    const prepared = prepare([{ id: "click", kind: "click", t: 100, page, actionLabel: "Maya Chen" }], subject);

    expect(prepared.kind).toBe("no-safe-candidate");
    if (prepared.kind !== "no-safe-candidate") return;
    expect(prepared.proposal.candidate).toBeNull();
    expect(prepared.proposal.eligibility).toBe("no-safe-candidate");
    expect(isInvestigable(prepared.proposal)).toBe(false);
  });

  it("returns one when only background traffic followed the action", () => {
    const host = "app.example.com";
    const page = { host, path: "/x" };
    const events: CaptureEvent[] = [
      { id: "a", kind: "click", t: 1_000, page, actionLabel: "One" },
      request(host, "b1", 1_010, "POST", "/beacon"),
      { id: "c", kind: "click", t: 3_000, page, actionLabel: "Two" },
      request(host, "b2", 3_010, "POST", "/beacon"),
      { id: "d", kind: "click", t: 5_000, page, actionLabel: "Three" },
      request(host, "b3", 5_010, "POST", "/beacon")
    ];
    const prepared = prepare(events, capability("do_something", GENERIC, []));
    expect(prepared.kind).toBe("no-safe-candidate");
  });

  it("returns one when the capability does not know where it was learned", () => {
    const orphan = capability("mystery", GENERIC, []);
    delete orphan.provenance.sourceApplication;
    const prepared = prepare([], orphan);

    expect(prepared.kind).toBe("no-safe-candidate");
    if (prepared.kind !== "no-safe-candidate") return;
    expect(prepared.proposal.warnings.join(" ")).toMatch(/which application/i);
  });

  it("never treats a no-safe-candidate proposal as investigable", () => {
    expect(isInvestigable(noSafeCandidate("x", GENERIC, "nothing observed"))).toBe(false);
  });
});

describe("Eligibility ceiling", () => {
  it("caps downward and leaves caution alone", () => {
    expect(capEligibility("supported-candidate", "needs-validation")).toBe("needs-validation");
    expect(capEligibility("unresolved", "needs-validation")).toBe("unresolved");
    expect(capEligibility("needs-validation", "unresolved")).toBe("unresolved");
  });

  it("treats an unrecognized transport as unresolved rather than guessing", () => {
    const notes = defaultBindingPolicyProvider.notesFor(GENERIC, {
      method: "POST",
      pathPattern: "/x7f2/opaque",
      origin: "https://shop.example.com",
      status: 200
    });
    expect(notes.transportClass).toBe("unknown");
    expect(notes.maximumEligibility).toBe("unresolved");
  });

  it("treats an application with no network as in-process and unresolved", () => {
    const notes = defaultBindingPolicyProvider.notesFor(GENERIC, undefined);
    expect(notes.transportClass).toBe("in-process");
    expect(notes.maximumEligibility).toBe("unresolved");
  });

  it("keeps the Salesforce eligibility ceiling for unrecognized transports", () => {
    const notes = defaultBindingPolicyProvider.notesFor(SALESFORCE, {
      method: "GET",
      pathPattern: "/opaque/lightning/request",
      origin: "https://acme.lightning.force.com",
      status: 200
    });

    expect(notes.transportClass).toBe("unknown");
    expect(notes.maximumEligibility).toBe("needs-validation");
    expect(notes.platformIntelligence?.knowledgeEntryIds).toContain("sf-observed-transport-requires-validation");
  });
});
