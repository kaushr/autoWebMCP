import type { ExecutionEvidence } from "./execution";
import type {
  CaptureApplicationContext,
  CaptureEvent,
  CaptureNetworkMetadata,
  CaptureReaction,
  SafeInteraction
} from "./types";

export type ObservationProvenance = "OBSERVED" | "INFERRED" | "HUMAN_CONFIRMED" | "CONFIGURED";

export interface SemanticObservation {
  kind: "field_change" | "save" | "application_reaction";
  timestamp: number;
  field?: { label?: string; context?: string };
  effects?: string[];
  provenance: ObservationProvenance;
  sourceInteractionIds: string[];
}

/**
 * First normalizer slice: reduce safe capture metadata to a compact evidence
 * trace. Values and raw rrweb events intentionally do not cross this boundary.
 */
export function normalizeInteractions(interactions: SafeInteraction[]): SemanticObservation[] {
  const observations: SemanticObservation[] = [];
  for (const interaction of interactions) {
    if (interaction.kind === "field_change") {
      observations.push({
        kind: "field_change",
        timestamp: interaction.timestamp,
        field: { label: interaction.element?.label, context: interaction.element?.role },
        provenance: "OBSERVED",
        sourceInteractionIds: [interaction.id]
      });
      continue;
    }

    if (interaction.kind === "click" && /save/i.test(interaction.element?.label ?? "")) {
      observations.push({
        kind: "save",
        timestamp: interaction.timestamp,
        provenance: "OBSERVED",
        sourceInteractionIds: [interaction.id]
      });
    }
  }
  return observations;
}

/* ------------------------------------------------------------------ *
 * Extension trace normalization
 *
 * `normalizeInteractions` above serves the in-page rrweb probe. The
 * functions below are its successor for the browser extension: they take
 * the richer `CaptureEvent` sensor stream (action + application reaction
 * + sanitized network metadata) and reduce it to the same kind of compact
 * evidence. Raw rrweb events never reach this layer; only their counts do.
 * ------------------------------------------------------------------ */

export type ObservationAction =
  | "navigate"
  | "click"
  | "field_change"
  | "submit"
  | "save"
  | "application_reaction";

export interface NormalizedObservation {
  id: string;
  action: ObservationAction;
  /** Milliseconds since session start. */
  t: number;
  page?: { host: string; path: string };
  field?: { label?: string; context?: string; control?: string };
  oldValue?: string;
  newValue?: string;
  /** Accessible label of the control that was actuated. */
  target?: string;
  effects?: string[];
  network?: CaptureNetworkMetadata;
  provenance: ObservationProvenance;
  sourceEventIds: string[];
}

export interface ObservationTrace {
  version: 1;
  sessionId: string;
  application: CaptureApplicationContext;
  startedAt: string;
  endedAt: string;
  observations: NormalizedObservation[];
  /**
   * The safe capture stream the observations were derived from, carried so the
   * transformation can be inspected rather than trusted. This is the earliest
   * representation that exists after the privacy boundary — already masked,
   * selector-free, and free of headers, bodies, and query values — not a raw
   * recording. Absent on traces captured before observability existed.
   */
  captureEvents?: CaptureEvent[];
  /**
   * How the application appeared to carry out the demonstrated actions. A
   * sibling of `observations`, never folded into them: what a human meant and
   * how an application executes it are separate artifacts, and this one is
   * evidence rather than anything executable.
   */
  executionEvidence: ExecutionEvidence[];
  /** Distinct field and action labels observed, for semanticizer grounding. */
  labels: string[];
  stats: {
    rrwebEvents: number;
    captureEvents: number;
    observations: number;
    droppedEvents: number;
  };
}

// "Apply" is deliberately absent: it labels filter buttons at least as often
// as it labels a commit, and misreading a read as a write is the worse error.
const SAVE_LABEL = /^(save|submit|update|create|confirm|publish)\b/i;
const NETWORK_CORRELATION_WINDOW_MS = 5_000;
/** A click on a submit control and the resulting submit event are one intent. */
const SUBMIT_COLLAPSE_WINDOW_MS = 400;

/**
 * Reduces a URL to a path pattern. Identifiers are replaced, query values
 * are discarded, and only query parameter *names* are retained.
 */
export function normalizeEndpoint(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "/";
  }

  const path = url.pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (/^v\d+(\.\d+)?$/i.test(segment)) return ":v";
      if (/^\d+$/.test(segment)) return ":n";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":uuid";
      if (/^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/.test(segment) && /\d/.test(segment)) return ":id";
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ":hash";
      return segment;
    })
    .join("/");

  const names = [...new Set([...url.searchParams.keys()])].sort();
  return names.length > 0 ? `${path}?${names.join(",")}` : path;
}

export function categorizeRequest(method: string, resourceType: string): CaptureNetworkMetadata["category"] {
  if (resourceType === "main_frame") return "document";
  if (/^(post|put|patch|delete)$/i.test(method)) return "mutation";
  if (/^(get|head)$/i.test(method)) return "read";
  return "other";
}

function reactionEffects(reaction: CaptureReaction): string[] {
  const effects: string[] = [];
  if (reaction.urlChanged) effects.push("navigation occurred");
  if (reaction.validationShown) effects.push("validation message shown");
  if (reaction.fieldsAppeared) effects.push("new fields became visible");
  if (reaction.dialogShown) effects.push("dialog opened");
  if (reaction.toastShown) effects.push("confirmation toast shown");
  // Frameworks batch mutations into one rrweb event per frame, so a count
  // threshold under-reports; the visible content delta is the steadier signal.
  if (effects.length === 0 && (reaction.contentChanged || reaction.domMutations >= 2)) {
    effects.push("page content updated");
  }
  return effects;
}

function addEffect(observation: NormalizedObservation, effect: string): void {
  observation.effects ??= [];
  if (!observation.effects.includes(effect)) observation.effects.push(effect);
}

function actionFor(event: CaptureEvent): ObservationAction | undefined {
  if (event.kind === "navigate") return "navigate";
  if (event.kind === "field_change") return "field_change";
  if (event.kind === "submit") return "submit";
  if (event.kind === "click") return SAVE_LABEL.test(event.actionLabel ?? "") ? "save" : "click";
  return undefined;
}

function isSubstantive(observation: NormalizedObservation): boolean {
  if (observation.action !== "click" && observation.action !== "submit") return true;
  if (observation.target) return true;
  return (observation.effects?.length ?? 0) > 0;
}

/**
 * Clicking a submit control fires both a click and a submit. They describe one
 * human intent, and the click carries the better label, so the submit is
 * folded into it.
 */
function collapseSubmits(observations: NormalizedObservation[]): NormalizedObservation[] {
  const kept: NormalizedObservation[] = [];
  for (const observation of observations) {
    const previous = kept[kept.length - 1];
    const collapsible =
      observation.action === "submit" &&
      previous !== undefined &&
      (previous.action === "click" || previous.action === "save") &&
      observation.t - previous.t <= SUBMIT_COLLAPSE_WINDOW_MS;

    if (!collapsible || !previous) {
      kept.push(observation);
      continue;
    }

    for (const effect of observation.effects ?? []) addEffect(previous, effect);
    for (const id of observation.sourceEventIds) {
      if (!previous.sourceEventIds.includes(id)) previous.sourceEventIds.push(id);
    }
    previous.target ??= observation.target;
  }
  return kept;
}

/**
 * Reduces the extension's raw capture stream to compact semantic evidence:
 * one observation per meaningful human action, carrying the application's
 * reaction to it. This is evidence for capability extraction, not a replay
 * script: no selectors, coordinates, or ordering guarantees are emitted.
 */
export function normalizeCapture(events: readonly CaptureEvent[]): NormalizedObservation[] {
  const ordered = [...events].sort((left, right) => left.t - right.t);
  const observations: NormalizedObservation[] = [];
  const byEventId = new Map<string, NormalizedObservation>();
  let lastPath: string | undefined;

  for (const event of ordered) {
    const action = actionFor(event);
    if (!action) continue;

    if (action === "navigate") {
      const path = `${event.page.host}${event.page.path}`;
      if (path === lastPath) continue;
      lastPath = path;
    }

    if (action === "field_change" && event.value && !event.value.masked && event.value.from === event.value.to) {
      continue;
    }

    const observation: NormalizedObservation = {
      id: event.id,
      action,
      t: event.t,
      page: { host: event.page.host, path: event.page.path },
      ...(event.field
        ? {
            field: {
              ...(event.field.label ? { label: event.field.label } : {}),
              ...(event.field.section ? { context: event.field.section } : {}),
              control: event.field.control
            }
          }
        : {}),
      ...(event.value?.from !== undefined ? { oldValue: event.value.from } : {}),
      ...(event.value?.to !== undefined ? { newValue: event.value.to } : {}),
      ...(event.actionLabel ? { target: event.actionLabel } : {}),
      ...(event.value?.masked ? { effects: ["value masked by capture policy"] } : {}),
      provenance: "OBSERVED",
      sourceEventIds: [event.id]
    };

    observations.push(observation);
    byEventId.set(event.id, observation);
  }

  const precedingAction = (t: number): NormalizedObservation | undefined => {
    let match: NormalizedObservation | undefined;
    for (const observation of observations) {
      if (observation.t <= t) match = observation;
      else break;
    }
    return match;
  };

  for (const event of ordered) {
    if (event.kind === "reaction" && event.reaction) {
      const target =
        (event.correlatesWith ? byEventId.get(event.correlatesWith) : undefined) ?? precedingAction(event.t);
      if (!target) continue;
      for (const effect of reactionEffects(event.reaction)) addEffect(target, effect);
      if (!target.sourceEventIds.includes(event.id)) target.sourceEventIds.push(event.id);
      continue;
    }

    if (event.kind === "network" && event.network) {
      if (event.network.category !== "mutation") continue;
      const target = precedingAction(event.t);
      if (!target || event.t - target.t > NETWORK_CORRELATION_WINDOW_MS) continue;
      addEffect(target, "network mutation observed");
      target.network ??= event.network;
      if (!target.sourceEventIds.includes(event.id)) target.sourceEventIds.push(event.id);
      if (target.action === "save" && event.network.status >= 200 && event.network.status < 300) {
        addEffect(target, "record became persisted");
        target.provenance = "INFERRED";
      }
    }
  }

  return collapseSubmits(observations).filter(isSubstantive);
}

export function collectLabels(observations: readonly NormalizedObservation[]): string[] {
  const labels = new Set<string>();
  for (const observation of observations) {
    if (observation.field?.label) labels.add(observation.field.label);
    if (observation.field?.context) labels.add(observation.field.context);
    if (observation.target) labels.add(observation.target);
  }
  return [...labels];
}
