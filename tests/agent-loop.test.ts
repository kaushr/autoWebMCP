import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_STEPS, runAgentTask, type AgentPorts } from "../src/agent/loop";
import { decideAction, validateToolArguments } from "../src/agent/action";
import { agentToolDefinitions, type AgentPlanRequest, type AgentToolDefinition } from "../src/agent/model";
import { loopControlFor, observeToolResult } from "../src/agent/observation";
import { callableHere, registrableHere, type PublicationRecord } from "../src/webmcp/publication";
import type { SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * The page-side agent harness.
 *
 * What these protect is narrow and specific. The loop is a CALLER: it may
 * name a published tool and supply its declared parameters, and it may do
 * nothing else. Every safety property the runtime already keeps — target
 * identity, four-fact verification, duplicate-invocation refusal, the
 * distinction between a failed write and an unheard one — has to survive
 * having an agent in front of it, and the only way that happens is if the
 * loop cannot reach past `executeTool` and cannot argue with an outcome.
 * ------------------------------------------------------------------ */

/** A WebMCP response in the shape a live Chrome invocation actually returns. */
const envelope = (payload: unknown): string =>
  JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }] });

const SEARCH: AgentToolDefinition = {
  name: "search_opportunities",
  description:
    "Find opportunities that match a search term in the opportunities list. May return zero, one, or several " +
    "matching Opportunity candidates, and never chooses between them. Each candidate carries the Opportunity " +
    "record identity that identity-gated tools require.",
  inputSchema: {
    type: "object",
    properties: { search_this_list: { type: "string", description: "The search term." } },
    required: ["search_this_list"],
    additionalProperties: false
  },
  readOnlyHint: true
};

const UPDATE: AgentToolDefinition = {
  name: "update_opportunity",
  description:
    "Move an opportunity to a new stage and close date. If opportunity_id is not already known, " +
    "search_opportunities returns candidate Opportunity records; choose the intended one and pass its identity here.",
  inputSchema: {
    type: "object",
    properties: {
      opportunity_id: {
        type: "string",
        description: "Which Opportunity to act on. If unknown, search_opportunities returns candidates."
      },
      stage: { type: "string", description: "The sales stage.", enum: ["Qualify", "Collaborate", "Closed Won"] },
      close_date: { type: "string", description: "When it is expected to close (date, YYYY-MM-DD)", format: "date" }
    },
    required: ["opportunity_id", "stage", "close_date"],
    additionalProperties: false
  },
  readOnlyHint: false
};

const CONTACTS: AgentToolDefinition = {
  name: "find_decision_maker_contacts",
  description: "Locate likely stakeholders at a target company by narrowing contacts to a function and seniority.",
  inputSchema: {
    type: "object",
    properties: {
      company_name_domain_or_industry: { type: "string", description: "The company." },
      function: { type: "string", description: "The business function." },
      seniority: { type: "string", description: "The level of authority." }
    },
    additionalProperties: false
  },
  readOnlyHint: true
};

const oneCandidate = {
  status: "succeeded",
  candidates: [{ id: "006Ab00000XyZ", name: "Acme Industrial — Renewal", entityType: "Opportunity" }],
  evidence: [],
  warnings: [],
  executedAt: "2026-09-03T00:00:00.000Z"
};

const savedAndVerified = {
  status: "succeeded",
  checks: [{ name: "value_verified", status: "pass", detail: "read back" }],
  transactions: [
    { name: "stage", requestedValue: "Collaborate", afterSaveValue: "Collaborate", verified: "yes", detail: "ok" }
  ],
  target: { requestedId: "006Ab00000XyZ", afterSaveId: "006Ab00000XyZ", status: "verified", detail: "same record" },
  dispatch: { phase: "reported", mayHavePersisted: true },
  evidence: [],
  warnings: [],
  executedAt: "2026-09-03T00:00:00.000Z"
};

/** Ports whose planner is a fixed script, for the cases where the plan is not what is under test. */
function scriptedPorts(
  script: unknown[],
  invoke: (tool: string, argumentsJson: string) => Promise<string>,
  tools: AgentToolDefinition[] = [SEARCH, UPDATE]
): AgentPorts & { planRequests: AgentPlanRequest[]; discoveries: number } {
  const planRequests: AgentPlanRequest[] = [];
  const state = { discoveries: 0 };
  const ports = {
    discoverTools: async () => {
      state.discoveries += 1;
      return tools;
    },
    plan: async (request: AgentPlanRequest) => {
      planRequests.push(request);
      const next = script.shift();
      if (next === undefined) throw new Error("the fake planner ran out of scripted answers");
      return next;
    },
    invoke,
    now: () => 0
  };
  return Object.defineProperty({ ...ports, planRequests }, "discoveries", {
    get: () => state.discoveries
  }) as AgentPorts & { planRequests: AgentPlanRequest[]; discoveries: number };
}

const callTool = (tool: string, args: Record<string, unknown>): unknown => ({
  action: "call_tool",
  tool,
  arguments_json: JSON.stringify(args),
  summary: ""
});

const finish = (summary: string): unknown => ({ action: "finish", tool: "", arguments_json: "", summary });

/* ------------------- the tool list is the browser's ------------------- */

describe("the loop plans against the live tool surface, never a registry", () => {
  it("asks the browser again before every step", async () => {
    const ports = scriptedPorts(
      [callTool("search_opportunities", { search_this_list: "Acme" }), finish("done")],
      async () => envelope(oneCandidate)
    );
    await runAgentTask("find the Acme opportunity", ports);
    // One discovery per planning step, not one per run.
    expect(ports.discoveries).toBe(2);
  });

  it("offers the model a tool that appeared only after the run started", async () => {
    let tools = [SEARCH];
    const requests: AgentPlanRequest[] = [];
    await runAgentTask("do the thing", {
      discoverTools: async () => tools,
      plan: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          tools = [SEARCH, UPDATE];
          return callTool("search_opportunities", { search_this_list: "Acme" });
        }
        return finish("done");
      },
      invoke: async () => envelope(oneCandidate),
      now: () => 0
    });
    expect(requests[0].tools.map((tool) => tool.name)).toEqual(["search_opportunities"]);
    expect(requests[1].tools.map((tool) => tool.name)).toEqual(["search_opportunities", "update_opportunity"]);
  });

  it("stops rather than planning against an empty surface", async () => {
    const plan = vi.fn();
    const run = await runAgentTask("do the thing", {
      discoverTools: async () => [],
      plan,
      invoke: async () => ""
    });
    expect(run.stopReason).toBe("no_tools");
    expect(plan).not.toHaveBeenCalled();
  });

  it("reads descriptions, schemas and the read-only annotation from what getTools returned", () => {
    const [tool] = agentToolDefinitions([
      {
        name: "search_opportunities",
        description: "Find opportunities.",
        // The string form a live Chrome `getTools()` hands back.
        inputSchema: JSON.stringify(SEARCH.inputSchema) as unknown as typeof SEARCH.inputSchema,
        annotations: { readOnlyHint: true }
      } as never
    ]);
    expect(tool.description).toBe("Find opportunities.");
    expect(tool.inputSchema?.properties.search_this_list.type).toBe("string");
    expect(tool.readOnlyHint).toBe(true);
  });

  it("reports an absent annotation as absent rather than as not read-only", () => {
    // A browser that does not publish annotations must not be read as
    // publishing `false`, which would be a claim about the tool.
    const [tool] = agentToolDefinitions([{ name: "search_opportunities", description: "Find." }]);
    expect(tool.readOnlyHint).toBeUndefined();
  });
});

/* ---------------- the model chooses from the metadata ---------------- */

describe("the tool set alone is enough to compose a task", () => {
  /**
   * A planner that knows nothing about Salesforce, opportunities, or this
   * repository — it reads only the descriptions and schemas it is handed.
   *
   * The point of the demonstration is that composition is inferable from
   * the published semantic surface. A planner with `if update then search
   * first` baked into it would prove the opposite, so this one derives the
   * order: it looks for a parameter it cannot fill, finds the tool whose
   * description says it hands out candidates, and calls that first.
   */
  const metadataPlanner = async (request: AgentPlanRequest): Promise<unknown> => {
    const known: Record<string, string> = {};
    for (const entry of request.history) {
      if (entry.observation.kind === "search" && entry.observation.candidates.length === 1) {
        known.identity = entry.observation.candidates[0].id;
      }
    }

    const writer = request.tools.find((tool) => tool.readOnlyHint === false);
    if (!writer?.inputSchema) return finish("nothing to write with");

    const identityParameter = Object.entries(writer.inputSchema.properties).find(([, property]) =>
      /if unknown/i.test(property.description)
    );
    if (identityParameter && !known.identity) {
      const producerName = identityParameter[1].description.match(/([a-z_]+) returns candidate/)?.[1];
      const producer = request.tools.find((tool) => tool.name === producerName);
      if (!producer?.inputSchema) return finish("no producer on the surface");
      const term = Object.keys(producer.inputSchema.properties)[0];
      return callTool(producer.name, { [term]: "Acme Industrial" });
    }
    if (request.history.some((entry) => entry.tool === writer.name)) return finish("the write is done");

    return callTool(writer.name, {
      [identityParameter?.[0] ?? "id"]: known.identity,
      stage: "Collaborate",
      close_date: "2026-10-15"
    });
  };

  it("derives search → write from the published descriptions, with nothing hardcoded", async () => {
    const invoked: Array<{ tool: string; args: string }> = [];
    const run = await runAgentTask("move the Acme opportunity to Collaborate on 2026-10-15", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: metadataPlanner,
      invoke: async (tool, argumentsJson) => {
        invoked.push({ tool, args: argumentsJson });
        return tool === "search_opportunities" ? envelope(oneCandidate) : envelope(savedAndVerified);
      },
      now: () => 0
    });

    expect(invoked.map((call) => call.tool)).toEqual(["search_opportunities", "update_opportunity"]);
    // The identity came out of the first tool's result and into the second's argument.
    expect(JSON.parse(invoked[1].args)).toEqual({
      opportunity_id: "006Ab00000XyZ",
      stage: "Collaborate",
      close_date: "2026-10-15"
    });
    expect(run.stopReason).toBe("finished");
  });

  it("carries the previous result into the next planning step", async () => {
    const ports = scriptedPorts(
      [callTool("search_opportunities", { search_this_list: "Acme" }), finish("done")],
      async () => envelope(oneCandidate)
    );
    await runAgentTask("find it", ports);
    const second = ports.planRequests[1];
    expect(second.history).toHaveLength(1);
    expect(second.history[0].tool).toBe("search_opportunities");
    expect(second.history[0].observation).toMatchObject({
      kind: "search",
      candidateCount: 1,
      candidates: [{ id: "006Ab00000XyZ" }]
    });
  });

  it("tells the model how much budget is left, counting down", async () => {
    const ports = scriptedPorts(
      [callTool("search_opportunities", { search_this_list: "Acme" }), finish("done")],
      async () => envelope(oneCandidate)
    );
    await runAgentTask("find it", ports);
    expect(ports.planRequests.map((request) => request.remainingSteps)).toEqual([
      DEFAULT_MAX_STEPS,
      DEFAULT_MAX_STEPS - 1
    ]);
  });
});

/* ----------------------- what may be executed ----------------------- */

describe("an action is checked against the live tools before anything runs", () => {
  it("refuses a tool name that is not on the surface", async () => {
    const invoke = vi.fn();
    const run = await runAgentTask("do it", {
      ...scriptedPorts([callTool("delete_everything", {})], invoke),
      invoke
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(run.stopReason).toBe("invalid_action");
    expect(run.rejections[0].reason).toMatch(/not registered on this document/i);
  });

  it("refuses arguments the published schema does not accept", async () => {
    const invoke = vi.fn();
    const run = await runAgentTask("do it", {
      ...scriptedPorts([callTool("update_opportunity", { opportunity_id: "006", stage: "Definitely", close_date: "2026-10-15" })], invoke),
      invoke
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(run.stopReason).toBe("invalid_action");
    expect(run.rejections[0].reason).toMatch(/is not one of the values/i);
  });

  it("refuses a required parameter that was left out", () => {
    const decision = decideAction(callTool("update_opportunity", { stage: "Collaborate" }), [SEARCH, UPDATE]);
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toMatch(/"opportunity_id" is required/);
  });

  it("refuses an action that is neither a call nor a finish", () => {
    expect(decideAction({ action: "think" }, [SEARCH]).ok).toBe(false);
    expect(decideAction("call search_opportunities", [SEARCH]).ok).toBe(false);
  });

  it("does not re-ask after a refusal", async () => {
    // A refusal that produces another model call is a retry loop, and a
    // retry loop is the one thing a bounded shell must not grow.
    const plan = vi.fn(async () => callTool("nope", {}));
    const run = await runAgentTask("do it", {
      discoverTools: async () => [SEARCH],
      plan,
      invoke: async () => ""
    });
    expect(plan).toHaveBeenCalledTimes(1);
    expect(run.stopReason).toBe("invalid_action");
  });
});

describe("nothing but declared parameter values can reach the application", () => {
  it("has no channel for a selector, a script, or a browser command", () => {
    // Everything a model might smuggle out, in one action. What survives
    // is the declared parameters and nothing else — the extra keys are
    // refused, and there is no field in the action shape for the rest.
    const decision = decideAction(
      {
        action: "call_tool",
        tool: "search_opportunities",
        arguments_json: JSON.stringify({
          search_this_list: "Acme",
          selector: "#opportunity-row > a",
          xpath: "//button[@name='save']",
          script: "document.querySelector('button').click()"
        }),
        summary: ""
      },
      [SEARCH]
    );
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toMatch(/not a parameter it declares/);
  });

  it("refuses a structure where a primitive was declared", () => {
    // The one shape that could carry something other than a value.
    const validation = validateToolArguments(SEARCH.inputSchema, {
      search_this_list: { steps: ["click", "type"] }
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors[0]).toMatch(/single string value/);
  });

  it("sends no argument at all to a tool whose schema the browser did not publish", () => {
    // An unpublished contract is an unknown one, and an unknown contract
    // is not a licence to send whatever was asked for.
    expect(validateToolArguments(undefined, { anything: "at all" }).ok).toBe(false);
    expect(validateToolArguments(undefined, {}).ok).toBe(true);
  });

  it("keeps only primitives keyed by declared parameters", () => {
    const validation = validateToolArguments(UPDATE.inputSchema, {
      opportunity_id: "006Ab00000XyZ",
      stage: "Collaborate",
      close_date: "2026-10-15"
    });
    expect(validation.ok).toBe(true);
    expect(Object.keys(validation.args)).toEqual(["opportunity_id", "stage", "close_date"]);
    expect(Object.values(validation.args).every((value) => typeof value !== "object")).toBe(true);
  });
});

/* ----------------------- what is on screen when ----------------------- */

describe("a call is published before it is made", () => {
  it("shows the dispatched call while it is still waiting, then replaces it with the step", async () => {
    // A live Salesforce write took forty-one seconds, and for all of them
    // the trace showed nothing: the step was only appended once its answer
    // arrived, so a slow application and a hung page looked identical.
    const snapshots: Array<{ inFlight?: string; steps: number }> = [];
    let releaseInvoke: () => void = () => undefined;
    const invoking = new Promise<void>((resolve) => {
      releaseInvoke = resolve;
    });

    const run = runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: async (request) =>
        request.history.length === 0
          ? callTool("update_opportunity", {
              opportunity_id: "006A",
              stage: "Collaborate",
              close_date: "2026-10-15"
            })
          : finish("done"),
      invoke: async () => {
        await invoking;
        return envelope(savedAndVerified);
      },
      onProgress: (snapshot) =>
        snapshots.push({ inFlight: snapshot.inFlight?.tool, steps: snapshot.steps.length }),
      now: () => 0
    });

    // Let the loop reach the dispatch and stop there.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const waiting = snapshots.find((entry) => entry.inFlight);
    expect(waiting).toEqual({ inFlight: "update_opportunity", steps: 0 });

    releaseInvoke();
    const finished = await run;

    // And once it answers, nothing is left claiming to be running.
    expect(finished.inFlight).toBeUndefined();
    expect(finished.steps.map((step) => step.tool)).toEqual(["update_opportunity"]);
    expect(snapshots.at(-1)).toEqual({ inFlight: undefined, steps: 1 });
  });

  it("leaves nothing running when a call throws", async () => {
    const run = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: async () =>
        callTool("update_opportunity", { opportunity_id: "006A", stage: "Collaborate", close_date: "2026-10-15" }),
      invoke: async () => {
        throw new Error("the extension is not connected");
      },
      now: () => 0
    });
    expect(run.inFlight).toBeUndefined();
    expect(run.stopReason).toBe("tool_failed");
  });
});

/* --------------------------- the budget --------------------------- */

describe("the loop is bounded", () => {
  it("stops at the maximum number of steps and says so", async () => {
    const run = await runAgentTask("keep going", {
      discoverTools: async () => [SEARCH],
      plan: async () => callTool("search_opportunities", { search_this_list: "Acme" }),
      invoke: async () => envelope({ ...oneCandidate, candidates: [] }),
      maxSteps: 3,
      now: () => 0
    });
    expect(run.steps).toHaveLength(3);
    expect(run.stopReason).toBe("step_budget_exhausted");
    expect(run.detail).toMatch(/budget of 3/);
  });

  it("does not charge a retry the application asked for", async () => {
    // Two of five steps in a live run went on pages being opened — the
    // Opportunity list, then the record — and the budget ran out one call
    // short of the model being able to report it had finished, having
    // verified the write. A block the runtime told us to re-invoke wrote
    // nothing and searched nothing; charging it is charging for a redirect.
    const openedRecord = {
      status: "blocked",
      dispatch: { phase: "target-opening", mayHavePersisted: false, openRecordAt: "/lightning/r/006A/view" },
      checks: [],
      evidence: [],
      warnings: ["Nothing was written, so invoking again is safe."],
      executedAt: "2026-09-03T00:00:00.000Z"
    };
    const answers = [envelope(openedRecord), envelope(openedRecord), envelope(savedAndVerified)];
    const budgets: number[] = [];

    const run = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: async (request) => {
        budgets.push(request.remainingSteps);
        return request.history.some((entry) => entry.observation.kind === "write" && entry.observation.status === "succeeded")
          ? finish("saved and verified")
          : callTool("update_opportunity", {
              opportunity_id: "006A",
              stage: "Collaborate",
              close_date: "2026-10-15"
            });
      },
      invoke: async () => answers.shift() ?? envelope(savedAndVerified),
      maxSteps: 3,
      now: () => 0
    });

    // Three calls made, one of them a real write; the budget only ever saw
    // that one, so the run reached its own conclusion.
    expect(run.steps).toHaveLength(3);
    expect(run.stopReason).toBe("finished");
    // The budget offered to the model never moved while nothing was spent.
    expect(budgets).toEqual([3, 3, 3, 2]);
  });

  it("still stops a run whose retries never end", async () => {
    // The budget no longer bounds this on its own, so something else must.
    const openedRecord = {
      status: "blocked",
      dispatch: { phase: "target-opening", mayHavePersisted: false, openRecordAt: "/lightning/r/006A/view" },
      checks: [],
      evidence: [],
      warnings: [],
      executedAt: "2026-09-03T00:00:00.000Z"
    };
    const run = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: async () =>
        callTool("update_opportunity", { opportunity_id: "006A", stage: "Collaborate", close_date: "2026-10-15" }),
      invoke: async () => envelope(openedRecord),
      maxSteps: 3,
      now: () => 0
    });
    expect(run.stopReason).toBe("step_budget_exhausted");
    expect(run.steps).toHaveLength(6);
    expect(run.detail).toMatch(/retries the application asked for/);
  });

  it("honours a stop between steps without interrupting a dispatched call", async () => {
    let dispatched = 0;
    const run = await runAgentTask("go", {
      discoverTools: async () => [SEARCH],
      plan: async () => callTool("search_opportunities", { search_this_list: "Acme" }),
      invoke: async () => {
        dispatched += 1;
        return envelope({ ...oneCandidate, candidates: [] });
      },
      shouldStop: () => dispatched >= 1,
      now: () => 0
    });
    expect(dispatched).toBe(1);
    expect(run.stopReason).toBe("stopped");
  });
});

/* ------------------------ ambiguity and safety ------------------------ */

describe("a search that found several records stops the run", () => {
  const three = {
    status: "succeeded",
    candidates: [
      { id: "006A", name: "Acme Industrial — Renewal", entityType: "Opportunity" },
      { id: "006B", name: "Acme Industrial — Expansion", entityType: "Opportunity" },
      { id: "006C", name: "Acme Industrial — Pilot", entityType: "Opportunity" }
    ],
    evidence: [],
    warnings: [],
    executedAt: "2026-09-03T00:00:00.000Z"
  };

  it("asks rather than choosing, and never plans a write", async () => {
    const plan = vi.fn(async () => callTool("search_opportunities", { search_this_list: "Acme" }));
    const run = await runAgentTask("move the Acme opportunity", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan,
      invoke: async () => envelope(three),
      now: () => 0
    });

    expect(run.stopReason).toBe("needs_clarification");
    expect(run.clarification?.candidates.map((candidate) => candidate.id)).toEqual(["006A", "006B", "006C"]);
    // The model is never asked what to do about it: the choice has an owner.
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("keeps the count even when more candidates arrived than it lists", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      id: `006${index}`,
      name: `Acme ${index}`,
      entityType: "Opportunity"
    }));
    const observation = observeToolResult(envelope({ ...three, candidates: many }));
    expect(observation).toMatchObject({ kind: "search", candidateCount: 25 });
    expect(observation.kind === "search" && observation.candidates).toHaveLength(10);
  });

  it("carries the run forward on the identity a person picked, without searching again", async () => {
    // A clarification nobody can answer is a dead end, not a safety
    // property. The resolution is a HUMAN choice: the search is not re-run,
    // the step is not re-planned, and the only thing that changed is that
    // the ambiguity now has an answer.
    const invoked: string[] = [];
    const stopped = await runAgentTask("move the Acme opportunity to Collaborate on 2026-10-15", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: async () => callTool("search_opportunities", { search_this_list: "Acme" }),
      invoke: async (tool) => {
        invoked.push(tool);
        return envelope(three);
      },
      now: () => 0
    });
    expect(stopped.stopReason).toBe("needs_clarification");
    expect(stopped.clarification?.step).toBe(1);
    expect(invoked).toEqual(["search_opportunities"]);

    const resumed = await runAgentTask(
      stopped.instruction,
      {
        discoverTools: async () => [SEARCH, UPDATE],
        plan: async (request) => {
          const search = request.history[0].observation;
          if (request.history.length === 1 && search.kind === "search") {
            return callTool("update_opportunity", {
              opportunity_id: search.candidates[0].id,
              stage: "Collaborate",
              close_date: "2026-10-15"
            });
          }
          return finish("updated the record you chose");
        },
        invoke: async (tool) => {
          invoked.push(tool);
          return envelope(savedAndVerified);
        },
        now: () => 0
      },
      { steps: stopped.steps, choice: { step: 1, candidateId: "006B" } }
    );

    // The search was performed once, in the original run.
    expect(invoked).toEqual(["search_opportunities", "update_opportunity"]);
    expect(resumed.steps.map((step) => step.tool)).toEqual(["search_opportunities", "update_opportunity"]);
    expect(resumed.steps[1].arguments.opportunity_id).toBe("006B");
    expect(resumed.stopReason).toBe("finished");

    // And the narrowing is recorded, not hidden: the model was shown one
    // candidate where the application offered three, and the reason it may
    // act on it is that a person chose.
    const search = resumed.steps[0].observation;
    expect(search.kind === "search" && search.chosenByUser).toBe(true);
    expect(search.kind === "search" && search.candidates).toEqual([
      { id: "006B", name: "Acme Industrial — Expansion", entityType: "Opportunity" }
    ]);
  });

  it("refuses to resume on a choice the application never offered", async () => {
    // The identity a write acts on may only ever come from the
    // application's own answer. An id that was not among the candidates
    // resolves nothing, so the run must stop on the same ambiguity rather
    // than let a write through by way of the resume path.
    const stopped = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: async () => callTool("search_opportunities", { search_this_list: "Acme" }),
      invoke: async () => envelope(three),
      now: () => 0
    });

    const plan = vi.fn(async () => finish("should not be reached"));
    const invoke = vi.fn(async () => envelope(savedAndVerified));
    const resumed = await runAgentTask(
      stopped.instruction,
      { discoverTools: async () => [SEARCH, UPDATE], plan, invoke, now: () => 0 },
      { steps: stopped.steps, choice: { step: 1, candidateId: "006-invented" } }
    );

    expect(resumed.stopReason).toBe("needs_clarification");
    expect(resumed.clarification?.candidates).toHaveLength(3);
    expect(plan).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses to resume on a choice aimed at the wrong step", async () => {
    const stopped = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: async () => callTool("search_opportunities", { search_this_list: "Acme" }),
      invoke: async () => envelope(three),
      now: () => 0
    });

    const plan = vi.fn(async () => finish("should not be reached"));
    const resumed = await runAgentTask(
      stopped.instruction,
      { discoverTools: async () => [SEARCH, UPDATE], plan, invoke: async () => "", now: () => 0 },
      { steps: stopped.steps, choice: { step: 7, candidateId: "006B" } }
    );

    expect(resumed.stopReason).toBe("needs_clarification");
    expect(plan).not.toHaveBeenCalled();
  });

  it("lets a single exact candidate feed the write", () => {
    expect(loopControlFor(observeToolResult(envelope(oneCandidate)))).toEqual({ continue: true });
  });
});

describe("a write outcome is read on the runtime's terms, never the model's", () => {
  it("stops on an unknown outcome and never asks for a retry", async () => {
    const lost = {
      status: "unknown",
      dispatch: { invocationId: "inv-1", mayHavePersisted: true },
      checks: [],
      evidence: ["Invocation inv-1 was dispatched and produced no result."],
      warnings: ["The execution was dispatched, so whether it changed anything is not established."],
      executedAt: "2026-09-03T00:00:00.000Z"
    };
    const plan = vi.fn(async () =>
      callTool("update_opportunity", { opportunity_id: "006A", stage: "Collaborate", close_date: "2026-10-15" })
    );
    const run = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan,
      invoke: async () => envelope(lost),
      now: () => 0
    });

    expect(run.stopReason).toBe("unknown_outcome");
    expect(run.detail).toBe(
      "Execution outcome is unknown. The write may have persisted. Manual reconciliation is required before retry."
    );
    expect(plan).toHaveBeenCalledTimes(1);
    expect(run.steps).toHaveLength(1);
  });

  it("treats a navigation-only block as a step forward, not a failure", async () => {
    // The runtime established all three facts itself: nothing was written,
    // the requested record was opened, and invoking again is safe.
    const opened = {
      status: "blocked",
      dispatch: { phase: "target-opening", mayHavePersisted: false, openRecordAt: "/lightning/r/006A/view" },
      checks: [{ name: "target_identity", status: "fail", detail: "no record is open" }],
      evidence: [],
      warnings: ["Execution stopped before touching anything. Nothing was written, so invoking again is safe."],
      executedAt: "2026-09-03T00:00:00.000Z"
    };
    const answers = [envelope(opened), envelope(savedAndVerified)];
    const run = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: async (request) =>
        request.history.length >= 2
          ? finish("the record was opened, then updated and verified")
          : callTool("update_opportunity", {
              opportunity_id: "006Ab00000XyZ",
              stage: "Collaborate",
              close_date: "2026-10-15"
            }),
      invoke: async () => answers.shift() ?? envelope(savedAndVerified),
      now: () => 0
    });

    expect(run.steps.map((step) => step.observation.kind)).toEqual(["write", "write"]);
    expect(run.stopReason).toBe("finished");
  });

  it("does not read a duplicate-invocation refusal as safe to invoke again", async () => {
    // The runtime's own refusal when an earlier write may have persisted.
    // It is `blocked` and it carries no route, so none of the three facts
    // the navigation case establishes is present here.
    const refused = {
      status: "blocked",
      dispatch: { invocationId: "inv-2", phase: "received", mayHavePersisted: false },
      checks: [],
      evidence: ['Outstanding invocation inv-1 reached "saving" and never reported its outcome.'],
      warnings: ["Running again now could repeat it. Read the record."],
      executedAt: "2026-09-03T00:00:00.000Z"
    };
    const plan = vi.fn(async () =>
      callTool("update_opportunity", { opportunity_id: "006A", stage: "Collaborate", close_date: "2026-10-15" })
    );
    const run = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan,
      invoke: async () => envelope(refused),
      now: () => 0
    });

    expect(run.stopReason).toBe("tool_failed");
    expect(run.detail).toMatch(/could repeat it/);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("offers the acknowledgement a refusal needs, rather than reporting a wall", async () => {
    // The runtime refuses when an earlier write of the same capability may
    // have persisted and never said so. That refusal is resolvable — by a
    // person reading the record — and a run that reported it as a failure
    // left an agent demo with no way forward but to go hunting for the
    // manual test form.
    const refused = {
      status: "blocked",
      dispatch: { invocationId: "inv-next", phase: "received", mayHavePersisted: false },
      checks: [],
      evidence: ['Outstanding invocation inv-lost started at 2026-09-03T22:19:40.387Z and last reported "verified".'],
      warnings: ["Running again now could repeat it. Read the record."],
      blockedBy: { invocationId: "inv-lost", startedAt: "2026-09-03T22:19:40.387Z", phase: "verified" },
      executedAt: "2026-09-03T00:00:00.000Z"
    };
    const plan = vi.fn(async () =>
      callTool("update_opportunity", { opportunity_id: "006A", stage: "Collaborate", close_date: "2026-10-15" })
    );
    const stopped = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan,
      invoke: async () => envelope(refused),
      now: () => 0
    });

    expect(stopped.stopReason).toBe("needs_acknowledgement");
    expect(stopped.acknowledgement).toEqual({
      step: 1,
      invocationId: "inv-lost",
      startedAt: "2026-09-03T22:19:40.387Z",
      phase: "verified"
    });
    // Never re-planned on its own: the refusal is answered by a person, not
    // by asking the model what it thinks.
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("re-attempts the refused step once a person has accounted for it", async () => {
    // The refusal wrote nothing, so the step is not history — it is dropped
    // and planned again. The acknowledgement itself reaches the runtime by
    // a page-side route a model has no access to.
    const refused = {
      status: "blocked",
      dispatch: { invocationId: "inv-next", phase: "received", mayHavePersisted: false },
      checks: [],
      evidence: [],
      warnings: ["Running again now could repeat it."],
      blockedBy: { invocationId: "inv-lost", startedAt: "2026-09-03T22:19:40.387Z", phase: "verified" },
      executedAt: "2026-09-03T00:00:00.000Z"
    };
    const answers = [envelope(refused), envelope(savedAndVerified)];
    const stopped = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: async () =>
        callTool("update_opportunity", { opportunity_id: "006A", stage: "Collaborate", close_date: "2026-10-15" }),
      invoke: async () => answers.shift() ?? envelope(savedAndVerified),
      now: () => 0
    });
    expect(stopped.steps).toHaveLength(1);

    const resumed = await runAgentTask(
      stopped.instruction,
      {
        discoverTools: async () => [SEARCH, UPDATE],
        plan: async (request) =>
          request.history.length === 0
            ? callTool("update_opportunity", {
                opportunity_id: "006A",
                stage: "Collaborate",
                close_date: "2026-10-15"
              })
            : finish("the record was updated and verified"),
        invoke: async () => answers.shift() ?? envelope(savedAndVerified),
        now: () => 0
      },
      { steps: stopped.steps, acknowledged: { step: 1 } }
    );

    // The refused attempt is gone; one write stands in its place.
    expect(resumed.steps.map((step) => step.observation.kind)).toEqual(["write"]);
    expect(resumed.steps[0].observation).toMatchObject({ status: "succeeded" });
    expect(resumed.stopReason).toBe("finished");
  });

  it("stops when the invocation itself never returned, without claiming an outcome", async () => {
    const run = await runAgentTask("move it", {
      discoverTools: async () => [SEARCH, UPDATE],
      plan: async () =>
        callTool("update_opportunity", { opportunity_id: "006A", stage: "Collaborate", close_date: "2026-10-15" }),
      invoke: async () => {
        throw new Error("The Teach Mode extension is not connected.");
      },
      now: () => 0
    });
    expect(run.steps[0].observation).toEqual({
      kind: "error",
      message: "The Teach Mode extension is not connected."
    });
    expect(run.stopReason).toBe("tool_failed");
  });

  it("preserves target identity and per-value verification in what the model is shown", () => {
    const observation = observeToolResult(envelope(savedAndVerified));
    expect(observation).toMatchObject({
      kind: "write",
      status: "succeeded",
      target: { status: "verified", requestedId: "006Ab00000XyZ", afterSaveId: "006Ab00000XyZ" },
      values: [{ name: "stage", requested: "Collaborate", verified: "yes", afterSave: "Collaborate" }]
    });
  });
});

/* -------------------- two applications, one surface -------------------- */

describe("independently taught applications can share one orchestration surface", () => {
  const capability = (id: string, application: string): SemanticCapability => ({
    id,
    name: id,
    description: "A taught capability.",
    inputs: [],
    outputs: [],
    binding: { application, action: id },
    provenance: {
      source: "confirmed",
      observationIds: [],
      confirmedByHuman: true,
      sourceApplication: { id: application, label: application }
    },
    safety: { readOnly: true, requiresConfirmation: false }
  });

  const salesforceSearch = {
    capability: capability("search_opportunities", "salesforce-lightning"),
    publishedAt: "2026-09-03T00:00:00.000Z",
    queryBinding: { entityType: "Opportunity" }
  } as unknown as PublicationRecord;

  const signalBaseContacts: PublicationRecord = {
    capability: capability("find_decision_maker_contacts", "prospect-intelligence"),
    publishedAt: "2026-09-03T00:00:00.000Z"
  };

  const taughtElsewhere: PublicationRecord = {
    capability: capability("approve_invoice", "some-other-erp"),
    publishedAt: "2026-09-03T00:00:00.000Z"
  };

  /** What a document that bundles SignalBase can perform in process. */
  const inProcess = (subject: SemanticCapability): string | undefined =>
    subject.binding?.application === "prospect-intelligence" ? subject.binding.action : undefined;

  it("registers a browser-bound capability and an opted-in in-process one side by side", () => {
    const forOrchestration: PublicationRecord = { ...signalBaseContacts, orchestration: true };
    expect(callableHere(salesforceSearch, inProcess)).toBe(true);
    expect(callableHere(forOrchestration, inProcess)).toBe(true);
    expect(
      registrableHere([salesforceSearch, forOrchestration, taughtElsewhere], inProcess).map(
        (record) => record.capability.id
      )
    ).toEqual(["search_opportunities", "find_decision_maker_contacts"]);
  });

  it("claims nothing for a capability taught somewhere this document cannot reach", () => {
    // Registered nowhere and claimed nowhere is the only honest answer.
    expect(callableHere(taughtElsewhere, inProcess)).toBe(false);
  });

  it("leaves a taught site's own capability to that site unless publication asked otherwise", () => {
    // The resting state, and it is a property of the PUBLICATION rather
    // than of the page reading it: a capability taught from SignalBase
    // belongs on SignalBase, which registers and performs it, and a second
    // copy on the control document would make the Studio look like it
    // hosts other sites' tools. Someone has to ask for that, once, when
    // they publish.
    expect(callableHere(signalBaseContacts, inProcess)).toBe(false);
    expect(
      registrableHere([salesforceSearch, signalBaseContacts, taughtElsewhere], inProcess).map(
        (record) => record.capability.id
      )
    ).toEqual(["search_opportunities"]);
  });

  it("registers a taught site's capability here when publication asked for it", () => {
    const forOrchestration: PublicationRecord = { ...signalBaseContacts, orchestration: true };
    expect(callableHere(forOrchestration, inProcess)).toBe(true);
    expect(
      registrableHere([salesforceSearch, forOrchestration, taughtElsewhere], inProcess).map(
        (record) => record.capability.id
      )
    ).toEqual(["search_opportunities", "find_decision_maker_contacts"]);
  });

  it("never lets the flag conjure a capability this document cannot perform", () => {
    // Asking for it is not the same as being able to do it. A capability
    // taught somewhere this bundle cannot reach stays unregistered however
    // it was published.
    expect(callableHere({ ...taughtElsewhere, orchestration: true }, inProcess)).toBe(false);
  });

  it("needs no flag where the Studio is the only possible host", () => {
    // Salesforce cannot expose `document.modelContext` for us, so what is
    // registered here is not a second copy — it is the only one, and there
    // is nothing to decide.
    expect(callableHere(salesforceSearch, () => undefined)).toBe(true);
  });

  it("runs a task across both without either tool knowing about the other", async () => {
    const invoked: string[] = [];
    const run = await runAgentTask(
      "find the VP of Finance at Acme Industrial, then move the Acme opportunity to Collaborate",
      {
        discoverTools: async () => [CONTACTS, SEARCH, UPDATE],
        plan: async (request) => {
          if (request.history.length === 0) {
            return callTool("find_decision_maker_contacts", {
              company_name_domain_or_industry: "Acme Industrial",
              function: "Finance",
              seniority: "VP"
            });
          }
          if (request.history.length === 1) return callTool("search_opportunities", { search_this_list: "Acme" });
          if (request.history.length === 2) {
            const search = request.history[1].observation;
            const id = search.kind === "search" ? search.candidates[0].id : "";
            return callTool("update_opportunity", {
              opportunity_id: id,
              stage: "Collaborate",
              close_date: "2026-10-15"
            });
          }
          return finish("Found the contact, identified the opportunity, and moved it to Collaborate.");
        },
        invoke: async (tool) => {
          invoked.push(tool);
          if (tool === "find_decision_maker_contacts") {
            return envelope({ company: "Acme Industrial", contacts: [{ name: "Jane Ruiz", title: "VP Finance" }] });
          }
          return tool === "search_opportunities" ? envelope(oneCandidate) : envelope(savedAndVerified);
        },
        now: () => 0
      }
    );

    expect(invoked).toEqual(["find_decision_maker_contacts", "search_opportunities", "update_opportunity"]);
    // SignalBase's answer is its own application's JSON, and survives as such.
    expect(run.steps[0].observation).toMatchObject({ kind: "data" });
    expect(run.stopReason).toBe("finished");
  });
});
