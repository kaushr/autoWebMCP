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
/** Two actions closer together than this make attribution by timing ambiguous. */
export const AMBIGUITY_WINDOW_MS = 400;

export type EvidenceConfidence = "high" | "medium" | "low";

/**
 * Whether an observed mechanism is fit to become an agent execution binding.
 *
 * A separate axis from confidence, and deliberately so. We can be certain that
 * `POST /aura?...RecordUi.saveRecord` carried a Save and still be certain it
 * must never be called: it is private, unversioned, and undocumented. High
 * correlation is a statement about evidence; eligibility is a statement about
 * whether an interface is supported, and no generic timing rule can decide it.
 *
 * Every observed mechanism is therefore `unresolved` here. Platform knowledge
 * is what resolves it, and that lives in adapters that do not exist yet — not
 * in this engine, which must stay free of any one vendor's specifics.
 */
export type BindingEligibility = "unresolved";

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
  /** Another action happened just before the one this was attributed to. */
  ambiguousAttribution: boolean;
  confidence: EvidenceConfidence;
  /** Why it scored that way, in the order the signals were considered. */
  reasons: string[];
  /**
   * Never derived from confidence. Correlating strongly with an action says
   * nothing about whether an interface is safe or supported to call.
   */
  bindingEligibility: BindingEligibility;
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

/**
 * The second background signal, and the one that matters in a busy application.
 *
 * Polling that happens to fire shortly after whatever the human was doing looks
 * attributable every single time, so the "fires with no action before it" rule
 * misses it entirely. An endpoint that attaches to several *different* actions
 * is not executing any of them.
 */
function endpointsSpanningManyActions(attributions: readonly Attribution[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const { request, owner } of attributions) {
    const key = `${request.method} ${request.endpoint}`;
    owners.set(key, (owners.get(key) ?? new Set()).add(owner.id));
  }

  const background = new Set<string>();
  for (const [key, actions] of owners) {
    if (actions.size >= BACKGROUND_REPEAT_THRESHOLD) background.add(key);
  }
  return background;
}

interface Attribution {
  request: CaptureNetworkMetadata;
  owner: NormalizedObservation;
  previous?: NormalizedObservation;
  startedAfterMs: number;
}

/**
 * When each action's visible reaction landed. A reaction that arrives *after* a
 * request completed is much better evidence than the action merely having had
 * some effect at some point.
 */
function reactionTimesByAction(events: readonly CaptureEvent[]): Map<string, number[]> {
  const times = new Map<string, number[]>();
  for (const event of events) {
    if (event.kind !== "reaction" || !event.correlatesWith) continue;
    times.set(event.correlatesWith, [...(times.get(event.correlatesWith) ?? []), event.t]);
  }
  return times;
}

interface Signals {
  startedAfterMs: number;
  backgroundLikely: boolean;
  ambiguousAttribution: boolean;
  reactedAfterRequest: boolean;
}

/**
 * Deterministic and explainable, not probabilistic. Each signal is recorded as
 * a reason so the Studio can show why a request scored the way it did rather
 * than asking anyone to trust a number.
 *
 * `high` needs every supporting signal at once: a mutation-shaped XHR that
 * started inside the causal window, succeeded, was followed by a visible
 * application reaction, is not background chatter, and had no competing action
 * next to it. Anything less is `medium`; anything disqualifying is `low`.
 */
function scoreRequest(
  request: CaptureNetworkMetadata,
  signals: Signals
): { confidence: EvidenceConfidence; reasons: string[] } {
  const reasons: string[] = [];

  if (signals.backgroundLikely) {
    reasons.push("− repeats independently of user actions");
    return { confidence: "low", reasons };
  }
  if (request.resourceType !== "xmlhttprequest") {
    reasons.push(`− ${request.resourceType} request, not an application call`);
    return { confidence: "low", reasons };
  }
  if (request.category !== "mutation") {
    reasons.push(`− ${request.category}-shaped request, carries no state change`);
    return { confidence: "low", reasons };
  }

  reasons.push(`+ mutation request (${request.method})`);

  let confidence: EvidenceConfidence = "medium";
  if (signals.startedAfterMs <= CAUSAL_WINDOW_MS) {
    reasons.push(`+ started ${signals.startedAfterMs}ms after the action`);
    confidence = "high";
  } else {
    reasons.push(`− started ${signals.startedAfterMs}ms after the action, outside the causal window`);
  }

  if (request.ok) reasons.push(`+ HTTP ${request.status}`);
  else {
    reasons.push(request.failed ? "− request failed" : `− HTTP ${request.status}`);
    confidence = "medium";
  }

  if (signals.reactedAfterRequest) reasons.push("+ application reacted after it completed");
  else {
    reasons.push("− no application reaction followed it");
    confidence = "medium";
  }

  if (signals.ambiguousAttribution) {
    reasons.push("− another action occurred just before this one");
    confidence = "medium";
  }

  return { confidence, reasons };
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

  const reactionTimes = reactionTimesByAction(events);

  // First pass: decide what each request belongs to. Scoring needs the whole
  // picture, because whether an endpoint is background depends on how it
  // behaved across the entire session rather than on any single occurrence.
  const attributions: Attribution[] = [];
  for (const request of requests) {
    // Latest action wins: a request cannot have been caused by something that
    // had not happened yet. Attribution follows the request's *start*, which is
    // what keeps an intermediate operation on the action that triggered it
    // rather than on whatever the human did next.
    let owner: NormalizedObservation | undefined;
    let previous: NormalizedObservation | undefined;
    for (const action of actions) {
      if (action.t <= request.startedAt) {
        previous = owner;
        owner = action;
      } else break;
    }
    if (!owner) continue;

    const startedAfterMs = Math.round(request.startedAt - owner.t);
    if (startedAfterMs > ATTRIBUTION_WINDOW_MS) continue;

    attributions.push({ request, owner, ...(previous ? { previous } : {}), startedAfterMs });
  }

  const unprompted = backgroundEndpoints(requests, actions.map((action) => action.t));
  const spanning = endpointsSpanningManyActions(attributions);
  const byAction = new Map<string, NetworkEffect[]>();

  // Second pass: score each attribution now that background traffic is known.
  for (const { request, owner, previous, startedAfterMs } of attributions) {
    const key = `${request.method} ${request.endpoint}`;
    const backgroundLikely = unprompted.has(key) || spanning.has(key);
    const ambiguousAttribution = previous !== undefined && owner.t - previous.t <= AMBIGUITY_WINDOW_MS;
    const scored = scoreRequest(request, {
      startedAfterMs,
      backgroundLikely,
      ambiguousAttribution,
      reactedAfterRequest: (reactionTimes.get(owner.id) ?? []).some((t) => t >= request.completedAt)
    });

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
      ambiguousAttribution,
      confidence: scored.confidence,
      reasons: scored.reasons,
      bindingEligibility: "unresolved"
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
        // A field change has no actuated control label; the field is its identity.
        ...(action.target ?? action.field?.label
          ? { actionLabel: (action.target ?? action.field?.label) as string }
          : {}),
        networkEffects,
        applicationEffects: [...(action.effects ?? [])],
        confidence: strongest(networkEffects.map((effect) => effect.confidence))
      };
    });
}
