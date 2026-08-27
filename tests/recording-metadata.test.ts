import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import {
  parseObservationTrace,
  summarizeTrace,
  summaryDurationMs,
  withRecordingMetadata
} from "../src/training/traces";
import { buildDebugBundle } from "../src/training/debugBundle";
import type { CaptureEvent } from "../src/capture/types";

function recordedSession(recording?: { name?: string; description?: string }): CaptureSession {
  const session = new CaptureSession("sess-meta", 1_000, {
    host: "demo.lightning.force.com",
    platform: "salesforce-lightning",
    title: "PS Project Test | Opportunity | Salesforce"
  });
  if (recording) session.describeRecording(recording);
  const events: CaptureEvent[] = [
    { id: "nav", kind: "navigate", t: 0, page: { host: "demo.lightning.force.com", path: "/x" } },
    {
      id: "edit",
      kind: "field_change",
      t: 4_000,
      page: { host: "demo.lightning.force.com", path: "/x" },
      field: { label: "*Close Date", control: "date" },
      value: { masked: false, to: "2027-03-01" }
    },
    { id: "save", kind: "click", t: 9_000, page: { host: "demo.lightning.force.com", path: "/x" }, actionLabel: "Save" }
  ];
  session.addMany(events);
  session.stop(15_000);
  return session;
}

describe("1 — a named recording survives capture → handoff → summary", () => {
  it("carries name and description through the session snapshot, the trace, the handoff parser, and the Studio summary", () => {
    const session = recordedSession({
      name: "Update Opportunity Close Date test",
      description: "Testing Salesforce browser execution against Close Date."
    });

    // Service workers get suspended mid-session; metadata must survive the round trip.
    const restored = CaptureSession.fromSnapshot(session.toSnapshot());
    const trace = restored.toTrace();
    expect(trace.recording?.name).toBe("Update Opportunity Close Date test");

    // What the extension POSTs is what the Studio parses back.
    const parsed = parseObservationTrace(JSON.parse(JSON.stringify(trace)));
    const summary = summarizeTrace(parsed, "2026-08-27T09:00:00.000Z");
    expect(summary.name).toBe("Update Opportunity Close Date test");
    expect(summary.description).toBe("Testing Salesforce browser execution against Close Date.");
  });
});

describe("2 — a recording without custom metadata falls back cleanly", () => {
  it("keeps the derived page title and carries no invented name", () => {
    const summary = summarizeTrace(recordedSession().toTrace(), "2026-08-27T09:00:00.000Z");
    expect(summary.name).toBeUndefined();
    expect(summary.description).toBeUndefined();
    expect(summary.title).toBe("PS Project Test | Opportunity | Salesforce");
  });

  it("whitespace-only metadata is treated as absent", () => {
    const summary = summarizeTrace(recordedSession({ name: "   ", description: "  " }).toTrace(), "x");
    expect(summary.name).toBeUndefined();
  });
});

describe("3 — editing metadata never changes the evidence", () => {
  it("changes only the recording block; identity, events, observations and stats are the same values", () => {
    const trace = recordedSession({ name: "Before" }).toTrace();
    const edited = withRecordingMetadata(trace, { name: "After", description: "New note" });

    expect(edited.recording).toEqual({ name: "After", description: "New note" });
    expect(edited.sessionId).toBe(trace.sessionId);
    expect(edited.observations).toBe(trace.observations);
    expect(edited.captureEvents).toBe(trace.captureEvents);
    expect(edited.executionEvidence).toBe(trace.executionEvidence);
    expect(edited.stats).toEqual(trace.stats);
    expect(edited.startedAt).toBe(trace.startedAt);
  });

  it("clearing both fields removes the recording block entirely", () => {
    const trace = recordedSession({ name: "Something" }).toTrace();
    expect(withRecordingMetadata(trace, { name: "", description: "" }).recording).toBeUndefined();
  });
});

describe("4 & 5 — provenance on cards: timestamp, observations, duration", () => {
  it("the summary carries the ISO capture timestamp, end, and observation count", () => {
    const summary = summarizeTrace(recordedSession().toTrace(), "2026-08-27T09:00:00.000Z");
    expect(summary.startedAt).toBe(new Date(1_000).toISOString());
    expect(summary.endedAt).toBe(new Date(15_000).toISOString());
    expect(summary.observations).toBeGreaterThan(0);
  });

  it("duration derives from start/end, and is honestly absent without an end", () => {
    expect(summaryDurationMs({ startedAt: new Date(1_000).toISOString(), endedAt: new Date(15_000).toISOString() })).toBe(14_000);
    expect(summaryDurationMs({ startedAt: new Date(1_000).toISOString() })).toBeUndefined();
    expect(summaryDurationMs({ startedAt: "not-a-date", endedAt: "also-not" })).toBeUndefined();
  });
});

describe("6 — no invented user identity", () => {
  it("neither the summary nor the export claims a user, because AutoWebMCP has no authenticated actor", () => {
    const trace = recordedSession({ name: "Named" }).toTrace();
    const summary = summarizeTrace(trace, "x");
    const bundle = buildDebugBundle({ trace, runs: [], exportedAt: "2026-08-27T09:00:00.000Z" });

    expect(Object.keys(summary)).not.toContain("user");
    expect(Object.keys(bundle.session)).not.toContain("user");
  });
});

describe("16 — the debug bundle exports the recording metadata", () => {
  it("includes name and description verbatim in the session section", () => {
    const trace = recordedSession({ name: "Named run", description: "For export" }).toTrace();
    const bundle = buildDebugBundle({ trace, runs: [], exportedAt: "2026-08-27T09:00:00.000Z" });
    expect(bundle.session.recording).toEqual({ name: "Named run", description: "For export" });
  });
});

describe("17 — reset clears traces together with their metadata", () => {
  it("metadata lives inside the stored trace, so clearing the store removes both at once", () => {
    // Mirrors the server's storage shape: one Map entry per trace, metadata embedded.
    const traces = new Map<string, { trace: unknown }>();
    traces.set("sess-meta", { trace: recordedSession({ name: "Doomed" }).toTrace() });

    traces.clear();
    expect(traces.size).toBe(0);
  });
});
