import type { CaptureEvent, CaptureNetworkMetadata } from "./types";
import type { NormalizedObservation, ObservationAction } from "./normalize";

/* ------------------------------------------------------------------ *
 * Execution evidence.
 *
 * Teach Mode's observations answer "what did the human do". This module
 * answers a different question — "what did the application appear to do
 * about it" — and keeps the answer in a separate artifact.
 *
 * Everything here is correlation. A request that starts 37ms after a Save
 * and returns 200 just before a success toast is strong evidence, and it is
 * still not proof of causation. Nothing in this file produces anything
 * executable: it records that a transport was observed, never how to drive
 * it. Turning evidence into a binding is a separate, human-gated step that
 * does not exist yet.
 * ------------------------------------------------------------------ */

/** A request beginning inside this window after an action is plausibly its work. */
export const CAUSAL_WINDOW_MS = 1_500;
/** Beyond this, a request is no longer attributed to the action at all. */
export const ATTRIBUTION_WINDOW_MS = 5_000;
/** How many times an endpoint must repeat before it can look like background traffic. */
export const BACKGROUND_REPEAT_THRESHOLD = 3;

export type EvidenceConfidence = "high" | "medium" | "low";

/** One observed request, attributed to the action it followed. */
export interface NetworkEffect {
  requestId: string;
  method: string;
  origin: string;
  pathPattern: string;
  resourceType: string;
  category: CaptureNetworkMetadata["category"];
  /** Milliseconds between the human action and the request starting. */
  startedAfterMs: number;
  durationMs: number;
  status: number;
  ok: boolean;
  failed: boolean;
  /** Traffic that repeats independently of what the human did. */
  backgroundLikely: boolean;
  confidence: EvidenceConfidence;
}

/**
 * How one demonstrated action appeared to be carried out. Deliberately not a
 * binding, and deliberately not attached to the semantic capability.
 */
export interface ExecutionEvidence {
  actionObservationId: string;
  action: ObservationAction;
  actionLabel?: string;
  networkEffects: NetworkEffect[];
  applicationEffects: string[];
  confidence: EvidenceConfidence;
}

const RANK: Record<EvidenceConfidence, number> = { low: 0, medium: 1, high: 2 };

function strongest(values: EvidenceConfidence[]): EvidenceConfidence {
  return values.reduce<EvidenceConfidence>(
    (best, value) => (RANK[value] > RANK[best] ? value : best),
    "low"
  );
}

/** Actions a human took, as opposed to effects the application produced. */
function isHumanAction(observation: NormalizedObservation): boolean {
  return observation.action !== "navigate";
}

/**
 * Endpoints that repeat and that also fire without any action preceding them
 * are polling, telemetry, or heartbeats. Deterministic and deliberately crude:
 * this only needs to keep obvious background chatter out of the evidence, not
 * to model an application's traffic.
 */
function backgroundEndpoints(
  requests: CaptureNetworkMetadata[],
  actionTimes: number[]
): Set<string> {
  const counts = new Map<string, number>();
  const unattributable = new Set<string>();

  for (const request of requests) {
    const key = `${request.method} ${request.endpoint}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);

    const precededByAction = actionTimes.some(
      (t) => request.startedAt >= t && request.startedAt - t <= ATTRIBUTION_WINDOW_MS
    );
    if (!precededByAction) unattributable.add(key);
  }

  const background = new Set<string>();
  for (const [key, count] of counts) {
    if (count >= BACKGROUND_REPEAT_THRESHOLD && unattributable.has(key)) background.add(key);
  }
  return background;
}

function confidenceFor(
  request: CaptureNetworkMetadata,
  startedAfterMs: number,
  backgroundLikely: boolean,
  hasApplicationEffect: boolean
): EvidenceConfidence {
  if (backgroundLikely) return "low";
  if (request.resourceType !== "xmlhttprequest") return "low";
  if (request.category !== "mutation") return "low";
  if (startedAfterMs > CAUSAL_WINDOW_MS) return "medium";
  return hasApplicationEffect ? "high" : "medium";
}

/**
 * Attributes each observed request to the most recent human action that could
 * have triggered it. A request that started before any action, or more than
 * `ATTRIBUTION_WINDOW_MS` after one, is attributed to nothing and dropped.
 */
export function correlateExecutionEvidence(
  events: readonly CaptureEvent[],
  observations: readonly NormalizedObservation[]
): ExecutionEvidence[] {
  const requests = events
    .filter((event) => event.kind === "network" && event.network)
    .map((event) => event.network as CaptureNetworkMetadata)
    .sort((left, right) => left.startedAt - right.startedAt);
  if (requests.length === 0) return [];

  const actions = observations.filter(isHumanAction).sort((left, right) => left.t - right.t);
  if (actions.length === 0) return [];

  const background = backgroundEndpoints(requests, actions.map((action) => action.t));
  const byAction = new Map<string, NetworkEffect[]>();

  for (const request of requests) {
    let owner: NormalizedObservation | undefined;
    for (const action of actions) {
      if (action.t <= request.startedAt) owner = action;
      else break;
    }
    if (!owner) continue;

    const startedAfterMs = Math.round(request.startedAt - owner.t);
    if (startedAfterMs > ATTRIBUTION_WINDOW_MS) continue;

    const backgroundLikely = background.has(`${request.method} ${request.endpoint}`);
    const effect: NetworkEffect = {
      requestId: request.requestId,
      method: request.method,
      origin: request.origin,
      pathPattern: request.endpoint,
      resourceType: request.resourceType,
      category: request.category,
      startedAfterMs,
      durationMs: request.durationMs,
      status: request.status,
      ok: request.ok,
      failed: request.failed,
      backgroundLikely,
      confidence: confidenceFor(
        request,
        startedAfterMs,
        backgroundLikely,
        (owner.effects?.length ?? 0) > 0
      )
    };

    byAction.set(owner.id, [...(byAction.get(owner.id) ?? []), effect]);
  }

  return actions
    .filter((action) => byAction.has(action.id))
    .map((action) => {
      const networkEffects = byAction.get(action.id) ?? [];
      return {
        actionObservationId: action.id,
        action: action.action,
        ...(action.target ? { actionLabel: action.target } : {}),
        networkEffects,
        applicationEffects: [...(action.effects ?? [])],
        confidence: strongest(networkEffects.map((effect) => effect.confidence))
      };
    });
}
