import { normalizeInputSchema } from "../webmcp/harness";
import type { JsonObjectSchema, RegisteredTool } from "../webmcp/types";

/* ------------------------------------------------------------------ *
 * The page-side agent harness: shared vocabulary.
 *
 * What this is: a small deterministic shell that hands a model the tools
 * `document.modelContext.getTools()` currently reports, asks it for ONE
 * next action, validates that action against those same tools, and invokes
 * it through `document.modelContext.executeTool`. Nothing here is a
 * planner, a workflow engine, or an MCP server, and it is not ChatGPT or
 * Codex — it is a caller, and it gets no privileges a caller does not have.
 *
 * The constraint that shapes every type below: the model may name a tool
 * and supply arguments, and may do nothing else. There is deliberately no
 * field anywhere in an action through which a selector, an XPath, a script
 * or a browser command could travel, because a field that existed would
 * eventually be filled.
 * ------------------------------------------------------------------ */

/**
 * One tool as the agent loop sees it — which is to say, as the browser
 * reported it.
 *
 * Built from `getTools()` and never from our own registry: what this
 * document passed to `registerTool` is evidence of registration, while
 * this is evidence of what an agent can actually call.
 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  /** The published contract, normalized from whichever shape the browser returns. */
  inputSchema?: JsonObjectSchema;
  /**
   * The tool's own read-only annotation, when this browser publishes
   * annotations through `getTools()` at all.
   *
   * `undefined` means "not stated here", never "not read-only". It is
   * offered to the model as evidence and nothing more: the runtime remains
   * the authority on what a tool is allowed to do, and an annotation has
   * never been permission.
   */
  readOnlyHint?: boolean;
}

/** Arguments as they may be sent: declared parameters holding primitives. */
export type AgentToolArguments = Record<string, string | number | boolean>;

/**
 * The two things the model is allowed to answer.
 *
 * A closed union on purpose. "Ask the user something", "write some code",
 * and "run these three tools" are all absent because each would be a new
 * privilege, and the loop's whole safety story is that a step is one
 * validated call to one published tool.
 */
export type AgentAction =
  | { action: "call_tool"; tool: string; arguments: AgentToolArguments }
  | { action: "finish"; summary: string };

/** What the control plane is asked for at each step. */
export interface AgentPlanRequest {
  instruction: string;
  tools: AgentToolDefinition[];
  history: AgentHistoryEntry[];
  /** Including this one. Zero means the loop is over and no call may be planned. */
  remainingSteps: number;
}

/** One prior step, as the model is shown it. */
export interface AgentHistoryEntry {
  step: number;
  tool: string;
  arguments: AgentToolArguments;
  observation: ToolObservation;
}

/* ---------------------------- observations ---------------------------- */

/**
 * What a tool returned, reduced to what the next planning step needs.
 *
 * Reduced, never summarized away. A live search result can carry a whole
 * page of Salesforce chrome, and feeding that back wastes the budget the
 * next decision needs — but the two things that must survive intact are
 * identity and ambiguity, because both are what the next step will be
 * judged against. A candidate without its id cannot be acted on, and a
 * count silently collapsed to one is how an agent writes to the wrong
 * record.
 */
export type ToolObservation =
  | {
      kind: "search";
      status: string;
      candidateCount: number;
      candidates: Array<{ id: string; name: string; entityType?: string; context?: Record<string, string> }>;
      warnings: string[];
      /** Where the search must be run, when the runtime said it could not run here. */
      openAt?: string;
      /**
       * Set when a person picked one of several candidates and the run
       * carried on from there.
       *
       * The narrowing is recorded rather than silently applied, because
       * the model is being shown one candidate where the application
       * offered more, and the reason it may act on it is that a human
       * chose — not that the search was ever unambiguous.
       */
      chosenByUser?: boolean;
    }
  | {
      kind: "write";
      status: string;
      /** Which record was actually acted on, observed rather than assumed. */
      target?: { status: string; requestedId?: string; afterSaveId?: string; entityType?: string; detail: string };
      /** Per input: what was asked for, and whether it was proven present afterwards. */
      values: Array<{ name: string; requested: string; verified: string; afterSave?: string }>;
      dispatch?: { phase?: string; mayHavePersisted: boolean; openRecordAt?: string };
      /**
       * The checks the runtime could not answer.
       *
       * `partially_verified` alongside three values all reading "verified
       * yes" says something was not established and never says what. These
       * are the what.
       */
      unestablished?: string[];
      /**
       * The checks that actively FAILED, with the reason each gave.
       *
       * The same argument as `unestablished`, for the status one step
       * worse. A run reporting `failed` while every value reads "verified
       * yes" and the identity reads "verified" is not merely terse, it
       * reads as a contradiction — the one check that failed is the only
       * thing that explains it, and it was the one thing not carried.
       */
      failedChecks?: Array<{ name: string; detail: string }>;
      /**
       * An EARLIER invocation the runtime refused to run past.
       *
       * Its own field because the remedy is specific and it is a person's
       * to give: someone reads the record, establishes what that
       * transaction did, and says so. Carried here so the trace can offer
       * that remedy instead of describing a wall.
       */
      blockedBy?: { invocationId: string; startedAt: string; phase?: string };
      warnings: string[];
    }
  /** A tool that answered with its application's own JSON, e.g. a contact record. */
  | { kind: "data"; value: unknown }
  /** A tool that answered with something no shape here fits. */
  | { kind: "text"; text: string; problem?: string }
  /** The invocation itself did not return — the tool was never given a chance to answer. */
  | { kind: "error"; message: string };

/* ------------------------------- the run ------------------------------- */

export interface AgentStep {
  /** 1-based, and the number shown in the trace. */
  index: number;
  tool: string;
  arguments: AgentToolArguments;
  observation: ToolObservation;
  /** Wall clock around the WebMCP call itself. */
  durationMs: number;
  /** The raw text the tool returned, kept so a trace can be read rather than trusted. */
  raw: string;
}

/**
 * Why the loop stopped. Every run has one, including the successful ones:
 * a loop that ends without saying why is indistinguishable from one that
 * silently gave up.
 */
export type AgentStopReason =
  /** The model said it was done. */
  | "finished"
  /** The step budget ran out with work still outstanding. */
  | "step_budget_exhausted"
  /** A search offered several records and nothing here may choose between them. */
  | "needs_clarification"
  /** A write was dispatched and never reported. Nothing may be retried. */
  | "unknown_outcome"
  /** A tool refused, failed, or could not be reached. */
  | "tool_failed"
  /** The model named a tool that is not published, or arguments its schema refuses. */
  | "invalid_action"
  /** The control plane could not be asked. */
  | "planner_failed"
  /** No tool is registered on this document, so there is nothing to compose. */
  | "no_tools"
  /** A person pressed Stop. */
  | "stopped"
  /** An earlier write never reported, and a person must account for it first. */
  | "needs_acknowledgement";

/** One action the loop refused to perform, kept rather than quietly retried. */
export interface AgentRejection {
  step: number;
  reason: string;
  /** Exactly what the model returned, so a refusal can be read rather than believed. */
  raw: string;
}

export interface AgentRun {
  instruction: string;
  status: "running" | "stopped";
  steps: AgentStep[];
  rejections: AgentRejection[];
  stopReason?: AgentStopReason;
  /** The model's own words, when it finished. */
  summary?: string;
  /** What a person must decide before this can go further. */
  clarification?: {
    /** Which step produced the ambiguity, so a choice can be applied to it. */
    step: number;
    question: string;
    candidates: Array<{ id: string; name: string; entityType?: string; context?: Record<string, string> }>;
  };
  /**
   * An outstanding write a person must account for before this can go on.
   *
   * Deliberately separate from `clarification`: choosing between records is
   * a question about intent, and this is a question about what already
   * happened to one. They stop the run for different reasons and are
   * resolved by different answers.
   */
  acknowledgement?: {
    /** Which step was refused, so the resume can be applied to it. */
    step: number;
    invocationId: string;
    startedAt: string;
    phase?: string;
  };
  /** Why the run stopped, in words a person can act on. */
  detail?: string;
  /** The tools the browser reported on the most recent step. */
  tools: AgentToolDefinition[];
  /**
   * The call that has been dispatched and has not answered yet.
   *
   * Deliberately NOT an `AgentStep`: a step is the record of something
   * that happened, and this is a thing that is happening. Collapsing the
   * two would mean a trace could show a call with no outcome and no way to
   * tell whether that is because it failed or because it is still going.
   *
   * It exists because a live Salesforce write took forty-one seconds, and
   * for all forty-one of them the trace showed nothing at all — the step
   * was only appended once its answer came back, so the page was
   * indistinguishable from one that had hung.
   */
  inFlight?: {
    index: number;
    tool: string;
    arguments: AgentToolArguments;
    /** When it was dispatched, so the wait can be counted up on screen. */
    startedAt: number;
  };
}

/**
 * Reads a browser's tool listing into the definitions the loop plans over.
 *
 * Structural about annotations on purpose. `getTools()` is the browser's
 * API, its return shape is a prototype's, and the WebMCP type in this
 * repository declares only the fields we already rely on — so the
 * annotation is looked for and reported absent when it is absent, rather
 * than assumed present and read as `false`.
 */
export function agentToolDefinitions(tools: readonly RegisteredTool[]): AgentToolDefinition[] {
  return tools.map((tool) => {
    const annotations = (tool as { annotations?: { readOnlyHint?: unknown } }).annotations;
    const readOnlyHint = annotations?.readOnlyHint;
    const schema = normalizeInputSchema(tool.inputSchema);
    return {
      name: tool.name,
      description: tool.description ?? "",
      ...(schema ? { inputSchema: schema } : {}),
      ...(typeof readOnlyHint === "boolean" ? { readOnlyHint } : {})
    };
  });
}
