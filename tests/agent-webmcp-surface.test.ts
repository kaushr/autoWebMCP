// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { compileCapability } from "../src/webmcp/compiler";
import { webMcpAgentPorts } from "../src/agent/webmcp";
import { runAgentTask } from "../src/agent/loop";
import type { ModelContext, RegisteredTool, WebMcpTool } from "../src/webmcp/types";
import type { SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * The claim the whole harness rests on: the loop reaches the
 * application through `document.modelContext.executeTool` and through
 * nothing else.
 *
 * It would be easy to build a loop that called each capability's own
 * execute callback and called the result WebMCP. It would also prove
 * nothing — our code calling our code, with an agent-shaped narration
 * over the top. So these tests watch the browser API itself: what the
 * loop asked for, in which shape, and how many times the capability was
 * reached by any other route (none).
 * ------------------------------------------------------------------ */

const searchCapability: SemanticCapability = {
  id: "search_opportunities",
  name: "Search opportunities",
  description: "Find opportunities that match a search term.",
  inputs: [{ name: "search_this_list", description: "The search term.", type: "string", required: true, role: "query" }],
  outputs: [
    {
      name: "candidates",
      description: "Matching Opportunity records, each carrying `id`.",
      type: "array",
      role: "entity-identity",
      entityType: "Opportunity"
    }
  ],
  binding: { application: "salesforce-lightning", action: "search_opportunities" },
  provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true },
  safety: { readOnly: true, requiresConfirmation: false }
};

const updateCapability: SemanticCapability = {
  id: "update_opportunity",
  name: "Update opportunity",
  description: "Move an opportunity to a new stage and close date.",
  inputs: [
    {
      name: "opportunity_id",
      description: "Which Opportunity to act on.",
      type: "string",
      required: true,
      role: "target-identity",
      entityType: "Opportunity"
    },
    {
      name: "stage",
      description: "The sales stage.",
      type: "string",
      required: true,
      enum: ["Qualify", "Collaborate"]
    },
    { name: "close_date", description: "When it is expected to close.", type: "date", required: true }
  ],
  outputs: [],
  binding: { application: "salesforce-lightning", action: "update_opportunity" },
  provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true },
  safety: { readOnly: false, requiresConfirmation: true }
};

/**
 * A stand-in for the browser's WebMCP implementation, in the shapes a live
 * Chrome prototype actually uses: `getTools()` hands back stable objects
 * whose `inputSchema` is a JSON STRING, and `executeTool` takes that object
 * plus arguments encoded as a string.
 */
function fakeModelContext(invoke: (name: string, inputs: unknown) => unknown): {
  modelContext: ModelContext;
  executeTool: ReturnType<typeof vi.fn>;
} {
  const registered: WebMcpTool[] = [];
  let listing: RegisteredTool[] | undefined;

  const executeTool = vi.fn(async (tool: RegisteredTool, argumentsJson: string) => {
    const found = registered.find((entry) => entry.name === tool.name);
    if (!found) throw new Error(`no such tool: ${tool.name}`);
    return found.execute(JSON.parse(argumentsJson));
  });

  const modelContext = {
    registerTool: (tool: WebMcpTool) => {
      registered.push(tool);
      listing = undefined;
    },
    getTools: async () => {
      listing ??= registered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: JSON.stringify(tool.inputSchema) as unknown as RegisteredTool["inputSchema"],
        annotations: tool.annotations
      })) as RegisteredTool[];
      return listing;
    },
    executeTool
  } as unknown as ModelContext;

  registered.push(compileCapability(searchCapability, (subject, inputs) => invoke(subject.id, inputs), [updateCapability]));
  registered.push(compileCapability(updateCapability, (subject, inputs) => invoke(subject.id, inputs), [searchCapability]));

  return { modelContext, executeTool };
}

describe("the loop's only route to a capability is the browser's own API", () => {
  it("invokes through executeTool, with the browser's tool object and encoded arguments", async () => {
    const invoked: Array<{ name: string; inputs: unknown }> = [];
    const { modelContext, executeTool } = fakeModelContext((name, inputs) => {
      invoked.push({ name, inputs });
      return {
        status: "succeeded",
        candidates: [{ id: "006Ab00000XyZ", name: "Acme Renewal", entityType: "Opportunity" }],
        evidence: [],
        warnings: [],
        executedAt: "2026-09-03T00:00:00.000Z"
      };
    });

    const ports = webMcpAgentPorts(modelContext);
    const run = await runAgentTask("find the Acme opportunity", {
      discoverTools: ports.discoverTools,
      invoke: ports.invoke,
      plan: async (request) =>
        request.history.length === 0
          ? {
              action: "call_tool",
              tool: "search_opportunities",
              arguments_json: JSON.stringify({ search_this_list: "Acme" }),
              summary: ""
            }
          : { action: "finish", tool: "", arguments_json: "", summary: "Found one candidate." }
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    const [tool, argumentsJson] = executeTool.mock.calls[0];
    // The object the browser handed back, not its name: passing a name
    // throws "The provided value is not of type 'RegisteredTool'".
    const listed = await modelContext.getTools();
    expect(tool).toBe(listed.find((entry) => entry.name === "search_opportunities"));
    // And the arguments encoded: passing a plain object throws
    // "Failed to parse input arguments".
    expect(typeof argumentsJson).toBe("string");
    expect(JSON.parse(argumentsJson as string)).toEqual({ search_this_list: "Acme" });

    // The capability was reached exactly once, and only from that call.
    expect(invoked).toEqual([{ name: "search_opportunities", inputs: { search_this_list: "Acme" } }]);
    expect(run.steps[0].observation).toMatchObject({ kind: "search", candidateCount: 1 });
  });

  it("plans over the composed description an agent actually receives", async () => {
    // The composition hint is added at registration time from the peer set,
    // so it exists only on the surface — reading it back through getTools()
    // is the only way to know an agent will see it.
    const { modelContext } = fakeModelContext(() => ({}));
    const tools = await webMcpAgentPorts(modelContext).discoverTools();

    const update = tools.find((tool) => tool.name === "update_opportunity");
    expect(update?.description).toMatch(/search_opportunities returns candidate Opportunity records/);
    expect(update?.inputSchema?.properties.opportunity_id.description).toMatch(/If unknown, search_opportunities/);
    expect(update?.inputSchema?.properties.close_date.format).toBe("date");
    expect(update?.readOnlyHint).toBe(false);

    const search = tools.find((tool) => tool.name === "search_opportunities");
    expect(search?.readOnlyHint).toBe(true);
  });

  it("never invokes a capability the browser did not list", async () => {
    const { modelContext, executeTool } = fakeModelContext(() => ({}));
    const ports = webMcpAgentPorts(modelContext);
    const run = await runAgentTask("delete everything", {
      discoverTools: ports.discoverTools,
      invoke: ports.invoke,
      plan: async () => ({
        action: "call_tool",
        tool: "delete_all_opportunities",
        arguments_json: "{}",
        summary: ""
      })
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(run.stopReason).toBe("invalid_action");
  });

  it("refuses a value the published enum does not offer, before the browser is asked", async () => {
    // The execution layer would refuse it too, but only after opening an
    // edit surface on a live record. Refusing here costs nothing.
    const { modelContext, executeTool } = fakeModelContext(() => ({}));
    const ports = webMcpAgentPorts(modelContext);
    const run = await runAgentTask("move it to Negotiation", {
      discoverTools: ports.discoverTools,
      invoke: ports.invoke,
      plan: async () => ({
        action: "call_tool",
        tool: "update_opportunity",
        arguments_json: JSON.stringify({
          opportunity_id: "006Ab00000XyZ",
          stage: "Negotiation",
          close_date: "2026-10-15"
        }),
        summary: ""
      })
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(run.rejections[0].reason).toMatch(/Qualify, Collaborate/);
  });
});
