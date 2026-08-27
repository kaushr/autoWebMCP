import {
  assertSemanticCapability,
  type CapabilityInputValues,
  type SemanticCapability
} from "../semantic/model";
import { asToolResult, type WebMcpTool } from "./types";

export type BindingInvoker = (
  capability: SemanticCapability,
  inputs: CapabilityInputValues
) => unknown | Promise<unknown>;

/** Compiles a confirmed semantic capability without any model-generated code. */
export function compileCapability(
  capability: SemanticCapability,
  invokeBinding: BindingInvoker
): WebMcpTool {
  assertSemanticCapability(capability);

  const properties = Object.fromEntries(
    capability.inputs.map((input) => [
      input.name,
      {
        // JSON Schema has no date primitive; the canonical wire contract for
        // a semantic date is an ISO string, and the description says so, so
        // an agent supplies YYYY-MM-DD and platform presentation stays the
        // execution layer's concern.
        type: input.type === "date" ? ("string" as const) : input.type,
        description: input.type === "date" ? `${input.description} (date, YYYY-MM-DD)` : input.description,
        ...(input.enum ? { enum: input.enum } : {})
      }
    ])
  );
  const required = capability.inputs.filter((input) => input.required).map((input) => input.name);

  return {
    name: capability.id,
    description: capability.description,
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
  invokeBinding: BindingInvoker
): "registered" | "unavailable" {
  if (!document.modelContext) {
    return "unavailable";
  }

  document.modelContext.registerTool(compileCapability(capability, invokeBinding));
  return "registered";
}
