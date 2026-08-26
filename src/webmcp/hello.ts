import { asToolResult, type WebMcpTool } from "./types";

/** The same minimal capability body is used by the controlled-page control and Salesforce spike. */
export function createHelloTool(
  name: "hello_webmcp" | "hello_salesforce",
  message: string
): WebMcpTool {
  return {
    name,
    description: "Verify that WebMCP is active",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    annotations: { readOnlyHint: true },
    execute: async () => asToolResult({ message })
  };
}

export function registerHelloControl(): "registered" | "unavailable" {
  if (!document.modelContext) {
    return "unavailable";
  }

  document.modelContext.registerTool(createHelloTool("hello_webmcp", "WebMCP is working"));
  return "registered";
}
