import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import type { CaptureApplicationContext, CaptureEvent } from "../src/capture/types";

const application: CaptureApplicationContext = {
  host: "127.0.0.1",
  platform: "prospect-intelligence",
  title: "Prospect Intelligence"
};

function event(id: string, t: number, overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    id,
    kind: "click",
    t,
    page: { host: "127.0.0.1", path: "/" },
    actionLabel: `Action ${id}`,
    ...overrides
  };
}

describe("CaptureSession lifecycle", () => {
  it("collects evidence only while recording and emits one trace on stop", () => {
    const session = new CaptureSession("session-1", 1_000, application);
    session.add(event("a", 10));
    session.add(event("b", 20));
    session.noteRrwebEvents(42);

    expect(session.isRecording()).toBe(true);
    expect(session.count()).toBe(2);

    session.stop(4_000);
    session.add(event("c", 30));

    const trace = session.toTrace();
    expect(session.getStatus()).toBe("stopped");
    expect(session.count()).toBe(2);
    expect(trace.sessionId).toBe("session-1");
    expect(trace.application).toEqual(application);
    expect(trace.startedAt).toBe(new Date(1_000).toISOString());
    expect(trace.endedAt).toBe(new Date(4_000).toISOString());
    expect(trace.stats).toEqual({
      rrwebEvents: 42,
      captureEvents: 2,
      observations: 2,
      droppedEvents: 0
    });
  });

  it("bounds retained evidence instead of growing without limit", () => {
    const session = new CaptureSession("session-2", 0, application, { maxEvents: 2 });
    session.addMany([event("a", 1), event("b", 2), event("c", 3), event("d", 4)]);
    session.stop(5);

    expect(session.count()).toBe(2);
    expect(session.toTrace().stats.droppedEvents).toBe(2);
  });

  it("stopping twice keeps the first end time", () => {
    const session = new CaptureSession("session-3", 0, application);
    session.stop(100);
    session.stop(900);
    expect(session.toTrace().endedAt).toBe(new Date(100).toISOString());
  });
});
