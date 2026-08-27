import {
  invokeSemanticAction,
  resolveSemanticTarget,
  setFieldValue,
  verifyOutcome,
  waitForApplicationReaction,
  type PlatformResolverAdapter,
  type ResolvedTarget
} from "./engine";
import type { BrowserBindingInput, BrowserExecutionBinding } from "./model";
import type { ExecutionCheckResult, ExecutionOutcomeStatus, ExecutionResult } from "./result";

export type { ExecutionOutcomeStatus, ExecutionResult } from "./result";

/* ------------------------------------------------------------------ *
 * Execution orchestration.
 *
 * Ties the generic engine's primitives into one attempt: resolve every
 * target, set every value, commit, wait for the application, verify. This
 * is a write operation on the user's own authenticated session, so the only
 * entry point is `executeConfirmed` — there is deliberately no plain
 * `execute` that runs without an explicit, human-approved confirmation.
 * ------------------------------------------------------------------ */

export interface ExecuteOptions {
  root: ParentNode & Node;
  binding: BrowserExecutionBinding;
  /** Semantic input name → the value to write, e.g. `{ close_date: "2026-12-15" }`. */
  inputs: Record<string, string>;
  adapter?: PlatformResolverAdapter;
  /**
   * Deliberately not optional and deliberately typed `true`, not `boolean`:
   * a caller must write the literal confirmation, not thread a variable that
   * happens to be false through unnoticed. Enforced again at runtime below,
   * since this value may cross a message-passing boundary where the type
   * system cannot help.
   */
  confirmed: true;
  reaction?: { timeoutMs?: number; quietMs?: number };
}

/**
 * Any check that could not honestly be answered ("skipped") keeps the
 * result out of `succeeded` without treating it as a failure the operator
 * did something wrong to cause — see docs/BINDING_VALIDATION.md on
 * `requires-setup` for the same principle applied to the supported-API
 * route. A real `fail` always wins; skips alone land on
 * `partially_verified`.
 */
function deriveStatus(checks: readonly ExecutionCheckResult[]): ExecutionOutcomeStatus {
  if (checks.some((check) => check.status === "fail")) return "failed";
  if (checks.some((check) => check.status === "skipped")) return "partially_verified";
  return "succeeded";
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Performs one execution attempt of a browser execution binding against a
 * live DOM: resolve → set → commit → wait → verify. Refuses to run without
 * an explicit confirmation, and stops before writing anything the moment a
 * target cannot be resolved or a value cannot be set — a half-filled form
 * left mid-edit is worse than an honest refusal to start.
 */
export async function executeConfirmed(options: ExecuteOptions): Promise<ExecutionResult> {
  if (options.confirmed !== true) {
    throw new Error("executeConfirmed refuses to run without an explicit confirmed: true.");
  }

  const { root, binding, inputs, adapter } = options;
  const checks: ExecutionCheckResult[] = [];
  const evidence: string[] = [];
  const warnings: string[] = [];

  /* --- A: resolve every target before writing anything --------------- */
  const resolved: Array<{ input: BrowserBindingInput; target: ResolvedTarget }> = [];
  for (const input of binding.inputs) {
    const outcome = resolveSemanticTarget(root, input.semanticTarget, adapter);
    if (!outcome.ok) {
      checks.push({ name: "target_resolved", status: "fail", detail: `"${input.semanticInput}": ${outcome.reason}` });
      return {
        status: "blocked",
        checks,
        evidence,
        warnings: [`Execution stopped before writing anything — ${outcome.reason}`],
        executedAt: now()
      };
    }
    resolved.push({ input, target: outcome.target });
  }
  checks.push({
    name: "target_resolved",
    status: "pass",
    detail: `All ${binding.inputs.length} input target(s) resolved on the live page.`
  });

  /* --- B: set every value ---------------------------------------------- */
  let allSet = true;
  for (const { input, target } of resolved) {
    const value = inputs[input.semanticInput];
    if (value === undefined) {
      allSet = false;
      warnings.push(`No value was supplied for "${input.semanticInput}".`);
      continue;
    }
    const result = await setFieldValue(target, value, input.valueKind, adapter);
    if (!result.ok) allSet = false;
    evidence.push(`${input.semanticInput}: ${result.detail}`);
  }
  checks.push({
    name: "value_set",
    status: allSet ? "pass" : "fail",
    detail: allSet ? "Every input value was set." : "One or more input values could not be set."
  });
  if (!allSet) {
    return {
      status: "blocked",
      checks,
      evidence,
      warnings: [...warnings, "Execution stopped before committing — not every value could be set."],
      executedAt: now()
    };
  }

  /* --- C: commit --------------------------------------------------------- */
  const commit = await invokeSemanticAction(root, binding.commit.semanticAction, adapter);
  checks.push({ name: "commit_invoked", status: commit.ok ? "pass" : "fail", detail: commit.detail });
  if (!commit.ok) {
    return { status: "failed", checks, evidence, warnings, executedAt: now() };
  }
  evidence.push(commit.detail);

  /* --- D: wait for the application's asynchronous reaction --------------- */
  const reaction = await waitForApplicationReaction({ root, ...options.reaction });
  evidence.push(
    reaction.settled
      ? `The page settled ${reaction.elapsedMs}ms after committing.`
      : `The page did not settle within ${reaction.elapsedMs}ms; verification proceeded anyway.`
  );

  /* --- E: verify ----------------------------------------------------------- */
  const verification = verifyOutcome({
    root,
    checks: binding.verification,
    inputs: resolved.map(({ input }) => ({
      target: input.semanticTarget,
      expectedValue: inputs[input.semanticInput] ?? ""
    })),
    adapter
  });
  checks.push(...verification);

  return { status: deriveStatus(checks), checks, evidence, warnings, executedAt: now() };
}
