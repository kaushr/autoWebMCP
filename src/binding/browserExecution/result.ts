/* ------------------------------------------------------------------ *
 * Execution result types.
 *
 * A leaf module on purpose: `engine.ts`, `execute.ts`, and `model.ts` all
 * need these shapes, and none of them should need each other to get them.
 * ------------------------------------------------------------------ */

export interface ExecutionCheckResult {
  name:
    | "target_resolved"
    | "value_set"
    | "commit_invoked"
    | "validation_clear"
    | "returned_to_record"
    | "value_verified";
  status: "pass" | "fail" | "skipped";
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
  checks: ExecutionCheckResult[];
  evidence: string[];
  warnings: string[];
  executedAt: string;
}
