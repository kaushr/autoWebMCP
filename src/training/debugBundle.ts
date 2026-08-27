import type { ObservationTrace } from "../capture/normalize";
import type { SemanticCapability } from "../semantic/model";
import type { PublicationRecord } from "../webmcp/publication";
import type { SemanticizerRun } from "./semanticizer";
import { resolveAdvertisedBinding } from "./bindingProvider";
import { sourceApplicationFor } from "./sourceApplication";

/**
 * Bumped when the shape changes. Deliberately a plain string with no migration
 * machinery: the format will move, and a reader can branch on it.
 */
export const DEBUG_BUNDLE_VERSION = "1";

export interface DebugBundleInput {
  trace: ObservationTrace;
  runs: readonly SemanticizerRun[];
  candidate?: SemanticCapability;
  ambiguities?: readonly string[];
  publications?: readonly PublicationRecord[];
  exportedAt: string;
}

export interface DebugBundle {
  exportVersion: string;
  exportedAt: string;
  session: {
    id: string;
    sourceApplication: { id: string; label: string };
    host: string;
    title?: string;
    capturedAt: string;
    endedAt: string;
  };
  captureStats: ObservationTrace["stats"];
  captureStream: ObservationTrace["captureEvents"] | null;
  captureStreamUnavailableReason?: string;
  normalizedObservations: ObservationTrace["observations"];
  labels: string[];
  executionEvidence: ObservationTrace["executionEvidence"];
  semanticizerRuns: SemanticizerRun[];
  capabilityLifecycle: {
    candidate: SemanticCapability | null;
    ambiguities: string[];
    semanticConfirmation: "confirmed" | "awaiting confirmation" | null;
    executionBinding: { application: string; action: string; parameters: string[] } | null;
    publishable: boolean;
    publication: { capabilityId: string; publishedAt: string } | null;
  };
}

/**
 * Everything AutoWebMCP safely retained about one Teach Mode session, built
 * from typed state rather than from rendered markup so the bundle and the Admin
 * panels can never disagree.
 *
 * It reports what exists. A field that was never captured is `null` with a
 * reason rather than an empty object pretending to be data, because a bundle
 * that quietly invents completeness is worse than no bundle.
 *
 * The privacy boundary is inherited, not re-applied: every input here has
 * already passed through masking, endpoint normalization, and the header/body
 * exclusions. Nothing is read from a rawer source, so "download everything"
 * means everything retained, never everything the browser saw.
 */
export function buildDebugBundle(input: DebugBundleInput): DebugBundle {
  const { trace, runs, candidate, publications = [], exportedAt } = input;

  const sessionRuns = runs
    .filter((run) => run.traceSessionId === trace.sessionId)
    .slice()
    .sort((left, right) => left.diagnostics.requestedAt.localeCompare(right.diagnostics.requestedAt));

  // Only claim a candidate for this session if one of its own runs produced it.
  // The Studio holds one candidate at a time, and exporting the previous
  // trace's candidate alongside this trace's evidence would be a lie.
  const ownCandidate =
    candidate && sessionRuns.some((run) => run.candidate?.id === candidate.id) ? candidate : undefined;

  const binding = ownCandidate ? resolveAdvertisedBinding(ownCandidate) : undefined;
  const confirmed = Boolean(ownCandidate?.provenance.confirmedByHuman);
  const published = ownCandidate
    ? publications.find((record) => record.capability.id === ownCandidate.id)
    : undefined;

  const captureStream = trace.captureEvents ?? [];
  const hasCaptureStream = captureStream.length > 0;

  return {
    exportVersion: DEBUG_BUNDLE_VERSION,
    exportedAt,
    session: {
      id: trace.sessionId,
      sourceApplication: sourceApplicationFor(trace.application.platform, trace.application.host),
      host: trace.application.host,
      ...(trace.application.title ? { title: trace.application.title } : {}),
      capturedAt: trace.startedAt,
      endedAt: trace.endedAt
    },
    captureStats: trace.stats,
    captureStream: hasCaptureStream ? captureStream : null,
    ...(hasCaptureStream
      ? {}
      : {
          captureStreamUnavailableReason:
            "This trace predates the capture-stream handoff, or the session produced no events. Re-record to inspect it."
        }),
    normalizedObservations: trace.observations,
    labels: trace.labels,
    executionEvidence: trace.executionEvidence ?? [],
    semanticizerRuns: sessionRuns,
    capabilityLifecycle: {
      candidate: ownCandidate ?? null,
      ambiguities: [...(input.ambiguities ?? [])],
      semanticConfirmation: ownCandidate ? (confirmed ? "confirmed" : "awaiting confirmation") : null,
      executionBinding: binding
        ? { application: binding.application, action: binding.action, parameters: [...binding.parameters] }
        : null,
      publishable: confirmed && Boolean(binding),
      publication: published
        ? { capabilityId: published.capability.id, publishedAt: published.publishedAt }
        : null
    }
  };
}

/** A filename that is safe on every filesystem, derived from the session id. */
export function debugBundleFilename(sessionId: string): string {
  const safe = sessionId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return `autowebmcp-session-${safe || "unknown"}.json`;
}

export function serializeDebugBundle(bundle: DebugBundle): string {
  return JSON.stringify(bundle, null, 2);
}
