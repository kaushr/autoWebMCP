import type { ExecutionPhase } from "./dispatch";

/* ------------------------------------------------------------------ *
 * Execution result types.
 *
 * A leaf module on purpose: `engine.ts`, `execute.ts`, and `model.ts` all
 * need these shapes, and none of them should need each other to get them.
 * ------------------------------------------------------------------ */

export interface ExecutionCheckResult {
  name:
    | "target_identity"
    | "editable_state"
    | "target_resolved"
    | "value_set"
    | "commit_invoked"
    | "validation_clear"
    | "returned_to_record"
    | "value_verified";
  status: "pass" | "fail" | "skipped";
  detail: string;
}

/**
 * One input's journey through an execution, as four distinct facts.
 *
 * Collapsing these into a single `value` is what made a live failure
 * unreadable: the record showed 4/1/2027, the test asked for 11/01/2026,
 * and nothing in the result said which of those the executor had seen,
 * written, or read back. They answer different questions and are tracked
 * separately on purpose.
 */
export interface InputTransaction {
  /** The capability input, e.g. `close_date`. */
  name: string;
  /** The application's own field identity, when known. */
  apiName?: string;
  /** What the record held before this execution touched it. */
  beforeValue?: string;
  /** What the caller asked for — an invocation argument, never an observation. */
  requestedValue: string;
  /** What the control held immediately after the write. */
  afterWriteValue?: string;
  /** What the record held once the save had settled. */
  afterSaveValue?: string;
  /** Which strategy performed the write. */
  strategy?: string;
  /** Whether the requested value was proven present after the write. */
  verified: "yes" | "no" | "unreadable";
  detail: string;
}

export type ExecutionOutcomeStatus = "succeeded" | "failed" | "partially_verified" | "blocked" | "unknown";

/**
 * The outcome of one execution attempt. Execution is not successful merely
 * because a commit action was clicked — `succeeded` requires every
 * verification check to have actually passed. A check that could not be
 * honestly answered (Lightning's shadow-DOM encapsulation makes read-back
 * impossible for some fields) is `skipped`, never assumed passing, and caps
 * the result at `partially_verified` rather than `succeeded`.
 */
export interface ExecutionResult {
  status: ExecutionOutcomeStatus;
  /**
   * How far this invocation was observed to get.
   *
   * Present on every result, and the only thing that carries meaning when
   * `status` is `unknown`: an answer that never arrived still leaves a
   * question with a correct answer, and the last confirmed phase is what
   * separates "nothing was touched" from "the save was issued".
   */
  dispatch?: ExecutionDispatch;
  /** Per-input before/requested/after-write/after-save, never collapsed. */
  transactions?: InputTransaction[];
  checks: ExecutionCheckResult[];
  evidence: string[];
  warnings: string[];
  executedAt: string;
  /**
   * Which entity this execution actually acted on, observed rather than
   * assumed — and observed twice, before the write and after the save.
   *
   * Kept beside the per-input transactions rather than inside them because
   * it is one fact about the whole execution, and because the invariant
   * that matters spans them: correct values on the wrong record must never
   * read as success.
   */
  target?: ExecutionTarget;
}

/**
 * The identity dimension of an execution, independent of field values.
 *
 * A run can have a verified target and an incomparable date, or verified
 * values on an unverified target. Collapsing the two into one boolean is
 * exactly how "the right values on the wrong record" would have passed.
 */
export interface ExecutionTarget {
  /** What the caller asked for, when it supplied an identity. */
  requestedId?: string;
  /** What was open before anything was written. */
  beforeId?: string;
  /** What was open once the save had settled. */
  afterSaveId?: string;
  entityType?: string;
  /** `verified` requires requested, pre-write and post-save to be one entity. */
  status: "verified" | "mismatch" | "unobservable" | "not-required";
  detail: string;
}

/**
 * What is known about an invocation's journey, independent of its outcome.
 *
 * Its own shape rather than fields on `ExecutionResult` because it is
 * produced in a different place and survives differently: the phase is
 * recorded as the execution passes each point, so it is still true after
 * the context that was executing has been destroyed, which is precisely
 * the case that produced a successful Salesforce write and a caller that
 * heard nothing.
 */
export interface ExecutionDispatch {
  /** Correlates this attempt across every hop, and makes a redelivery recognisable. */
  invocationId?: string;
  /**
   * How far the execution was OBSERVED to get.
   *
   * Absent when nobody could see. A caller whose answer was lost knows the
   * request was dispatched and nothing more, and naming a phase there
   * would be an observation it never made — it printed "last confirmed
   * phase: received" beside "the save had already been issued", two
   * sentences that cannot both be true.
   */
  phase?: ExecutionPhase;
  /**
   * Whether a persisted change may already exist despite this result.
   *
   * `true` on an `unknown` outcome is the whole reason that status exists:
   * it says a retry is not obviously safe.
   */
  mayHavePersisted: boolean;
  /**
   * Where the requested record lives, when execution stopped because it was
   * not open.
   *
   * Opening it replaces the document — and with it the context executing —
   * so the record is opened only after this result has been handed back,
   * and the caller invokes again against a page that is now correct.
   */
  openRecordAt?: string;
}
