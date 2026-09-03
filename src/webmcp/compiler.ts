import {
  assertSemanticCapability,
  type CapabilityInputValues,
  type SemanticCapability
} from "../semantic/model";
import { compositionHintsFor } from "../semantic/composition";
import { asToolResult, type WebMcpTool } from "./types";

export type BindingInvoker = (
  capability: SemanticCapability,
  inputs: CapabilityInputValues
) => unknown | Promise<unknown>;

/**
 * Appends a sentence unless it is already there.
 *
 * A composition hint is derived from the capability set, not stored on the
 * capability, so it cannot accumulate across compiles. This guards the
 * other case: a description that already carries the sentence — because a
 * person wrote it themselves, or pasted what the Studio showed them —
 * must not end up saying it twice.
 */
function appendSentences(text: string, additions: readonly string[]): string {
  let result = text.trim();
  for (const addition of additions) {
    if (result.includes(addition)) continue;
    result = result.length > 0 ? `${result} ${addition}` : addition;
  }
  return result;
}

/**
 * Compiles a confirmed semantic capability without any model-generated code.
 *
 * `peers` are the other capabilities published on this surface. They are
 * the ONLY reason a composition hint may be stated: telling an agent that
 * some search will hand it an identity is a claim about what it can
 * actually call, so it is derived from the live tool set at registration
 * time rather than baked into a contract that was confirmed before the
 * peer existed. Omit them and the tool compiles exactly as it did before —
 * which is also what happens, correctly, when nothing else is published.
 */
export function compileCapability(
  capability: SemanticCapability,
  invokeBinding: BindingInvoker,
  peers: readonly SemanticCapability[] = []
): WebMcpTool {
  assertSemanticCapability(capability);
  const hints = compositionHintsFor(capability, peers);

  const properties = Object.fromEntries(
    capability.inputs.map((input) => [
      input.name,
      {
        // JSON Schema has no date primitive; the canonical wire contract for
        // a semantic date is an ISO string, and the description says so, so
        // an agent supplies YYYY-MM-DD and platform presentation stays the
        // execution layer's concern.
        type: input.type === "date" ? ("string" as const) : input.type,
        // Declared as well as described: `format` is the machine-readable
        // half, and anything building a caller from this schema needs it.
        ...(input.type === "date" ? { format: "date" as const } : {}),
        // The confirmed description first, always. A composition hint is
        // additional information about the tool set, never a replacement
        // for what a person approved this parameter to mean.
        description: appendSentences(
          input.type === "date" ? `${input.description} (date, YYYY-MM-DD)` : input.description,
          hints.inputs[input.name] ? [hints.inputs[input.name]] : []
        ),
        ...(input.enum ? { enum: input.enum } : {})
      }
    ])
  );
  const required = capability.inputs.filter((input) => input.required).map((input) => input.name);

  return {
    name: capability.id,
    description: appendSentences(capability.description, hints.tool),
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: capability.safety.readOnly
    },
    execute: async (inputs) => asToolResult(await invokeBinding(capability, inputs))
  };
}

export function registerCapability(
  capability: SemanticCapability,
  invokeBinding: BindingInvoker,
  peers: readonly SemanticCapability[] = []
): "registered" | "unavailable" {
  if (!document.modelContext) {
    return "unavailable";
  }

  document.modelContext.registerTool(compileCapability(capability, invokeBinding, peers));
  return "registered";
}
