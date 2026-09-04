import type { ObservationTrace, RecordingMetadata } from "../capture/normalize";

/** One extension-captured trace as summarized by the Training Studio list. */
export interface TraceSummary {
  sessionId: string;
  application: string;
  platform: string;
  title?: string;
  /** Human-supplied recording name; the derived page title is the fallback. */
  name?: string;
  description?: string;
  startedAt: string;
  endedAt?: string;
  observations: number;
  receivedAt: string;
}

export function summarizeTrace(trace: ObservationTrace, receivedAt: string): TraceSummary {
  return {
    sessionId: trace.sessionId,
    application: trace.application.host,
    platform: trace.application.platform,
    ...(trace.application.title ? { title: trace.application.title } : {}),
    ...(trace.recording?.name ? { name: trace.recording.name } : {}),
    ...(trace.recording?.description ? { description: trace.recording.description } : {}),
    startedAt: trace.startedAt,
    ...(trace.endedAt ? { endedAt: trace.endedAt } : {}),
    observations: trace.observations.length,
    receivedAt
  };
}

/** Guards the handoff boundary: the Studio only accepts a well-formed trace. */
export function parseObservationTrace(value: unknown): ObservationTrace {
  if (typeof value !== "object" || value === null) throw new Error("A trace object is required.");
  const trace = value as Partial<ObservationTrace>;

  if (trace.version !== 1) throw new Error("Unsupported trace version.");
  if (typeof trace.sessionId !== "string" || trace.sessionId === "") throw new Error("Trace sessionId is required.");
  if (typeof trace.application?.host !== "string") throw new Error("Trace application context is required.");
  if (!Array.isArray(trace.observations)) throw new Error("Trace observations must be an array.");
  if (!Array.isArray(trace.labels)) throw new Error("Trace labels must be an array.");

  // Execution evidence and the capture stream arrived after the first traces
  // did; an older trace is still a valid trace, it simply carries neither.
  if (trace.executionEvidence !== undefined && !Array.isArray(trace.executionEvidence)) {
    throw new Error("Trace execution evidence must be an array.");
  }
  if (trace.captureEvents !== undefined && !Array.isArray(trace.captureEvents)) {
    throw new Error("Trace capture events must be an array.");
  }
  return {
    ...(trace as ObservationTrace),
    executionEvidence: trace.executionEvidence ?? [],
    captureEvents: trace.captureEvents ?? []
  };
}

export async function listTraces(): Promise<TraceSummary[]> {
  const response = await fetch("/api/traces");
  if (!response.ok) throw new Error(`Could not list extension traces (${response.status}).`);
  const body = (await response.json()) as { traces?: TraceSummary[] };
  return body.traces ?? [];
}

/** Removes one recording. Irreversible: traces are held in memory only. */
export async function deleteTrace(sessionId: string): Promise<void> {
  const response = await fetch(`/api/traces/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Could not delete trace ${sessionId} (${response.status}).`);
}

/**
 * Empties the control plane's recordings. Publications are untouched — a
 * clean run of the training flow is not a decision to unregister every
 * tool an agent can currently call.
 *
 * Irreversible: traces are held in memory and never written to disk, so
 * there is nothing to restore them from.
 */
export async function clearTraces(): Promise<number> {
  const response = await fetch("/api/traces", { method: "DELETE" });
  if (!response.ok) throw new Error(`Could not clear traces (${response.status}).`);
  const body = (await response.json()) as { removed?: number };
  return body.removed ?? 0;
}

export async function getTrace(sessionId: string): Promise<ObservationTrace> {
  const response = await fetch(`/api/traces/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw new Error(`Could not load trace ${sessionId} (${response.status}).`);
  return parseObservationTrace(await response.json());
}

/** Recording duration when both ends were captured; absent otherwise. */
export function summaryDurationMs(summary: Pick<TraceSummary, "startedAt" | "endedAt">): number | undefined {
  if (!summary.endedAt) return undefined;
  const started = Date.parse(summary.startedAt);
  const ended = Date.parse(summary.endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) return undefined;
  return ended - started;
}

/**
 * A trace with only its human-supplied metadata changed. Everything the
 * session captured — identity, events, observations, evidence — is the same
 * object graph as before, which is the whole contract of editing a name.
 */
export function withRecordingMetadata(trace: ObservationTrace, recording: RecordingMetadata): ObservationTrace {
  const name = recording.name?.trim();
  const description = recording.description?.trim();
  if (!name && !description) {
    const { recording: _dropped, ...rest } = trace;
    return rest as ObservationTrace;
  }
  return { ...trace, recording: { ...(name ? { name } : {}), ...(description ? { description } : {}) } };
}

/** Updates a stored trace's recording metadata; evidence is untouched by design. */
export async function updateTraceRecording(sessionId: string, recording: RecordingMetadata): Promise<TraceSummary> {
  const response = await fetch(`/api/traces/${encodeURIComponent(sessionId)}/recording`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(recording)
  });
  if (!response.ok) throw new Error(`Could not update the recording details (${response.status}).`);
  return (await response.json()) as TraceSummary;
}

/** What the control plane's API currently offers. */
export const REQUIRED_CONTROL_PLANE_PROTOCOL = 3;

/**
 * Whether the control-plane PROCESS is running the code this page expects.
 *
 * `server.mjs` is long-lived, so editing it changes nothing until someone
 * restarts it, and the only symptom is a 405 from a button that looks
 * simply broken. Three features were reported as not working in one
 * evening for exactly that reason, each costing a round of diagnosis.
 */
export async function controlPlaneIsCurrent(): Promise<{ ok: true } | { ok: false; detail: string }> {
  const stale = {
    ok: false as const,
    detail:
      "The control plane is running older code than this page, so newer actions will fail. Restart it: " +
      "npm start — traces are held in memory and will be cleared."
  };
  try {
    const response = await fetch("/api/meta");
    if (!response.ok) return stale;
    const body = (await response.json()) as { controlPlaneProtocol?: number };
    return (body.controlPlaneProtocol ?? 0) >= REQUIRED_CONTROL_PLANE_PROTOCOL ? { ok: true } : stale;
  } catch {
    // Unreachable is a different problem, already reported elsewhere.
    return { ok: true };
  }
}
