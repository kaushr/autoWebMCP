import { agentToolDefinitions, type AgentToolDefinition } from "./model";
import type { ModelContext, RegisteredTool, WebMcpToolResult } from "../webmcp/types";

/* ------------------------------------------------------------------ *
 * The loop's only route to the application: WebMCP itself.
 *
 * This module is deliberately tiny and deliberately the ONLY place the
 * harness touches `document.modelContext`. The demonstration is worth
 * nothing if the loop reaches an execution engine directly — that would be
 * our code calling our code, dressed up as an agent — so the boundary is
 * one file with two functions, and it is easy to check that nothing else
 * crosses it.
 *
 * Both call shapes here were established empirically against Chrome's
 * WebMCP prototype and are not guesses: `executeTool` requires the
 * `RegisteredTool` OBJECT that `getTools()` handed back (a name throws),
 * and the arguments must be JSON-encoded as a string (an object throws).
 * ------------------------------------------------------------------ */

export interface WebMcpAgentPorts {
  discoverTools: () => Promise<AgentToolDefinition[]>;
  invoke: (toolName: string, argumentsJson: string) => Promise<string>;
}

export function webMcpAgentPorts(modelContext: ModelContext): WebMcpAgentPorts {
  /**
   * The browser's own tool objects from the most recent discovery.
   *
   * Held because `executeTool` needs the object, not the name — and the
   * loop discovers immediately before every plan, so this is never stale
   * by more than one step. A name the cache does not know triggers a fresh
   * read rather than a failure, so a tool registered mid-run is callable.
   */
  let discovered: RegisteredTool[] = [];

  const readTools = async (): Promise<RegisteredTool[]> => {
    discovered = await modelContext.getTools();
    return discovered;
  };

  return {
    async discoverTools() {
      return agentToolDefinitions(await readTools());
    },

    async invoke(toolName, argumentsJson) {
      let tool = discovered.find((entry) => entry.name === toolName);
      if (!tool) tool = (await readTools()).find((entry) => entry.name === toolName);
      if (!tool) throw new Error(`"${toolName}" is not registered on this document.`);

      const result: WebMcpToolResult | string = await modelContext.executeTool(tool, argumentsJson);
      // Kept as text on purpose. Whatever envelope this browser wraps a
      // result in is opened once, in one place, by the same decoder the
      // Studio's own test panel uses.
      return typeof result === "string" ? result : JSON.stringify(result);
    }
  };
}
