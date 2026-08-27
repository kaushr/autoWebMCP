/* ------------------------------------------------------------------ *
 * Execution result types.
 *
 * A leaf module on purpose: `engine.ts`, `execute.ts`, and `model.ts` all
 * need these shapes, and none of them should need each other to get them.
 * ------------------------------------------------------------------ */

export interface ExecutionCheckResult {
  name:
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

export type ExecutionOutcomeStatus = "succeeded" | "failed" | "partially_verified" | "blocked";

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
  /** Per-input before/requested/after-write/after-save, never collapsed. */
  transactions?: InputTransaction[];
  checks: ExecutionCheckResult[];
  evidence: string[];
  warnings: string[];
  executedAt: string;
}
