import { decodeToolPayload, isExecutionResult, isQueryOutcome } from "../webmcp/harness";
import type { ExecutionResult } from "../binding/browserExecution/result";
import type { QueryOutcome } from "../binding/browserExecution/query";
import type { AgentStopReason, ToolObservation } from "./model";

/* ------------------------------------------------------------------ *
 * What a tool said, and what the loop is allowed to do next because of it.
 *
 * Two jobs kept together because they are the same judgement seen twice.
 * The observation is what the MODEL is shown; the control decision is what
 * the LOOP does regardless of what the model would prefer. The second is
 * not negotiable by the first, which is the point: an unknown write
 * outcome stops the run whether or not a model thinks retrying looks fine,
 * and several candidate records stop it whether or not one of them looks
 * obviously right.
 * ------------------------------------------------------------------ */

/** How much of an unrecognised payload is worth carrying into the next prompt. */
const DATA_BUDGET_CHARS = 4_000;
/** How many candidates a search result contributes before the rest are counted rather than listed. */
const CANDIDATE_LIMIT = 10;

/** Reads a tool's raw response into the compact form the next planning step is given. */
export function observeToolResult(raw: string): ToolObservation {
  const decoded = decodeToolPayload(raw);
  if (decoded.value === undefined) {
    return { kind: "text", text: decoded.text, ...(decoded.problem ? { problem: decoded.problem } : {}) };
  }
  if (isQueryOutcome(decoded.value)) return observeQuery(decoded.value);
  if (isExecutionResult(decoded.value)) return observeExecution(decoded.value);

  const serialized = JSON.stringify(decoded.value);
  if (serialized && serialized.length > DATA_BUDGET_CHARS) {
    return {
      kind: "text",
      text: serialized.slice(0, DATA_BUDGET_CHARS),
      problem: "The tool's answer was longer than this loop carries; the full text is in the trace."
    };
  }
  return { kind: "data", value: decoded.value };
}

/**
 * A search, with every candidate's identity intact.
 *
 * The count is reported separately from the list because they can differ,
 * and the difference is exactly the fact that must not be lost: a run that
 * saw fifty candidates and was shown ten still stopped because there were
 * fifty.
 */
function observeQuery(outcome: QueryOutcome): ToolObservation {
  return {
    kind: "search",
    status: outcome.status,
    candidateCount: outcome.candidates.length,
    candidates: outcome.candidates.slice(0, CANDIDATE_LIMIT).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      ...(candidate.entityType ? { entityType: candidate.entityType } : {}),
      ...(candidate.context ? { context: candidate.context } : {})
    })),
    warnings: outcome.warnings ?? [],
    ...(outcome.openAt ? { openAt: outcome.openAt } : {})
  };
}

/**
 * A write, as its four separable facts: which record, what was asked for,
 * what was proven afterwards, and how far the invocation got.
 *
 * Collapsing any of these is how "the right values on the wrong record"
 * reads as success, so none of them is collapsed here either.
 */
function observeExecution(result: ExecutionResult): ToolObservation {
  return {
    kind: "write",
    status: result.status,
    ...(result.target
      ? {
          target: {
            status: result.target.status,
            ...(result.target.requestedId ? { requestedId: result.target.requestedId } : {}),
            ...(result.target.afterSaveId ? { afterSaveId: result.target.afterSaveId } : {}),
            ...(result.target.entityType ? { entityType: result.target.entityType } : {}),
            detail: result.target.detail
          }
        }
      : {}),
    values: (result.transactions ?? []).map((transaction) => ({
      name: transaction.name,
      requested: transaction.requestedValue,
      verified: transaction.verified,
      ...(transaction.afterSaveValue ? { afterSave: transaction.afterSaveValue } : {})
    })),
    ...(result.dispatch
      ? {
          dispatch: {
            ...(result.dispatch.phase ? { phase: result.dispatch.phase } : {}),
            mayHavePersisted: result.dispatch.mayHavePersisted,
            ...(result.dispatch.openRecordAt ? { openRecordAt: result.dispatch.openRecordAt } : {})
          }
        }
      : {}),
    // Which checks the runtime could not answer. `partially_verified` with
    // every value reading "verified yes" is otherwise unreadable: it says
    // something was not established without ever saying what.
    ...(result.checks.some((check) => check.status === "skipped")
      ? { unestablished: result.checks.filter((check) => check.status === "skipped").map((check) => check.name) }
      : {}),
    // And the symmetric case one status worse. `failed` beside three green
    // values is the same unreadable report as `partially_verified` was,
    // and for the same reason: the deciding check was never carried.
    ...(result.checks.some((check) => check.status === "fail")
      ? {
          failedChecks: result.checks
            .filter((check) => check.status === "fail")
            .map((check) => ({ name: check.name, detail: check.detail }))
        }
      : {}),
    ...(result.blockedBy
      ? {
          blockedBy: {
            invocationId: result.blockedBy.invocationId,
            startedAt: result.blockedBy.startedAt,
            ...(result.blockedBy.phase ? { phase: result.blockedBy.phase } : {})
          }
        }
      : {}),
    warnings: result.warnings ?? []
  };
}

export type LoopControl =
  | { continue: true }
  | {
      continue: false;
      reason: AgentStopReason;
      detail: string;
      clarification?: {
        question: string;
        candidates: Array<{ id: string; name: string; entityType?: string; context?: Record<string, string> }>;
      };
      /** An outstanding write a person must account for before this can go on. */
      acknowledgement?: { invocationId: string; startedAt: string; phase?: string };
    };

/**
 * Whether the loop may take another step, decided from the runtime's own
 * structured outcome and nothing else.
 *
 * Every stop here exists because of something that actually happened:
 *
 *   several candidates   a name is not an identity, and choosing between
 *                        two records that share one is a decision with an
 *                        owner. Search may be fuzzy; mutation must be
 *                        exact, and this is where that rule is kept.
 *
 *   unknown outcome      a Salesforce Opportunity was once updated exactly
 *                        as asked while the caller was told the write had
 *                        failed, and the agent ran it again. "No answer"
 *                        and "did not happen" are different facts. This
 *                        stops, unconditionally, and never re-plans.
 *
 *   blocked              a refusal, including the duplicate-invocation
 *                        refusal the runtime issues when an earlier write
 *                        may have persisted. The one exception is the
 *                        navigation-only case below.
 *
 * The exception is narrow and evidence-led. A blocked execution that
 * opened the requested record establishes three things itself — nothing
 * was modified, the record is now open, and invoking again is safe — and
 * the loop may continue only because the runtime said all three. A
 * generic error or a timeout establishes none of them and is never read
 * this way.
 */
export function loopControlFor(observation: ToolObservation): LoopControl {
  switch (observation.kind) {
    case "search": {
      if (observation.candidateCount > 1) {
        return {
          continue: false,
          reason: "needs_clarification",
          detail:
            `The search returned ${observation.candidateCount} candidate records. Nothing here may choose ` +
            "between them: a name is not an identity, and a write must name one exact record.",
          clarification: {
            question: `Which record did you mean? ${observation.candidateCount} matched.`,
            candidates: observation.candidates
          }
        };
      }
      if (observation.status === "blocked") {
        return observation.openAt
          ? { continue: true }
          : {
              continue: false,
              reason: "tool_failed",
              detail: observation.warnings.join(" ") || "The search was blocked before it ran."
            };
      }
      return { continue: true };
    }

    case "write": {
      if (observation.status === "unknown") {
        return {
          continue: false,
          reason: "unknown_outcome",
          detail:
            "Execution outcome is unknown. The write may have persisted. Manual reconciliation is required " +
            "before retry."
        };
      }
      if (observation.status === "failed") {
        return {
          continue: false,
          reason: "tool_failed",
          detail: observation.warnings.join(" ") || "The write did not complete."
        };
      }
      if (observation.status === "blocked") {
        // Refused because an earlier write never reported. Not a failure
        // and not a thing to retry — a person has to establish what that
        // transaction did, and only then may this one proceed.
        if (observation.blockedBy) {
          return {
            continue: false,
            reason: "needs_acknowledgement",
            detail: observation.warnings.join(" ") || "An earlier write of this capability never reported its outcome.",
            acknowledgement: observation.blockedBy
          };
        }
        const dispatch = observation.dispatch;
        // The runtime's own three facts, all of them required. Any one
        // missing and this is an ordinary refusal.
        const safeToInvokeAgain = Boolean(dispatch?.openRecordAt) && dispatch?.mayHavePersisted === false;
        return safeToInvokeAgain
          ? { continue: true }
          : {
              continue: false,
              reason: "tool_failed",
              detail: observation.warnings.join(" ") || "The write stopped before changing anything."
            };
      }
      return { continue: true };
    }

    case "error":
      return { continue: false, reason: "tool_failed", detail: observation.message };

    default:
      return { continue: true };
  }
}
