import type { AgentPlanRequest } from "./model";

/* ------------------------------------------------------------------ *
 * Asking the control plane for one next action.
 *
 * The same model integration the semanticizer and the binding proposer
 * already use — one model stack, not two — and the same wire convention:
 * the server returns the model's raw structured output, and the caller
 * parses it, so a bad model answer and a bad parser stay distinguishable.
 *
 * Nothing is remembered between calls. Each request carries the original
 * instruction, the live tool set, what has already happened, and how many
 * steps are left; there is no conversation, no thread, and no state on the
 * server.
 * ------------------------------------------------------------------ */

export interface PlannerDiagnostics {
  model: string;
  latencyMs: number;
}

/** The most recent planner call's diagnostics, for the trace. Ephemeral. */
export let lastPlannerDiagnostics: PlannerDiagnostics | undefined;

export async function planNextAction(request: AgentPlanRequest): Promise<unknown> {
  const response = await fetch("/api/agent/step", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `The control plane could not plan a step (${response.status}).`);
  }
  const body = (await response.json()) as { raw?: string; diagnostics?: PlannerDiagnostics };
  lastPlannerDiagnostics = body.diagnostics;
  if (typeof body.raw !== "string") throw new Error("The control plane returned no action.");
  try {
    return JSON.parse(body.raw);
  } catch {
    throw new Error("The model's answer was not the structured action this loop requires.");
  }
}
