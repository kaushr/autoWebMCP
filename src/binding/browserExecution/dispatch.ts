import type { ExecutionResult } from "./result";

/* ------------------------------------------------------------------ *
 * How far a dispatched execution got, and what may be retried.
 *
 * A write that was dispatched and never answered is not a failed write.
 * A live run proved the difference at cost: the caller timed out, reported
 * failure, and the agent retried — while the Salesforce record had, or
 * would shortly have, exactly the requested values. "No answer" and "did
 * not happen" are different facts, and collapsing them is how an agent
 * ends up performing a side effect twice.
 *
 * So an execution says where it got to, that marker outlives the document
 * it ran in, and the decision to run again is made against it rather than
 * against silence.
 * ------------------------------------------------------------------ */

/**
 * The points an execution can be observed to have reached, in order.
 *
 * Named for what has been ESTABLISHED, not for what is being attempted —
 * `saving` means the commit was invoked, which is the honest thing to know
 * when the answer never comes back.
 */
export const EXECUTION_PHASES = [
  "received",
  "target-established",
  "target-opening",
  "editable",
  "resolved",
  "writing",
  "written",
  "saving",
  "saved",
  "verified",
  "reported"
] as const;

export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

export function phaseIndex(phase: ExecutionPhase): number {
  return EXECUTION_PHASES.indexOf(phase);
}

/**
 * Whether the record could already carry a change by this point.
 *
 * The line is the commit, not the first keystroke: until then every value
 * lives in an unsaved form, and abandoning it leaves the record as it was.
 * From `saving` onward the application may have persisted the change
 * whether or not anyone ever heard back about it — which is exactly the
 * state a retry must not walk into blindly.
 *
 * `target-opening` sits below the line deliberately: the execution stops
 * there having touched nothing at all, so running it again is not merely
 * permitted but expected.
 */
export function mayHavePersisted(phase: ExecutionPhase): boolean {
  return phaseIndex(phase) >= phaseIndex("saving");
}

/** One dispatched invocation, as remembered by the page it ran on. */
export interface InvocationRecord {
  invocationId: string;
  /** Which capability was invoked. Two invocations of different capabilities never interfere. */
  capabilityId: string;
  /** The arguments, so an identical-looking retry can be recognised as a DIFFERENT transaction. */
  inputs: Record<string, string>;
  startedAt: string;
  phase: ExecutionPhase;
  /** Set once the execution produced an answer, whether or not anyone received it. */
  outcome?: unknown;
}

/**
 * Where invocation records live.
 *
 * An interface rather than a module-level store because the one property
 * that matters is survival: the store used in the browser is the target
 * page's own `sessionStorage`, so a record outlives the document that
 * wrote it. That is the whole point — the failure being defended against
 * destroys the JavaScript context mid-execution, and an in-memory map
 * would die with it.
 */
export interface InvocationJournal {
  read(invocationId: string): InvocationRecord | undefined;
  /** Every remembered invocation of one capability, oldest first. */
  forCapability(capabilityId: string): InvocationRecord[];
  write(record: InvocationRecord): void;
}

/** A journal for tests and for any context with nothing to persist to. */
export function memoryJournal(): InvocationJournal {
  const entries = new Map<string, InvocationRecord>();
  return {
    read: (id) => entries.get(id),
    forCapability: (capabilityId) => [...entries.values()].filter((entry) => entry.capabilityId === capabilityId),
    write: (record) => void entries.set(record.invocationId, record)
  };
}

/**
 * What to do about an invocation that has just arrived.
 *
 * Three answers, and the distinction between the last two is the one the
 * live failure turned on:
 *
 *   `replay`   — this exact invocation already ran. Return what it produced
 *                and touch nothing. Not a retry; the same transaction
 *                arriving twice.
 *   `refuse`   — a DIFFERENT invocation of this capability was dispatched,
 *                may have persisted a change, and never reported. Running
 *                now could repeat a side effect nobody can see.
 *   `proceed`  — nothing outstanding can have persisted anything.
 */
export type InvocationVerdict =
  | { action: "replay"; record: InvocationRecord }
  | { action: "refuse"; reason: string; blocking: InvocationRecord }
  | { action: "proceed"; unfinished: InvocationRecord[] };

/**
 * Decides whether an arriving invocation may execute.
 *
 * Note what is deliberately NOT deduplicated: a new invocation id carrying
 * identical arguments. Two calls asking for the same close date are two
 * transactions that happen to agree, not one transaction seen twice, and
 * for a capability like `create_task` treating them as the same would
 * silently drop work the caller asked for. Only the invocation id makes
 * two deliveries the same transaction.
 */
export function judgeInvocation(
  journal: InvocationJournal,
  invocationId: string | undefined,
  capabilityId: string
): InvocationVerdict {
  const existing = invocationId ? journal.read(invocationId) : undefined;
  if (existing?.outcome !== undefined) return { action: "replay", record: existing };

  const unfinished = journal
    .forCapability(capabilityId)
    .filter((entry) => entry.outcome === undefined && entry.invocationId !== invocationId);
  const blocking = unfinished.find((entry) => mayHavePersisted(entry.phase));
  if (blocking) {
    return {
      action: "refuse",
      blocking,
      reason:
        `A previous invocation of "${capabilityId}" (${blocking.invocationId}) reached "${blocking.phase}" and ` +
        "never reported its outcome, so it may already have saved a change that nobody has seen. Running again " +
        "now could repeat it. Establish what that invocation did before invoking this capability again."
    };
  }
  return { action: "proceed", unfinished };
}

/**
 * Runs an execution at most once per invocation id, recording where it got
 * to as it goes.
 *
 * Lives here rather than in the content script so the property it exists to
 * guarantee — the same transaction delivered twice performs one mutation —
 * is testable without a browser. The content script supplies the journal
 * that survives navigation; everything else is this.
 */
export async function runOnce(
  journal: InvocationJournal,
  request: { invocationId?: string; capabilityId: string; inputs: Record<string, string> },
  run: (report: (phase: ExecutionPhase) => void) => Promise<ExecutionResult>
): Promise<ExecutionResult> {
  const { invocationId, capabilityId, inputs } = request;
  const verdict = judgeInvocation(journal, invocationId, capabilityId);

  // Not a retry: the same transaction arriving again. Whatever it produced
  // is still the answer, and running it now would be a second side effect.
  if (verdict.action === "replay") return verdict.record.outcome as ExecutionResult;

  if (verdict.action === "refuse") {
    return {
      status: "blocked",
      dispatch: { ...(invocationId ? { invocationId } : {}), phase: "received", mayHavePersisted: false },
      checks: [],
      evidence: [
        `Outstanding invocation ${verdict.blocking.invocationId} started at ${verdict.blocking.startedAt} and last ` +
          `reported "${verdict.blocking.phase}".`
      ],
      warnings: [verdict.reason],
      executedAt: new Date().toISOString()
    };
  }

  const record: InvocationRecord = {
    invocationId: invocationId ?? `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    capabilityId,
    inputs,
    startedAt: new Date().toISOString(),
    phase: "received"
  };
  journal.write(record);

  // Written as each point is passed, so the phase is already durable if the
  // context is destroyed the moment after.
  const outcome = await run((phase) => {
    record.phase = phase;
    journal.write({ ...record });
  });
  journal.write({ ...record, phase: outcome.dispatch?.phase ?? record.phase, outcome });
  return outcome;
}
