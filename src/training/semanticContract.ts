import type { SemanticCapability } from "../semantic/model";

/* ------------------------------------------------------------------ *
 * What a human is actually agreeing to when they confirm.
 *
 * The invariant the whole confirmation step exists to keep:
 *
 *   THE HUMAN CONFIRMS THE SAME SEMANTIC CONTRACT THE AGENT RECEIVES.
 *
 * So this has to be the WHOLE agent-facing surface, and the temptation is
 * to include only the parts that look structural — a name, a type, a
 * required flag. Descriptions were left out originally on exactly that
 * reasoning, and it was wrong: an agent picking between tools reads the
 * capability description, an agent filling in arguments reads the input
 * ones, and both are published verbatim into the WebMCP contract. A
 * description that changed after confirmation is a contract that changed
 * after confirmation, and it must invalidate the approval the same way a
 * renamed parameter does.
 *
 * Deliberately NOT included: the execution binding, provenance, and
 * anything about how the capability is performed. Those are not what a
 * person is asked to accept the meaning of, and changing an execution
 * path does not make an approved meaning stale.
 * ------------------------------------------------------------------ */

export function semanticContract(capability: SemanticCapability): string {
  return JSON.stringify({
    name: capability.name,
    description: capability.description,
    inputs: capability.inputs.map((input) => [input.name, input.type, input.required, input.description])
  });
}

/** Whether a confirmation given for `confirmed` still describes `edited`. */
export function contractChanged(confirmed: SemanticCapability, edited: SemanticCapability): boolean {
  return semanticContract(confirmed) !== semanticContract(edited);
}
