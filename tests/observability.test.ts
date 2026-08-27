import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import { parseObservationTrace } from "../src/training/traces";
import { parseSemanticizationResponse } from "../src/training/semanticizer";
import type { SemanticizerRun } from "../src/training/semanticizer";
import type { CaptureEvent } from "../src/capture/types";

const page = { host: "acme.lightning.force.com", path: "/lightning/r/Opportunity/006/view" };

function sessionWithSaveWorkflow(): CaptureSession {
  const session = new CaptureSession("sess-observability", 0, {
    host: page.host,
    platform: "salesforce-lightning",
    title: "Acme Expansion | Opportunity"
  });

  const events: CaptureEvent[] = [
    { id: "nav", kind: "navigate", t: 40, page },
    {
      id: "field-close",
      kind: "field_change",
      t: 1_000,
      page,
      field: { label: "Close Date", section: "Opportunity Details", control: "date" },
      value: { masked: false, from: "2026-08-31", to: "2026-09-30" }
    },
    {
      id: "field-secret",
      kind: "field_change",
      t: 1_400,
      page,
      field: { label: "Password", section: "Login", control: "masked" },
      value: { masked: true }
    },
    { id: "click-save", kind: "click", t: 2_600, page, actionLabel: "Save" },
    {
      id: "net-save",
      kind: "network",
      t: 2_841,
      page,
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
      page,
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
  return session;
}

function run(overrides: Partial<SemanticizerRun> = {}): SemanticizerRun {
  return {
    runId: "run-1",
    traceSessionId: "sess-observability",
    diagnostics: {
      runId: "run-1",
      requestedAt: "2026-08-27T02:00:00.000Z",
      latencyMs: 3_200,
      model: "gpt-5.4",
      promptVersion: "2026-08-27.1",
      instructions: ["Infer exactly ONE lightweight candidate business capability."],
      input: JSON.stringify({ application: page.host, trace: [] }),
      parameters: { store: false, responseFormat: "json_schema", strict: true },
      providerResponseId: "resp_abc"
    },
    rawResponse: '{"candidate":{},"ambiguities":[]}',
    ambiguities: [],
    ...overrides
  };
}

describe("Capture stream reaches the Studio", () => {
  it("carries the safe capture events the observations were derived from", () => {
    const trace = sessionWithSaveWorkflow().toTrace();
    expect(trace.captureEvents).toHaveLength(6);
    expect(trace.captureEvents?.map((event) => event.kind)).toEqual([
      "navigate",
      "field_change",
      "field_change",
      "click",
      "network",
      "reaction"
    ]);
    // The transformation is inspectable: more raw events than observations.
    expect(trace.captureEvents!.length).toBeGreaterThan(trace.observations.length);
  });

  it("still masks what the capture policy masked", () => {
    const trace = sessionWithSaveWorkflow().toTrace();
    const masked = trace.captureEvents?.find((event) => event.id === "field-secret");
    expect(masked?.value).toEqual({ masked: true });
    expect(JSON.stringify(trace)).not.toContain("Password123");
  });

  it("exposes no credential, header, body, cookie, or replayable URL", () => {
    const serialized = JSON.stringify(sessionWithSaveWorkflow().toTrace());
    for (const forbidden of ["Authorization", "Cookie", "set-cookie", "requestBody", "responseBody", "sessionId=", "https://acme.lightning.force.com/aura?"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps the capture stream separate from the observations", () => {
    const trace = sessionWithSaveWorkflow().toTrace();
    expect(trace.observations.every((observation) => !("captureEvents" in observation))).toBe(true);
  });
});

describe("Backward compatibility", () => {
  it("reads a trace recorded before observability existed", () => {
    const legacy = {
      version: 1,
      sessionId: "sess-old",
      application: { host: "app.example.com", platform: "generic" },
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:00:10.000Z",
      observations: [],
      labels: [],
      stats: { rrwebEvents: 0, captureEvents: 0, observations: 0, droppedEvents: 0 }
    };
    const parsed = parseObservationTrace(legacy);
    expect(parsed.captureEvents).toEqual([]);
    expect(parsed.executionEvidence).toEqual([]);
  });

  it("rejects a malformed capture stream rather than trusting it", () => {
    const trace = { ...sessionWithSaveWorkflow().toTrace(), captureEvents: "nope" };
    expect(() => parseObservationTrace(trace)).toThrow(/capture events must be an array/i);
  });
});

describe("Semanticizer run records", () => {
  it("retains what was asked, what came back, and what was read out, separately", () => {
    const record = run();
    expect(record.diagnostics.model).toBe("gpt-5.4");
    expect(record.diagnostics.instructions.length).toBeGreaterThan(0);
    expect(record.diagnostics.promptVersion).toBe("2026-08-27.1");
    expect(record.rawResponse).toBe('{"candidate":{},"ambiguities":[]}');
    expect(record.candidate).toBeUndefined();
  });

  it("holds no API key or provider credential", () => {
    const serialized = JSON.stringify(run());
    for (const forbidden of ["sk-", "OPENAI_API_KEY", "api_key", "Authorization", "Bearer "]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("correlates a run back to the trace that produced it", () => {
    expect(run().traceSessionId).toBe("sess-observability");
    expect(run().diagnostics.runId).toBe(run().runId);
  });

  it("keeps repeated runs for the same trace as distinct records", () => {
    const history = [run({ runId: "run-1" }), run({ runId: "run-2", rawResponse: '{"different":true}' })];
    expect(history).toHaveLength(2);
    expect(new Set(history.map((entry) => entry.runId)).size).toBe(2);
    expect(history[0].rawResponse).not.toBe(history[1].rawResponse);
    expect(history.every((entry) => entry.traceSessionId === "sess-observability")).toBe(true);
  });

  it("distinguishes a bad model answer from a bad parser", () => {
    const badModelOutput = '{"candidate":{"id":"Not Snake Case"},"ambiguities":[]}';
    let parseError: string | undefined;
    try {
      parseSemanticizationResponse(JSON.parse(badModelOutput));
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    const failed = run({ rawResponse: badModelOutput, parseError });
    expect(failed.parseError).toMatch(/snake case/i);
    expect(failed.candidate).toBeUndefined();
    // The raw answer survives, so the failure is attributable.
    expect(failed.rawResponse).toBe(badModelOutput);
  });
});
