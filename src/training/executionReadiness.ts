import type { TestFormField } from "./executionTestForm";
import type { BrowserExecutionBinding } from "../binding/browserExecution/model";

/* ------------------------------------------------------------------ *
 * Whether a capability can safely be executed yet.
 *
 * A live screenshot made the gap plain: AutoWebMCP knew Stage was a fixed
 * set of choices, knew it did not know the choices, disabled the control
 * accordingly — and left "Run test" enabled anyway. Knowing that you do
 * not know something has to control the workflow, not merely annotate it.
 *
 * Derived from the state of the inputs, never from any particular field.
 * The same rule covers enums, dependent picklists, and constrained
 * references as they arrive, because it asks only what is unresolved and
 * whether execution needs it.
 * ------------------------------------------------------------------ */

export type ReadinessBlocker =
  /** The application field behind this input was never established. */
  | "identity-unresolved"
  /** How to write the value is not known, and guessing would be a write into the dark. */
  | "type-unresolved"
  /** A constrained field whose currently valid values are not established. */
  | "domain-unresolved";

export interface UnreadyInput {
  name: string;
  label: string;
  blocker: ReadinessBlocker;
  /** What a human would need to do about it. */
  detail: string;
}

export interface ExecutionReadiness {
  canRun: boolean;
  blocked: UnreadyInput[];
  /** One line for the button's own explanation. Empty when execution may proceed. */
  summary: string;
}

/**
 * Assesses whether the collected inputs are safe to execute with.
 *
 * The distinction that matters is between knowledge execution *needs* and
 * knowledge that would merely be nice:
 *
 *   identity unresolved   → cannot execute; there is no field to write to
 *   type unresolved       → cannot execute; how to write is unknown
 *   domain unresolved     → cannot execute a REQUIRED constrained input;
 *                           no value can be checked, so any value is a guess
 *   optional enrichment   → may execute; the input can simply be left out
 *
 * An optional constrained input with an unknown domain does not block: it
 * can be omitted entirely, and omitting it is deterministic.
 */
export function assessExecutionReadiness(
  fields: readonly TestFormField[],
  binding: BrowserExecutionBinding
): ExecutionReadiness {
  const blocked: UnreadyInput[] = [];

  for (const field of fields) {
    const bound = binding.inputs.find((input) => input.semanticInput === field.name);

    if (bound && !bound.applicationField?.apiName) {
      blocked.push({
        name: field.name,
        label: field.label,
        blocker: "identity-unresolved",
        detail: `The application field behind "${field.label}" was never established.`
      });
      continue;
    }

    // A constrained input whose valid values are unknown cannot be given a
    // value that is checkable — and an unchecked business value is exactly
    // what the live run sent into a control that had no use for it.
    if (field.control === "select" && field.domainUnknown && field.required) {
      blocked.push({
        name: field.name,
        label: field.label,
        blocker: "domain-unresolved",
        detail: `"${field.label}" is a fixed set of choices and its valid values are not known yet.`
      });
    }
  }

  if (blocked.length === 0) return { canRun: true, blocked, summary: "" };

  const names = blocked.map((entry) => entry.label);
  const domainOnly = blocked.every((entry) => entry.blocker === "domain-unresolved");
  return {
    canRun: false,
    blocked,
    summary: domainOnly
      ? `Test unavailable until valid ${names.join(" and ")} choices are known.`
      : `Test unavailable until ${names.join(" and ")} ${names.length === 1 ? "is" : "are"} resolved.`
  };
}
