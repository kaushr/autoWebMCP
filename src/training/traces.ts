import type { ObservationTrace } from "../capture/normalize";

/** One extension-captured trace as summarized by the Training Studio list. */
export interface TraceSummary {
  sessionId: string;
  application: string;
  platform: string;
  title?: string;
  startedAt: string;
  observations: number;
  receivedAt: string;
}

export function summarizeTrace(trace: ObservationTrace, receivedAt: string): TraceSummary {
  return {
    sessionId: trace.sessionId,
    application: trace.application.host,
    platform: trace.application.platform,
    ...(trace.application.title ? { title: trace.application.title } : {}),
    startedAt: trace.startedAt,
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

  return trace as ObservationTrace;
}

export async function listTraces(): Promise<TraceSummary[]> {
  const response = await fetch("/api/traces");
  if (!response.ok) throw new Error(`Could not list extension traces (${response.status}).`);
  const body = (await response.json()) as { traces?: TraceSummary[] };
  return body.traces ?? [];
}

export async function getTrace(sessionId: string): Promise<ObservationTrace> {
  const response = await fetch(`/api/traces/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw new Error(`Could not load trace ${sessionId} (${response.status}).`);
  return parseObservationTrace(await response.json());
}
