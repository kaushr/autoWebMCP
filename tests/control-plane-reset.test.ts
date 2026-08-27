import { describe, expect, it } from "vitest";
import { buildDebugBundle, DEBUG_BUNDLE_VERSION } from "../src/training/debugBundle";
import { CaptureSession } from "../src/capture/session";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BindingInferenceRun } from "../src/training/bindingInference";
import type { ObservationTrace } from "../src/capture/normalize";

/**
 * The reset endpoint lives in server.mjs and owns two Maps. These cover the
 * contract it must satisfy, exercised against the same structures.
 */
function controlPlane() {
  const traces = new Map<string, unknown>();
  const publications = new Map<string, unknown>();

  return {
    traces,
    publications,
    seed() {
      traces.set("sess-a", { sessionId: "sess-a" });
      traces.set("sess-b", { sessionId: "sess-b" });
      publications.set("cap-1", { capability: { id: "cap-1" } });
    },
    reset() {
      const cleared = { traces: traces.size, publications: publications.size };
      traces.clear();
      publications.clear();
      return { cleared: true, ...cleared };
    }
  };
}

describe("Control-plane reset", () => {
  it("clears a populated control plane and reports what it removed", () => {
    const plane = controlPlane();
    plane.seed();

    expect(plane.reset()).toEqual({ cleared: true, traces: 2, publications: 1 });
    expect(plane.traces.size).toBe(0);
    expect(plane.publications.size).toBe(0);
  });

  it("is idempotent", () => {
    const plane = controlPlane();
    plane.seed();
    plane.reset();

    expect(plane.reset()).toEqual({ cleared: true, traces: 0, publications: 0 });
  });

  it("reports counts only, never the artifacts themselves", () => {
    const plane = controlPlane();
    plane.seed();
    const serialized = JSON.stringify(plane.reset());

    expect(serialized).not.toContain("sess-a");
    expect(serialized).not.toContain("cap-1");
    for (const secret of ["Authorization", "Cookie", "sk-", "OPENAI_API_KEY"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("Debug bundle version 2", () => {
  function trace(): ObservationTrace {
    const session = new CaptureSession("sess-binding", 0, {
      host: "acme.lightning.force.com",
      platform: "salesforce-lightning"
    });
    session.addMany([
      {
        id: "click-save",
        kind: "click",
        t: 1_000,
        page: { host: "acme.lightning.force.com", path: "/record" },
        actionLabel: "Save"
      }
    ]);
    session.stop(2_000);
    return session.toTrace();
  }

  const bindingRun: BindingInferenceRun = {
    runId: "bind-1",
    traceSessionId: "sess-binding",
    capabilityId: "update_opportunity_close_date",
    diagnostics: {
      runId: "bind-1",
      requestedAt: "2026-08-27T05:00:00.000Z",
      latencyMs: 1_800,
      model: "gpt-5.4",
      promptVersion: "2026-08-27.1",
      instructions: ["Propose which reusable, supported execution mechanism should be investigated."],
      input: "{}",
      parameters: { store: false, responseFormat: "json_schema", strict: true }
    },
    rawResponse: '{"candidate":{"bindingFamily":"salesforce-record-update"}}'
  };

  it("is versioned 2 and carries the new binding fields", () => {
    const bundle = buildDebugBundle({
      trace: trace(),
      runs: [],
      bindingRuns: [bindingRun],
      exportedAt: "2026-08-27T05:01:00.000Z"
    });

    expect(DEBUG_BUNDLE_VERSION).toBe("2");
    expect(bundle.exportVersion).toBe("2");
    expect(bundle.bindingInferenceRuns).toHaveLength(1);
    expect(bundle.bindingCandidateState).toBe("none");
    expect(bundle.bindingCandidate).toBeNull();
  });

  it("keeps every field an older bundle had", () => {
    const bundle = buildDebugBundle({ trace: trace(), runs: [], exportedAt: "2026-08-27T05:01:00.000Z" });
    for (const key of [
      "exportVersion",
      "exportedAt",
      "session",
      "captureStats",
      "captureStream",
      "normalizedObservations",
      "labels",
      "executionEvidence",
      "semanticizerRuns",
      "capabilityLifecycle"
    ]) {
      expect(bundle).toHaveProperty(key);
    }
  });

  it("excludes binding runs recorded against a different session", () => {
    const bundle = buildDebugBundle({
      trace: trace(),
      runs: [],
      bindingRuns: [{ ...bindingRun, traceSessionId: "sess-elsewhere" }],
      exportedAt: "2026-08-27T05:01:00.000Z"
    });
    expect(bundle.bindingInferenceRuns).toEqual([]);
  });

  it("leaves the execution binding unset even when a candidate exists", () => {
    const source = sourceApplicationFor("salesforce-lightning", "acme.lightning.force.com");
    const bundle = buildDebugBundle({
      trace: trace(),
      runs: [],
      bindingRuns: [bindingRun],
      bindingCandidate: {
        state: "accepted-for-validation",
        proposal: {
          capabilityId: "update_opportunity_close_date",
          sourceApplication: source,
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
        }
      },
      exportedAt: "2026-08-27T05:01:00.000Z"
    });

    // No candidate came from this session's runs, so the lifecycle stays empty
    // and, crucially, publication remains impossible.
    expect(bundle.capabilityLifecycle.executionBinding).toBeNull();
    expect(bundle.capabilityLifecycle.publishable).toBe(false);
  });
});
