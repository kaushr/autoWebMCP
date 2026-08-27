import type { ObservationTrace } from "../capture/normalize";
import type { SemanticCapability } from "../semantic/model";
import type { PublicationRecord } from "../webmcp/publication";
import type { SemanticizerRun } from "./semanticizer";
import type { BindingCandidateRecord, BindingInferenceRun } from "./bindingInference";
import type { BindingValidationRecord } from "../binding/validation";
import type {
  BrowserBindingCandidateRecord,
  BrowserBindingValidationRecord
} from "../binding/browserExecution/model";
import type { FieldClarification } from "../applicationIntelligence/model";
import { resolveAdvertisedBinding } from "./bindingProvider";
import { sourceApplicationFor } from "./sourceApplication";

/**
 * Bumped when the shape changes. Deliberately a plain string with no migration
 * machinery: the format will move, and a reader can branch on it.
 */
export const DEBUG_BUNDLE_VERSION = "4";

export interface DebugBundleInput {
  trace: ObservationTrace;
  runs: readonly SemanticizerRun[];
  candidate?: SemanticCapability;
  ambiguities?: readonly string[];
  publications?: readonly PublicationRecord[];
  bindingRuns?: readonly BindingInferenceRun[];
  bindingCandidate?: BindingCandidateRecord;
  validationRuns?: readonly BindingValidationRecord[];
  validation?: BindingValidationRecord;
  /**
   * The browser execution route.
   *
   * Absent from the export until now, which is why a bundle sent to
   * diagnose a failing browser run contained everything except the browser
   * run: the proposed binding, the test result with its per-input
   * transactions, and how any constrained value domain was established.
   */
  browserBindingCandidate?: BrowserBindingCandidateRecord;
  browserValidation?: BrowserBindingValidationRecord;
  valueDomains?: {
    resolved: Record<string, string[]>;
    sources: Record<string, string>;
    unresolved: Record<string, string>;
    trail: readonly string[];
  };
  /** Facts a human supplied when no metadata could name a field. */
  clarifications?: readonly FieldClarification[];
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
    /** Human-supplied recording metadata, exported verbatim. */
    recording?: { name?: string; description?: string };
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
  /** Binding inference is a separate question, so it exports separately. */
  bindingInferenceRuns: BindingInferenceRun[];
  bindingCandidate: BindingCandidateRecord["proposal"] | null;
  bindingCandidateState: BindingCandidateRecord["state"];
  bindingValidationRuns: BindingValidationRecord["result"][];
  validatedBinding: NonNullable<BindingValidationRecord["result"]["binding"]> | null;
  bindingValidationState: BindingValidationRecord["state"];
  browserBinding: BrowserBindingCandidateRecord["proposal"] | null;
  browserBindingState: BrowserBindingCandidateRecord["state"] | "none";
  /** The Browser execution test result, including per-input transactions. */
  browserExecutionTest: BrowserBindingValidationRecord["result"] | null;
  browserExecutionTestState: BrowserBindingValidationRecord["state"];
  valueDomains: DebugBundleInput["valueDomains"] | null;
  clarifications: FieldClarification[];
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
      ...(trace.recording ? { recording: trace.recording } : {}),
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
    bindingInferenceRuns: (input.bindingRuns ?? [])
      .filter((run) => run.traceSessionId === trace.sessionId)
      .slice()
      .sort((left, right) => left.diagnostics.requestedAt.localeCompare(right.diagnostics.requestedAt)),
    // A candidate belongs to the capability this session produced, or to nothing.
    bindingCandidate:
      ownCandidate && input.bindingCandidate?.proposal.capabilityId === ownCandidate.id
        ? input.bindingCandidate.proposal
        : null,
    bindingCandidateState:
      ownCandidate && input.bindingCandidate?.proposal.capabilityId === ownCandidate.id
        ? input.bindingCandidate.state
        : "none",
    bindingValidationRuns: (input.validationRuns ?? [])
      .filter((record) => ownCandidate && record.result.capabilityId === ownCandidate.id)
      .map((record) => record.result),
    // A binding exists here only once a human accepted it. Validation alone
    // never populates this field, which is what publication reads.
    validatedBinding:
      ownCandidate && input.validation?.state === "accepted" && input.validation.result.binding
        ? input.validation.result.binding
        : null,
    bindingValidationState:
      ownCandidate && input.validation?.result.capabilityId === ownCandidate.id
        ? input.validation.state
        : "none",
    // The browser route, scoped to this session's capability the same way
    // the supported-API route is.
    browserBinding:
      ownCandidate && input.browserBindingCandidate?.proposal.binding?.capabilityId === ownCandidate.id
        ? input.browserBindingCandidate.proposal
        : null,
    browserBindingState:
      ownCandidate && input.browserBindingCandidate?.proposal.binding?.capabilityId === ownCandidate.id
        ? input.browserBindingCandidate.state
        : "none",
    browserExecutionTest:
      ownCandidate && input.browserValidation?.binding.capabilityId === ownCandidate.id
        ? input.browserValidation.result
        : null,
    browserExecutionTestState:
      ownCandidate && input.browserValidation?.binding.capabilityId === ownCandidate.id
        ? input.browserValidation.state
        : "none",
    valueDomains: input.valueDomains ?? null,
    clarifications: [...(input.clarifications ?? [])],
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
