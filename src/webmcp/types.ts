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

export interface ModelContext {
  registerTool: (tool: WebMcpTool) => void;
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
