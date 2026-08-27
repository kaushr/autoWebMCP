import { collectLabels, normalizeCapture, type ObservationTrace } from "./normalize";
import { correlateExecutionEvidence } from "./execution";
import type { CaptureApplicationContext, CaptureEvent } from "./types";

export type CaptureSessionStatus = "recording" | "stopped";

export interface CaptureSessionOptions {
  /** Upper bound on retained raw capture events; excess events are dropped. */
  maxEvents?: number;
}

/**
 * Serializable session state. An extension service worker may be suspended
 * mid-session, so the lifecycle has to survive a round trip through storage.
 */
export interface CaptureSessionSnapshot {
  id: string;
  startedAt: number;
  application: CaptureApplicationContext;
  status: CaptureSessionStatus;
  endedAt?: number;
  events: CaptureEvent[];
  rrwebEvents: number;
  dropped: number;
  maxEvents: number;
}

const DEFAULT_MAX_EVENTS = 800;

/**
 * Teach Mode session lifecycle, deliberately free of any browser-extension
 * API so it can be unit tested and reused by the Training Studio. The
 * extension service worker owns one instance per recording tab.
 *
 * A session is explicitly started and stopped by a human, holds evidence in
 * memory only, and produces one normalized `ObservationTrace` on stop.
 */
export class CaptureSession {
  readonly id: string;
  readonly startedAt: number;
  readonly application: CaptureApplicationContext;

  private readonly events: CaptureEvent[] = [];
  private readonly maxEvents: number;
  private status: CaptureSessionStatus = "recording";
  private endedAt?: number;
  private rrwebEvents = 0;
  private dropped = 0;

  constructor(
    id: string,
    startedAt: number,
    application: CaptureApplicationContext,
    options: CaptureSessionOptions = {}
  ) {
    this.id = id;
    this.startedAt = startedAt;
    this.application = application;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  static fromSnapshot(snapshot: CaptureSessionSnapshot): CaptureSession {
    const session = new CaptureSession(snapshot.id, snapshot.startedAt, snapshot.application, {
      maxEvents: snapshot.maxEvents
    });
    session.events.push(...snapshot.events);
    session.rrwebEvents = snapshot.rrwebEvents;
    session.dropped = snapshot.dropped;
    session.status = snapshot.status;
    session.endedAt = snapshot.endedAt;
    return session;
  }

  toSnapshot(): CaptureSessionSnapshot {
    return {
      id: this.id,
      startedAt: this.startedAt,
      application: this.application,
      status: this.status,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      events: [...this.events],
      rrwebEvents: this.rrwebEvents,
      dropped: this.dropped,
      maxEvents: this.maxEvents
    };
  }

  /** Platform identity is refined once the content script has inspected the page. */
  describeApplication(application: CaptureApplicationContext): void {
    this.application.host = application.host;
    this.application.platform = application.platform;
    if (application.title) this.application.title = application.title;
  }

  getStatus(): CaptureSessionStatus {
    return this.status;
  }

  isRecording(): boolean {
    return this.status === "recording";
  }

  add(event: CaptureEvent): void {
    if (this.status !== "recording") return;
    if (this.events.length >= this.maxEvents) {
      this.dropped += 1;
      return;
    }
    this.events.push(event);
  }

  addMany(events: readonly CaptureEvent[]): void {
    for (const event of events) this.add(event);
  }

  /** Records how many raw rrweb events the sensor produced. The events themselves stay in the page. */
  noteRrwebEvents(count: number): void {
    if (count > this.rrwebEvents) this.rrwebEvents = count;
  }

  /** Capture events retained so far, mainly for live status display. */
  count(): number {
    return this.events.length;
  }

  stop(endedAt: number): void {
    if (this.status === "stopped") return;
    this.status = "stopped";
    this.endedAt = endedAt;
  }

  toTrace(): ObservationTrace {
    const observations = normalizeCapture(this.events);
    return {
      version: 1,
      sessionId: this.id,
      application: this.application,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date(this.endedAt ?? this.startedAt).toISOString(),
      observations,
      executionEvidence: correlateExecutionEvidence(this.events, observations),
      labels: collectLabels(observations),
      stats: {
        rrwebEvents: this.rrwebEvents,
        captureEvents: this.events.length,
        observations: observations.length,
        droppedEvents: this.dropped
      }
    };
  }
}
