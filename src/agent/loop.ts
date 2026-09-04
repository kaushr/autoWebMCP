import { decideAction } from "./action";
import { loopControlFor, observeToolResult } from "./observation";
import type { AgentPlanRequest, AgentRun, AgentStep, AgentToolDefinition, ToolObservation } from "./model";

/* ------------------------------------------------------------------ *
 * The page-side agent loop.
 *
 *   instruction
 *      ↓
 *   document.modelContext.getTools()          ← the live surface, every step
 *      ↓
 *   model chooses one tool + arguments        ← control plane, structured
 *      ↓
 *   validated against that same tool list
 *      ↓
 *   document.modelContext.executeTool(...)    ← the only way anything runs
 *      ↓
 *   real result, reduced but not flattened
 *      ↓
 *   next step, or a stop with a reason
 *
 * Everything the loop touches arrives through `ports`, which is what makes
 * it testable without a browser AND what keeps it honest: there is no
 * other entry point to execution in here, so the loop cannot accidentally
 * acquire a privilege by calling something directly. It never reaches for
 * an execution engine, a binding, or a capability's own callback — if it
 * did, the demonstration would be our code calling our code, and would
 * prove nothing about the surface an agent actually sees.
 *
 * Deliberately not: a planner, a DAG, a retry policy, or memory. One
 * action at a time, a hard step budget, and a stop reason for every ending.
 * ------------------------------------------------------------------ */

/** The hard ceiling on tool calls in one run. Three is enough for the cross-application task. */
export const DEFAULT_MAX_STEPS = 5;

export interface AgentPorts {
  /** What the browser reports right now. Asked again on every step, never cached. */
  discoverTools: () => Promise<AgentToolDefinition[]>;
  /** Asks the control plane's model for the next action. Returns its raw structured answer. */
  plan: (request: AgentPlanRequest) => Promise<unknown>;
  /** Invokes a tool through WebMCP and returns the raw text it answered with. */
  invoke: (toolName: string, argumentsJson: string) => Promise<string>;
  /** Called with a snapshot after every observable change, so a trace can render as it happens. */
  onProgress?: (run: AgentRun) => void;
  /** Polled between steps. A person pressing Stop never interrupts a dispatched call. */
  shouldStop?: () => boolean;
  now?: () => number;
  maxSteps?: number;
}

/**
 * Carrying a stopped run forward once a person has answered it.
 *
 * The only thing that resumes a run is a HUMAN choice. There is no
 * automatic continuation, no re-planning of the step that stopped, and no
 * second attempt at the search — the ambiguity is resolved by someone
 * saying which record they meant, and the run picks up from there with
 * that answer in hand.
 */
export interface AgentResumption {
  /** The steps already performed, exactly as the stopped run recorded them. */
  steps: AgentStep[];
  /** Which step was ambiguous, and the identity a person chose to resolve it. */
  choice?: { step: number; candidateId: string };
  /**
   * A step the runtime refused, which a person has now accounted for.
   *
   * Different from a choice in what it does to the run. A choice narrows a
   * result that stands; this drops a step that never happened — the
   * refusal wrote nothing — so the step is planned and attempted again.
   * The acknowledgement itself does not travel through here: it is a fact
   * about a record that a human established, and it reaches the runtime by
   * the same page-side route the Studio's own test uses.
   */
  acknowledged?: { step: number };
}

export async function runAgentTask(
  instruction: string,
  ports: AgentPorts,
  resume?: AgentResumption
): Promise<AgentRun> {
  const maxSteps = ports.maxSteps ?? DEFAULT_MAX_STEPS;
  const now = ports.now ?? (() => Date.now());

  const run: AgentRun = {
    instruction,
    status: "running",
    steps: resume ? applyResumption(resume) : [],
    rejections: [],
    tools: []
  };
  const emit = (): void => ports.onProgress?.({ ...run, steps: [...run.steps], rejections: [...run.rejections] });
  const stop = (reason: AgentRun["stopReason"], detail?: string): AgentRun => {
    // Whatever ends the run, nothing is left showing as still running.
    delete run.inFlight;
    run.status = "stopped";
    run.stopReason = reason;
    if (detail) run.detail = detail;
    emit();
    return run;
  };

  if (!instruction.trim()) return stop("invalid_action", "No instruction was given.");

  // A resumed run has to earn its resumption. The steps handed back are the
  // ones that stopped it, so the last of them is re-judged against the same
  // rule that stopped it in the first place — a choice that resolved
  // nothing (an id the application never offered, or one aimed at the wrong
  // step) leaves the ambiguity exactly where it was, and carrying on
  // regardless would let a write past the gate by way of the resume path.
  const seeded = run.steps[run.steps.length - 1];
  if (seeded) {
    const control = loopControlFor(seeded.observation);
    if (!control.continue) {
      if (control.clarification) run.clarification = { ...control.clarification, step: seeded.index };
      if (control.acknowledgement) run.acknowledgement = { ...control.acknowledgement, step: seeded.index };
      return stop(control.reason, control.detail);
    }
  }
  emit();

  /**
   * A hard ceiling on calls, independent of the budget.
   *
   * The budget below deliberately does not charge for a retry the runtime
   * asked for, which means a page that kept asking could keep being
   * re-invoked. This bounds that: a run stops after twice its budget in
   * calls however few of them counted.
   */
  const callCeiling = maxSteps * 2;

  for (let index = run.steps.length + 1; ; index++) {
    const spent = run.steps.filter((step) => spentBudget(step.observation)).length;
    if (spent >= maxSteps) {
      return stop(
        "step_budget_exhausted",
        `The step budget of ${maxSteps} was reached before the task was reported finished. Nothing further was ` +
          "attempted."
      );
    }
    if (run.steps.length >= callCeiling) {
      return stop(
        "step_budget_exhausted",
        `${run.steps.length} calls were made without the task being reported finished, most of them retries the ` +
          "application asked for. Nothing further was attempted."
      );
    }
    if (ports.shouldStop?.()) return stop("stopped", "Stopped before the next step was planned.");

    // The live surface, asked again rather than remembered. A tool
    // published between steps becomes available; one unpublished becomes
    // uncallable — and a plan is only ever checked against what the
    // browser says is there now.
    let tools: AgentToolDefinition[];
    try {
      tools = await ports.discoverTools();
    } catch (error) {
      return stop("no_tools", `The browser's tool list could not be read: ${messageOf(error)}`);
    }
    run.tools = tools;
    emit();

    if (tools.length === 0) {
      return stop("no_tools", "No WebMCP tool is registered on this document, so there is nothing to compose.");
    }

    const request: AgentPlanRequest = {
      instruction,
      tools,
      history: run.steps.map((step) => ({
        step: step.index,
        tool: step.tool,
        arguments: step.arguments,
        observation: step.observation
      })),
      remainingSteps: maxSteps - spent
    };

    let raw: unknown;
    try {
      raw = await ports.plan(request);
    } catch (error) {
      return stop("planner_failed", `The next action could not be planned: ${messageOf(error)}`);
    }

    const decision = decideAction(raw, tools);
    if (!decision.ok) {
      // Refused, not re-asked. Asking again with the error attached would
      // be a retry, and a shell with retries is a shell that can loop.
      run.rejections.push({ step: index, reason: decision.reason, raw: JSON.stringify(raw) });
      return stop("invalid_action", decision.reason);
    }

    if (decision.action.action === "finish") {
      run.summary = decision.action.summary;
      return stop("finished");
    }

    if (ports.shouldStop?.()) return stop("stopped", "Stopped before the next tool was invoked.");

    const { tool, arguments: args } = decision.action;
    const startedAt = now();
    // Published BEFORE the call is made. A write against a live application
    // can take the better part of a minute, and a trace that only grows
    // once an answer arrives cannot be told apart from one that has stopped.
    run.inFlight = { index, tool, arguments: args, startedAt };
    emit();

    let step: AgentStep;
    try {
      const text = await ports.invoke(tool, JSON.stringify(args));
      step = {
        index,
        tool,
        arguments: args,
        observation: observeToolResult(text),
        durationMs: now() - startedAt,
        raw: text
      };
    } catch (error) {
      // The invocation itself did not return. Recorded as a step so the
      // trace shows what was attempted, and never as an application
      // outcome — nothing here knows whether the tool ran.
      step = {
        index,
        tool,
        arguments: args,
        observation: { kind: "error", message: messageOf(error) },
        durationMs: now() - startedAt,
        raw: ""
      };
    }
    delete run.inFlight;
    run.steps.push(step);
    emit();

    const control = loopControlFor(step.observation);
    if (!control.continue) {
      if (control.clarification) run.clarification = { ...control.clarification, step: step.index };
      if (control.acknowledgement) run.acknowledgement = { ...control.acknowledgement, step: step.index };
      return stop(control.reason, control.detail);
    }
  }

}

/**
 * Whether a call counted against the budget.
 *
 * A blocked call that the loop nonetheless continued past is the runtime
 * asking to be invoked again: it opened the record, or the list page, and
 * wrote and searched nothing. Charging that to the budget is charging for
 * a redirect — and it is exactly what ended a successful live run one call
 * short of the model being able to say it had finished, with two of its
 * five steps spent on pages being opened.
 *
 * Safe because a blocked call only ever reaches this function after
 * `loopControlFor` allowed the run to continue, and it allows that only on
 * the runtime's own evidence that nothing was touched.
 */
function spentBudget(observation: ToolObservation): boolean {
  if (observation.kind === "write" || observation.kind === "search") return observation.status !== "blocked";
  return true;
}

/**
 * Applies whatever a person answered to the run that stopped to ask.
 *
 * The ambiguous search's own result is narrowed to the one record they
 * picked, and marked as narrowed. Nothing is re-run and nothing is
 * re-planned: the search already happened and returned what it returned,
 * and this records the only thing that changed, which is that a human
 * answered the question the run stopped to ask.
 *
 * A choice naming a candidate the step never offered is ignored rather
 * than trusted — the identity a write acts on may only ever come from the
 * application's own answer.
 */
function applyResumption(resume: AgentResumption): AgentStep[] {
  const acknowledged = resume.acknowledged;
  // A refused step is not history: the runtime declined before touching
  // anything, so there is nothing to keep and the step is planned again.
  const steps = acknowledged ? resume.steps.filter((step) => step.index !== acknowledged.step) : resume.steps;

  const choice = resume.choice;
  if (!choice) return steps;

  return steps.map((step) => {
    if (step.index !== choice.step || step.observation.kind !== "search") return step;
    const chosen = step.observation.candidates.find((candidate) => candidate.id === choice.candidateId);
    if (!chosen) return step;
    return {
      ...step,
      observation: { ...step.observation, candidateCount: 1, candidates: [chosen], chosenByUser: true }
    };
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
