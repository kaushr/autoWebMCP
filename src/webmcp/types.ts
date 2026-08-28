import type { CapabilityInputValues } from "../semantic/model";

export interface JsonObjectSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "boolean";
      description: string;
      enum?: string[];
    }
  >;
  required?: string[];
  additionalProperties: false;
}

export interface WebMcpToolResult {
  content: Array<{
    type: "text";
    text: string;
  }>;
}

export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  annotations: {
    readOnlyHint: boolean;
  };
  execute: (inputs: CapabilityInputValues) => Promise<WebMcpToolResult>;
}

/**
 * A tool as the browser hands it back from `getTools()` — the object
 * `executeTool` requires. Structural on purpose: this is the browser's
 * object, not ours, and only the fields we actually rely on are declared.
 */
export interface RegisteredTool {
  name: string;
  description?: string;
  inputSchema?: JsonObjectSchema;
}

export interface ModelContext {
  registerTool: (tool: WebMcpTool) => void;
  /** Every tool registered on this document, including any another script registered. */
  getTools: () => Promise<RegisteredTool[]>;
  /**
   * Invokes a registered tool.
   *
   * Both argument shapes were established empirically against Chrome's
   * WebMCP prototype, because both fail loudly and unhelpfully otherwise:
   * the first argument must be the `RegisteredTool` object from
   * `getTools()` — passing the tool's *name* throws "The provided value is
   * not of type 'RegisteredTool'" — and the second must be the arguments
   * **JSON-encoded as a string**; passing a plain object throws "Failed to
   * parse input arguments".
   */
  executeTool: (tool: RegisteredTool, argumentsJson: string) => Promise<WebMcpToolResult>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
}

export function asToolResult(value: unknown): WebMcpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value)
      }
    ]
  };
}
