import { describe, expect, it } from "vitest";
import {
  DEBUG_BUNDLE_VERSION,
  buildDebugBundle,
  debugBundleFilename,
  serializeDebugBundle
} from "../src/training/debugBundle";
import { CaptureSession } from "../src/capture/session";
import { confirmCandidate } from "../src/training/semanticizer";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { SemanticizerRun } from "../src/training/semanticizer";
import type { ObservationTrace } from "../src/capture/normalize";
import type { SemanticCapability } from "../src/semantic/model";
import type { CaptureEvent } from "../src/capture/types";

const EXPORTED_AT = "2026-08-27T04:00:00.000Z";
const sfPage = { host: "acme.lightning.force.com", path: "/lightning/r/Opportunity/006/view" };

function salesforceTrace(): ObservationTrace {
  const session = new CaptureSession("sess-sf-close-date", 0, {
    host: sfPage.host,
    platform: "salesforce-lightning",
    title: "Acme Expansion | Opportunity"
  });

  const events: CaptureEvent[] = [
    { id: "nav", kind: "navigate", t: 40, page: sfPage },
    {
      id: "field-close",
      kind: "field_change",
      t: 1_000,
      page: sfPage,
      field: { label: "Close Date", section: "Opportunity Details", control: "date" },
      value: { masked: false, from: "2026-08-31", to: "2026-09-30" }
    },
    { id: "click-save", kind: "click", t: 2_600, page: sfPage, actionLabel: "Save" },
    {
      id: "net-save",
      kind: "network",
      t: 2_841,
      page: sfPage,
      network: {
        requestId: "save-1",
        method: "POST",
        origin: "https://acme.lightning.force.com",
        endpoint: "/aura?other.RecordUi.saveRecord,r",
        resourceType: "xmlhttprequest",
        status: 200,
        ok: true,
        failed: false,
        startedAt: 2_637,
        completedAt: 2_841,
        durationMs: 204,
        category: "mutation"
      }
    },
    {
      id: "reaction-save",
      kind: "reaction",
      t: 2_910,
      page: sfPage,
      correlatesWith: "click-save",
      reaction: {
        domMutations: 8,
        urlChanged: false,
        validationShown: false,
        fieldsAppeared: false,
        dialogShown: false,
        toastShown: true,
        contentChanged: true
      }
    }
  ];

  session.addMany(events);
  session.stop(4_000);
  return session.toTrace();
}

function proposal(id: string, overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  return {
    id,
    name: "Update opportunity close date",
    description: "Change an opportunity's close date and save the record.",
    inputs: [{ name: "close_date", description: "The new close date.", type: "string", required: true }],
    outputs: [{ name: "opportunity", description: "The updated record.", type: "object" }],
    provenance: {
      source: "inferred",
      observationIds: ["click-save"],
      confirmedByHuman: false,
      sourceApplication: sourceApplicationFor("salesforce-lightning", sfPage.host)
    },
    safety: { readOnly: false, requiresConfirmation: true },
    ...overrides
  };
}

function run(sessionId: string, overrides: Partial<SemanticizerRun> = {}): SemanticizerRun {
  const runId = overrides.runId ?? "run-1";
  return {
    runId,
    traceSessionId: sessionId,
    diagnostics: {
      runId,
      requestedAt: "2026-08-27T03:00:00.000Z",
      latencyMs: 2_999,
      model: "gpt-5.4",
      promptVersion: "2026-08-27.1",
      instructions: ["Infer exactly ONE lightweight candidate business capability."],
      input: JSON.stringify({ application: sfPage.host, trace: [] }),
      parameters: { store: false, responseFormat: "json_schema", strict: true },
      providerResponseId: "resp_abc123"
    },
    rawResponse: '{"candidate":{"id":"update_opportunity_close_date"},"ambiguities":[]}',
    ambiguities: [],
    ...overrides
  };
}

describe("A complete Salesforce bundle", () => {
  const candidate = proposal("update_opportunity_close_date");
  const bundle = buildDebugBundle({
    trace: salesforceTrace(),
    runs: [run("sess-sf-close-date", { candidate })],
    candidate,
    exportedAt: EXPORTED_AT
  });

  it("is versioned and stamped", () => {
    expect(bundle.exportVersion).toBe(DEBUG_BUNDLE_VERSION);
    expect(bundle.exportedAt).toBe(EXPORTED_AT);
  });

  it("identifies the session without leaking the record", () => {
    expect(bundle.session.sourceApplication).toEqual({ id: "salesforce-lightning", label: "Salesforce" });
    expect(bundle.session.id).toBe("sess-sf-close-date");
    expect(bundle.session.host).toBe("acme.lightning.force.com");
    expect(JSON.stringify(bundle.session)).not.toMatch(/006[A-Za-z0-9]{12,}/);
  });

  it("carries the capture stream, the observations, and the evidence", () => {
    expect(bundle.captureStream).toHaveLength(5);
    expect(bundle.captureStreamUnavailableReason).toBeUndefined();
    expect(bundle.normalizedObservations.map((observation) => observation.action)).toEqual([
      "navigate",
      "field_change",
      "save"
    ]);
    expect(bundle.executionEvidence).toHaveLength(1);
  });

  it("keeps the scoring reasons and the background classification", () => {
    const effect = bundle.executionEvidence[0].networkEffects[0];
    expect(effect.confidence).toBe("high");
    expect(effect.reasons).toContain("+ mutation request (POST)");
    expect(effect.reasons).toContain("+ application reacted after it completed");
    expect(effect.backgroundLikely).toBe(false);
    expect(effect.bindingEligibility).toBe("unresolved");
  });

  it("keeps the raw model response and the parsed result apart", () => {
    const exported = bundle.semanticizerRuns[0];
    expect(exported.rawResponse).toContain("update_opportunity_close_date");
    expect(exported.candidate?.id).toBe("update_opportunity_close_date");
    expect(exported.diagnostics.model).toBe("gpt-5.4");
    expect(exported.diagnostics.promptVersion).toBe("2026-08-27.1");
    expect(exported.diagnostics.instructions.length).toBeGreaterThan(0);
  });
});

describe("Honest about what does not exist", () => {
  it("says why the capture stream is missing rather than exporting an empty array", () => {
    const legacy: ObservationTrace = { ...salesforceTrace(), captureEvents: [] };
    const bundle = buildDebugBundle({ trace: legacy, runs: [], exportedAt: EXPORTED_AT });
    expect(bundle.captureStream).toBeNull();
    expect(bundle.captureStreamUnavailableReason).toMatch(/predates|no events/i);
  });

  it("survives a trace recorded before execution evidence existed", () => {
    const { executionEvidence: _dropped, ...legacy } = salesforceTrace();
    const bundle = buildDebugBundle({ trace: legacy as ObservationTrace, runs: [], exportedAt: EXPORTED_AT });
    expect(bundle.executionEvidence).toEqual([]);
  });

  it("exports empty run history and a null lifecycle when nothing was proposed", () => {
    const bundle = buildDebugBundle({ trace: salesforceTrace(), runs: [], exportedAt: EXPORTED_AT });
    expect(bundle.semanticizerRuns).toEqual([]);
    expect(bundle.capabilityLifecycle.candidate).toBeNull();
    expect(bundle.capabilityLifecycle.semanticConfirmation).toBeNull();
    expect(bundle.capabilityLifecycle.executionBinding).toBeNull();
    expect(bundle.capabilityLifecycle.publication).toBeNull();
    expect(bundle.capabilityLifecycle.publishable).toBe(false);
  });

  it("reports no network evidence for an application that works in-process", () => {
    const signalbase = new CaptureSession("sess-signalbase", 0, {
      host: "127.0.0.1:5173",
      platform: "prospect-intelligence"
    });
    signalbase.addMany([
      { id: "click", kind: "click", t: 100, page: { host: "127.0.0.1:5173", path: "/prospect/" }, actionLabel: "Maya Chen" }
    ]);
    signalbase.stop(500);

    const bundle = buildDebugBundle({ trace: signalbase.toTrace(), runs: [], exportedAt: EXPORTED_AT });
    expect(bundle.executionEvidence).toEqual([]);
    expect(bundle.session.sourceApplication.label).toBe("SignalBase");
  });
});

describe("Capability lifecycle", () => {
  it("exports a confirmed-but-unbound Salesforce capability as blocked", () => {
    const candidate = confirmCandidate(proposal("update_opportunity_close_date"));
    const bundle = buildDebugBundle({
      trace: salesforceTrace(),
      runs: [run("sess-sf-close-date", { candidate })],
      candidate,
      exportedAt: EXPORTED_AT
    });

    expect(bundle.capabilityLifecycle.semanticConfirmation).toBe("confirmed");
    expect(bundle.capabilityLifecycle.executionBinding).toBeNull();
    expect(bundle.capabilityLifecycle.publishable).toBe(false);
    expect(bundle.capabilityLifecycle.publication).toBeNull();
  });

  it("exports a published SignalBase capability with its binding", () => {
    const signalbase = new CaptureSession("sess-signalbase", 0, {
      host: "127.0.0.1:5173",
      platform: "prospect-intelligence"
    });
    signalbase.addMany([
      { id: "click", kind: "click", t: 100, page: { host: "127.0.0.1:5173", path: "/prospect/" }, actionLabel: "Maya Chen" }
    ]);
    signalbase.stop(500);

    const candidate = confirmCandidate({
      ...proposal("find_decision_maker_contact", {
        name: "Find decision maker contact",
        binding: { application: "prospect-intelligence", action: "find_relevant_contacts" }
      }),
      provenance: {
        source: "inferred",
        observationIds: ["click"],
        confirmedByHuman: false,
        sourceApplication: sourceApplicationFor("prospect-intelligence", "127.0.0.1:5173")
      }
    });

    const bundle = buildDebugBundle({
      trace: signalbase.toTrace(),
      runs: [run("sess-signalbase", { candidate })],
      candidate,
      publications: [{ capability: candidate, publishedAt: "2026-08-27T03:30:00.000Z" }],
      exportedAt: EXPORTED_AT
    });

    expect(bundle.capabilityLifecycle.executionBinding).toEqual({
      application: "prospect-intelligence",
      action: "find_relevant_contacts",
      parameters: ["company", "function", "seniority", "title_keywords"]
    });
    expect(bundle.capabilityLifecycle.publishable).toBe(true);
    expect(bundle.capabilityLifecycle.publication?.capabilityId).toBe("find_decision_maker_contact");
  });

  it("refuses to export a candidate that belongs to a different capture", () => {
    const other = proposal("something_else");
    const bundle = buildDebugBundle({
      trace: salesforceTrace(),
      runs: [run("sess-a-different-session", { candidate: other })],
      candidate: other,
      exportedAt: EXPORTED_AT
    });

    expect(bundle.semanticizerRuns).toEqual([]);
    expect(bundle.capabilityLifecycle.candidate).toBeNull();
  });
});

describe("Multiple semantic inference runs", () => {
  it("exports every run for the session, oldest first", () => {
    const bundle = buildDebugBundle({
      trace: salesforceTrace(),
      runs: [
        run("sess-sf-close-date", {
          runId: "run-2",
          diagnostics: { ...run("sess-sf-close-date").diagnostics, runId: "run-2", requestedAt: "2026-08-27T03:10:00.000Z" }
        }),
        run("sess-sf-close-date", { runId: "run-1" }),
        run("sess-other", { runId: "run-elsewhere" })
      ],
      exportedAt: EXPORTED_AT
    });

    expect(bundle.semanticizerRuns.map((entry) => entry.runId)).toEqual(["run-1", "run-2"]);
  });

  it("keeps a run whose response could not be parsed", () => {
    const failed = run("sess-sf-close-date", {
      rawResponse: '{"candidate":{"id":"Not Snake Case"}}',
      parseError: "Capability id must be lower snake case: Not Snake Case"
    });
    const bundle = buildDebugBundle({ trace: salesforceTrace(), runs: [failed], exportedAt: EXPORTED_AT });

    expect(bundle.semanticizerRuns[0].parseError).toMatch(/snake case/i);
    expect(bundle.semanticizerRuns[0].candidate).toBeUndefined();
    expect(bundle.semanticizerRuns[0].rawResponse).toContain("Not Snake Case");
  });
});

describe("The privacy boundary holds in the export", () => {
  it("contains no credential, header, body, token, or replayable URL", () => {
    const candidate = confirmCandidate(proposal("update_opportunity_close_date"));
    const serialized = serializeDebugBundle(
      buildDebugBundle({
        trace: salesforceTrace(),
        runs: [run("sess-sf-close-date", { candidate })],
        candidate,
        exportedAt: EXPORTED_AT
      })
    );

    const forbidden = [
      "Authorization",
      "Bearer ",
      "Cookie",
      "set-cookie",
      "sid=",
      "sessionId=",
      "csrf",
      "OPENAI_API_KEY",
      "sk-",
      "api_key",
      "requestBody",
      "responseBody",
      "chain_of_thought",
      "reasoning_content",
      "https://acme.lightning.force.com/aura?"
    ];
    for (const pattern of forbidden) {
      expect(serialized).not.toContain(pattern);
    }

    // The generalized endpoint survives; the concrete URL never existed.
    expect(serialized).toContain("/aura?other.RecordUi.saveRecord,r");
  });

  it("is pretty-printed so a human can read it", () => {
    const serialized = serializeDebugBundle(
      buildDebugBundle({ trace: salesforceTrace(), runs: [], exportedAt: EXPORTED_AT })
    );
    expect(serialized.split("\n").length).toBeGreaterThan(20);
    expect(JSON.parse(serialized).exportVersion).toBe(DEBUG_BUNDLE_VERSION);
  });
});

describe("Export filename", () => {
  it("derives a safe filename from the session id", () => {
    expect(debugBundleFilename("sess-mtawmwqx-z30tzu")).toBe("autowebmcp-session-sess-mtawmwqx-z30tzu.json");
  });

  it("strips anything a filesystem would object to", () => {
    expect(debugBundleFilename("../../etc/passwd")).toBe("autowebmcp-session-etc-passwd.json");
    expect(debugBundleFilename("Sess ID/With:Chars")).toBe("autowebmcp-session-sess-id-with-chars.json");
    expect(debugBundleFilename("")).toBe("autowebmcp-session-unknown.json");
  });
});
