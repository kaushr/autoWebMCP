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

describe("CaptureSession persistence", () => {
  it("survives a service-worker restart through a snapshot round trip", () => {
    const session = new CaptureSession("session-4", 1_000, application, { maxEvents: 3 });
    session.add(event("a", 10));
    session.noteRrwebEvents(9);

    const restored = CaptureSession.fromSnapshot(JSON.parse(JSON.stringify(session.toSnapshot())));
    restored.add(event("b", 20));
    restored.stop(2_000);

    const trace = restored.toTrace();
    expect(trace.sessionId).toBe("session-4");
    expect(trace.stats.captureEvents).toBe(2);
    expect(trace.stats.rrwebEvents).toBe(9);
    expect(restored.isRecording()).toBe(false);
  });

  it("refines platform identity once the page has been inspected", () => {
    const session = new CaptureSession("session-5", 0, { host: "example.com", platform: "generic" });
    session.describeApplication({
      host: "acme.lightning.force.com",
      platform: "salesforce-lightning",
      title: "Opportunity"
    });
    expect(session.toTrace().application).toEqual({
      host: "acme.lightning.force.com",
      platform: "salesforce-lightning",
      title: "Opportunity"
    });
  });
});

/* ------------------------------------------------------------------ *
 * A retried batch is one batch, not two.
 *
 * The page holds unsent events and re-sends a batch the service worker did
 * not acknowledge, because an MV3 worker is terminated after about thirty
 * seconds idle and a send landing in that window rejects. Discarding those
 * events silently deleted the click on Save out of a real Salesforce
 * recording — the save's own network call was captured, the click was not,
 * and the proposal then reported, correctly, that no commit action had been
 * observed.
 *
 * Retrying is only safe if the receiving side recognises what it already
 * holds, because a rejected send cannot be distinguished from an
 * acknowledgement that was lost on the way back.
 * ------------------------------------------------------------------ */
describe("a redelivered capture batch", () => {
  it("is recorded once, however many times it arrives", () => {
    const session = new CaptureSession("session-retry", 1_000, application);
    const batch = [event("a", 10), event("b", 20), event("c", 30)];

    session.addMany(batch);
    session.addMany(batch);

    session.stop(2_000);
    expect(session.count()).toBe(3);
    expect((session.toTrace().captureEvents ?? []).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("still accepts events the session has genuinely not seen", () => {
    const session = new CaptureSession("session-retry-2", 1_000, application);
    session.addMany([event("a", 10), event("b", 20)]);
    // The batch that failed, re-sent with what followed it.
    session.addMany([event("a", 10), event("b", 20), event("save", 30)]);

    session.stop(2_000);
    expect((session.toTrace().captureEvents ?? []).map((entry) => entry.id)).toEqual(["a", "b", "save"]);
  });

  it("recognises what a resumed worker already holds", () => {
    // The worker is terminated and restarted mid-recording, rebuilding the
    // session from its snapshot. Without the ids coming back with it, the
    // very next retry would double every event it had already stored.
    const original = new CaptureSession("session-resume", 1_000, application);
    original.addMany([event("a", 10), event("b", 20)]);

    const resumed = CaptureSession.fromSnapshot(original.toSnapshot());
    resumed.addMany([event("a", 10), event("b", 20), event("save", 30)]);

    resumed.stop(2_000);
    expect((resumed.toTrace().captureEvents ?? []).map((entry) => entry.id)).toEqual(["a", "b", "save"]);
  });
});
