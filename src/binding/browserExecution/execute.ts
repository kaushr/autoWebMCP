import {
  invokeSemanticAction,
  policyFor,
  readSemanticOptions,
  resolveSemanticTarget,
  setFieldValue,
  verifyOutcome,
  waitForApplicationReaction,
  type PlatformResolverAdapter,
  type ResolvedTarget
} from "./engine";
import type { BrowserBindingInput, BrowserExecutionBinding, SemanticTarget } from "./model";
import type { PageState } from "./pageState";
import type { ResolutionPolicy } from "./resolutionPolicy";
import type { ExecutionCheckResult, ExecutionOutcomeStatus, ExecutionResult } from "./result";

export type { ExecutionOutcomeStatus, ExecutionResult } from "./result";

/* ------------------------------------------------------------------ *
 * Execution orchestration.
 *
 * Ties the generic engine's primitives into one attempt: resolve every
 * target, set every value, commit, wait for the application, verify. This
 * is a write operation on the user's own authenticated session, so the only
 * entry point is `executeConfirmed` — there is deliberately no plain
 * `execute` that runs without an explicit, human-approved confirmation.
 * ------------------------------------------------------------------ */

export interface ExecuteOptions {
  root: ParentNode & Node;
  binding: BrowserExecutionBinding;
  /** Semantic input name → the value to write, e.g. `{ close_date: "2026-12-15" }`. */
  inputs: Record<string, string>;
  adapter?: PlatformResolverAdapter;
  /**
   * Deliberately not optional and deliberately typed `true`, not `boolean`:
   * a caller must write the literal confirmation, not thread a variable that
   * happens to be false through unnoticed. Enforced again at runtime below,
   * since this value may cross a message-passing boundary where the type
   * system cannot help.
   */
  confirmed: true;
  reaction?: { timeoutMs?: number; quietMs?: number };
  /** How long to keep retrying target resolution before giving up. Defaults to 8s; tests override it to stay fast. */
  resolveRetryMs?: number;
}

/**
 * Any check that could not honestly be answered ("skipped") keeps the
 * result out of `succeeded` without treating it as a failure the operator
 * did something wrong to cause — see docs/BINDING_VALIDATION.md on
 * `requires-setup` for the same principle applied to the supported-API
 * route. A real `fail` always wins; skips alone land on
 * `partially_verified`.
 */
function deriveStatus(checks: readonly ExecutionCheckResult[]): ExecutionOutcomeStatus {
  if (checks.some((check) => check.status === "fail")) return "failed";
  if (checks.some((check) => check.status === "skipped")) return "partially_verified";
  return "succeeded";
}

function now(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RESOLVE_RETRY_WINDOW_MS = 8_000;
const RESOLVE_RETRY_INTERVAL_MS = 300;

/**
 * Resolves every input target, retrying for a bounded window rather than
 * failing on the first miss. A real Lightning edit form does not finish
 * rendering the moment its container appears or the DOM briefly goes
 * quiet — the capture this binding was built from showed several seconds
 * of staggered network-driven rendering after the form opened, arriving in
 * bursts with pauses between them that a single "wait, then try once" check
 * can mistake for done. Retrying costs nothing when the target is already
 * there — the first pass always runs immediately — and only spends the
 * extra time when something is still catching up.
 */
async function resolveAllTargets(
  root: ParentNode,
  inputs: readonly BrowserBindingInput[],
  adapter: PlatformResolverAdapter | undefined,
  retryWindowMs: number
): Promise<
  | { ok: true; resolved: Array<{ input: BrowserBindingInput; target: ResolvedTarget }> }
  | { ok: false; reason: string; diagnostics: string[] }
> {
  const deadline = Date.now() + retryWindowMs;
  let lastReason = "";
  let lastDiagnostics: string[] = [];
  let attempts = 0;
  for (;;) {
    attempts++;
    const resolved: Array<{ input: BrowserBindingInput; target: ResolvedTarget }> = [];
    let failed: string | undefined;
    let failedDiagnostics: string[] = [];
    for (const input of inputs) {
      const outcome = resolveSemanticTarget(root, input.semanticTarget, adapter);
      if (!outcome.ok) {
        failed = `"${input.semanticInput}": ${outcome.reason}`;
        // Captured so a failure explains itself rather than needing another
        // live round-trip to diagnose: what was sought, how the page was
        // traversed, how many candidates that surfaced, and which identity
        // signals were actually able to narrow them.
        const diagnostics = outcome.diagnostics;
        failedDiagnostics = [
          `Target: ${input.semanticTarget.role} labelled "${input.semanticTarget.label}"` +
            (input.semanticTarget.applicationIdentifier
              ? `, application identifier "${input.semanticTarget.applicationIdentifier}"`
              : "") +
            (input.semanticTarget.section ? `, section "${input.semanticTarget.section}"` : ""),
          `Traversal: ${diagnostics?.traversal ?? policyFor(adapter).traversal}` +
            ` (shadow roots: ${policyFor(adapter).shadowRoots})`,
          `Candidates of that role discovered: ${diagnostics?.candidatesConsidered ?? "unknown"}`,
          `Identity signals that narrowed: ${
            diagnostics?.appliedSignals.length ? diagnostics.appliedSignals.join(", ") : "none"
          } (priority: ${policyFor(adapter).identityPriority.join(" → ")})`,
          `Resolution attempts: ${attempts}`
        ];
        break;
      }
      resolved.push({ input, target: outcome.target });
    }
    if (!failed) return { ok: true, resolved };
    lastReason = failed;
    lastDiagnostics = failedDiagnostics;
    if (Date.now() >= deadline) return { ok: false, reason: lastReason, diagnostics: lastDiagnostics };
    await sleep(RESOLVE_RETRY_INTERVAL_MS);
  }
}

/**
 * Performs one execution attempt of a browser execution binding against a
 * live DOM: resolve → set → commit → wait → verify. Refuses to run without
 * an explicit confirmation, and stops before writing anything the moment a
 * target cannot be resolved or a value cannot be set — a half-filled form
 * left mid-edit is worse than an honest refusal to start.
 */
/** How a temporary state change AutoWebMCP made was put back. */
export type RestorationStatus =
  /** Nothing to undo: we never made this transition. */
  | "not-required"
  /** Undone, and the resulting state was verified. */
  | "proven"
  /** Undone as far as we could, but the result could not be verified. */
  | "unproven"
  /** Could not be undone at all. */
  | "failed";

/** What one read-only inspection of the live page found, and what it changed to find it. */
export interface DomainInspection {
  /** Semantic input name → the values that control is currently offering. */
  options: Record<string, string[]>;
  /** Inputs whose domain could not be established, and why. */
  unresolved: Record<string, string>;
  initialPageState: PageState;
  finalPageState: PageState;
  /**
   * What THIS operation changed. Restoration is driven by ownership, never
   * by the final state: a record the user was already editing must not be
   * cancelled just because introspection happened to end in edit mode.
   */
  ownership: {
    enteredEditMode: boolean;
    openedControls: string[];
  };
  restoration: {
    control: RestorationStatus;
    page: RestorationStatus;
    /** Why page restoration was skipped or could not be proven. */
    reason?: string;
  };
  evidence: string[];
}

/**
 * The narrow view of a platform adapter that read-only introspection is
 * given.
 *
 * Deliberately a projection, not the whole adapter: `setFieldValue` is not
 * on it, so no code in this path can write a value even by mistake. The
 * binding's commit action is likewise never passed in — see
 * `inspectFieldDomains`, whose input has no commit field to reach for.
 */
export interface ReadOnlyIntrospector {
  id: string;
  resolutionPolicy?: PlatformResolverAdapter["resolutionPolicy"];
  assessPageState?: PlatformResolverAdapter["assessPageState"];
  ensureEditable?: PlatformResolverAdapter["ensureEditable"];
  restoreRecordView?: PlatformResolverAdapter["restoreRecordView"];
  readFieldOptions?: PlatformResolverAdapter["readFieldOptions"];
  resolveTarget?: PlatformResolverAdapter["resolveTarget"];
}

/** Projects a full adapter down to what a read-only operation may touch. */
export function readOnlyIntrospector(adapter?: PlatformResolverAdapter): ReadOnlyIntrospector | undefined {
  if (!adapter) return undefined;
  return {
    id: adapter.id,
    ...(adapter.resolutionPolicy ? { resolutionPolicy: adapter.resolutionPolicy } : {}),
    ...(adapter.assessPageState ? { assessPageState: adapter.assessPageState.bind(adapter) } : {}),
    ...(adapter.ensureEditable ? { ensureEditable: adapter.ensureEditable.bind(adapter) } : {}),
    ...(adapter.restoreRecordView ? { restoreRecordView: adapter.restoreRecordView.bind(adapter) } : {}),
    ...(adapter.readFieldOptions ? { readFieldOptions: adapter.readFieldOptions.bind(adapter) } : {}),
    ...(adapter.resolveTarget ? { resolveTarget: adapter.resolveTarget.bind(adapter) } : {})
  };
}

/** One closed-domain field to inspect. Carries no commit action, by construction. */
export interface InspectableField {
  name: string;
  target: SemanticTarget;
}

export interface InspectFieldsOptions {
  root: ParentNode & Node;
  fields: readonly InspectableField[];
  /** True when the platform's records have a separate edit state to enter. */
  mayEnterEditMode: boolean;
  introspector?: ReadOnlyIntrospector;
  reaction?: { timeoutMs?: number; quietMs?: number };
  /** How long restoration waits for the page to leave edit mode. Tests override it to stay fast. */
  restoreTimeoutMs?: number;
}

export interface InspectOptions {
  root: ParentNode & Node;
  binding: BrowserExecutionBinding;
  adapter?: PlatformResolverAdapter;
  reaction?: { timeoutMs?: number; quietMs?: number };
  restoreTimeoutMs?: number;
}

/**
 * Asks the live application which values its closed-domain controls
 * currently offer, and puts back whatever it had to disturb to find out.
 *
 * Three kinds of operation are worth telling apart, and this is the middle
 * one:
 *
 *   pure observation      reads the page, changes nothing
 *   READ-ONLY ACQUISITION changes transient UI to read something, then
 *                         restores what it changed
 *   business mutation     changes the record, and requires confirmation
 *
 * Being the middle kind is what makes the restoration contract part of the
 * operation rather than a cleanup afterthought: an inspection that opens a
 * record for editing and walks away has changed the user's application,
 * even though it saved nothing.
 *
 * Ownership decides what gets restored. If the record was already being
 * edited when we arrived, that edit session is the user's — we close only
 * the control we opened, and we never touch Cancel. If we entered edit
 * mode ourselves, we leave it again, and we prove we did.
 *
 * Nothing here can write: the introspector is a narrowed projection with
 * no `setFieldValue`, and the fields it receives carry no commit action.
 */
export async function inspectFieldDomains(options: InspectFieldsOptions): Promise<DomainInspection> {
  const { root, fields, introspector } = options;
  const policy = policyFor(introspector);
  const assess = (): PageState => introspector?.assessPageState?.(root, policy)?.state ?? "unknown";

  const result: DomainInspection = {
    options: {},
    unresolved: {},
    initialPageState: assess(),
    finalPageState: "unknown",
    ownership: { enteredEditMode: false, openedControls: [] },
    restoration: { control: "not-required", page: "not-required" },
    evidence: []
  };
  if (fields.length === 0) {
    result.finalPageState = result.initialPageState;
    return result;
  }
  result.evidence.push(`Initial page state: ${result.initialPageState}`);

  /* --- page state: enter edit only when we can own the transition ------- */
  if (result.initialPageState === "record-view" && options.mayEnterEditMode) {
    const transition = await introspector?.ensureEditable?.(root, policy);
    if (transition) {
      result.evidence.push(...transition.diagnostics);
      // Ownership is recorded from what we DID, not from where we ended up.
      result.ownership.enteredEditMode = transition.editActionInvoked && transition.finalState === "record-edit";
      if (!transition.ok) {
        const why = `the record's edit state could not be established (initial: ${transition.initialState}, final: ${transition.finalState})`;
        for (const field of fields) {
          result.unresolved[field.name] = `The live control could not be inspected because ${why}.`;
        }
        result.evidence.push(`Could not inspect the live controls: ${why}.`);
        return finish(result, assess, root, policy, introspector, options);
      }
      await waitForApplicationReaction({ root, ...options.reaction });
    }
  } else if (result.initialPageState === "unknown") {
    // Conservative by design: a transition made from an unknown baseline
    // cannot later be attributed, so we would not know whether restoring
    // it is our business. Read in place instead, and say so.
    result.evidence.push(
      "Page state could not be established, so no page-level transition was made. Controls were read in place."
    );
  } else if (result.initialPageState === "record-edit") {
    result.evidence.push("The record was already being edited; that session belongs to the user and is left open.");
  }

  /* --- the read itself, control state owned per field -------------------- */
  try {
    for (const field of fields) {
      const read = readSemanticOptions(root, field.target, introspector);
      if (read.openedByUs) result.ownership.openedControls.push(field.name);
      if (read.dismissAttempted && !read.dismissProven) {
        result.restoration.control = "unproven";
        result.evidence.push(`"${field.name}": the control could not be proven closed again.`);
      } else if (read.openedByUs && result.restoration.control === "not-required") {
        result.restoration.control = "proven";
      }

      if (read.options && read.options.length > 0) {
        result.options[field.name] = read.options;
        result.evidence.push(`"${field.name}" currently offers ${read.options.length} values: ${read.options.join(", ")}.`);
      } else {
        result.unresolved[field.name] = read.detail;
        result.evidence.push(`"${field.name}": ${read.detail}`);
      }
    }
  } catch (error) {
    // Restoration is part of the operation, so a failure mid-read does not
    // get to skip it.
    const detail = error instanceof Error ? error.message : String(error);
    for (const field of fields) {
      if (!result.options[field.name]) result.unresolved[field.name] ??= `Inspection failed: ${detail}`;
    }
    result.evidence.push(`Inspection failed: ${detail}`);
  }

  return finish(result, assess, root, policy, introspector, options);
}

/**
 * Undoes the page-level transition, when it was ours, and records the
 * outcome as part of the result.
 *
 * Never fire-and-forget: a discovery that cannot prove it put the
 * application back is not reported as a clean success, though its findings
 * are still returned — the options were genuinely read.
 */
async function finish(
  result: DomainInspection,
  assess: () => PageState,
  root: ParentNode & Node,
  policy: ResolutionPolicy,
  introspector: ReadOnlyIntrospector | undefined,
  options: InspectFieldsOptions
): Promise<DomainInspection> {
  if (!result.ownership.enteredEditMode) {
    result.restoration.page = "not-required";
    result.restoration.reason =
      result.initialPageState === "record-edit"
        ? "The record was already in edit mode before introspection, so its state was intentionally preserved."
        : "No page-level transition was made by AutoWebMCP.";
    result.finalPageState = assess();
    result.evidence.push(`Final page state: ${result.finalPageState}`);
    return result;
  }

  const restore = await introspector?.restoreRecordView?.(root, policy, options.restoreTimeoutMs);
  if (!restore) {
    result.restoration.page = "failed";
    result.restoration.reason = "This platform offers no way to leave edit mode, so the record was left as it was.";
  } else {
    result.evidence.push(...restore.diagnostics);
    result.restoration.page = restore.ok ? "proven" : restore.dismissActionInvoked ? "unproven" : "failed";
    if (!restore.ok) {
      result.restoration.reason = restore.dismissActionResolved
        ? "The dismiss action was invoked but the record was not observed returning to view mode."
        : "No dismiss action could be resolved, so the record could not be returned to view mode.";
    }
  }
  await waitForApplicationReaction({ root, ...options.reaction });
  result.finalPageState = assess();
  result.evidence.push(`Final page state: ${result.finalPageState}`);
  return result;
}

/**
 * The binding-shaped entry point. Projects the binding down to its
 * closed-domain fields and the adapter down to its read-only surface, so
 * the operation below never sees a commit action or a way to write.
 */
export function inspectValueDomains(options: InspectOptions): Promise<DomainInspection> {
  const fields: InspectableField[] = options.binding.inputs
    .filter((input) => input.valueKind === "select")
    .map((input) => ({ name: input.semanticInput, target: input.semanticTarget }));

  return inspectFieldDomains({
    root: options.root,
    fields,
    mayEnterEditMode: options.binding.context.pageMode === "edit-or-record",
    ...(readOnlyIntrospector(options.adapter) ? { introspector: readOnlyIntrospector(options.adapter) } : {}),
    ...(options.reaction ? { reaction: options.reaction } : {}),
    ...(options.restoreTimeoutMs !== undefined ? { restoreTimeoutMs: options.restoreTimeoutMs } : {})
  });
}

export async function executeConfirmed(options: ExecuteOptions): Promise<ExecutionResult> {
  if (options.confirmed !== true) {
    throw new Error("executeConfirmed refuses to run without an explicit confirmed: true.");
  }

  const { root, binding, inputs, adapter } = options;
  const checks: ExecutionCheckResult[] = [];
  const evidence: string[] = [];
  const warnings: string[] = [];

  /* --- ensure the page is in the state the binding expects --------------- *
   * A read-only "record" page and an editable "edit" page are different DOM
   * states, and a target captured mid-edit will not exist on the former.
   * Not a data write, so it runs under the confirmation already given for
   * this call rather than needing its own.
   */
  if (binding.context.pageMode === "edit-or-record") {
    const transition = await adapter?.ensureEditable?.(root, policyFor(adapter));
    if (transition && !transition.ok) {
      // The page never reached the state the binding's targets exist in.
      // Retrying field resolution against the wrong page state would spend
      // the whole retry window failing for a reason resolution cannot see —
      // this failure belongs to, and is reported at, the state layer.
      checks.push({
        name: "editable_state",
        status: "fail",
        detail: `The record edit state could not be established (initial: ${transition.initialState}, final: ${transition.finalState}).`
      });
      return {
        status: "blocked",
        checks,
        evidence: [...evidence, ...transition.diagnostics],
        warnings: ["Execution stopped before writing anything — the record edit state could not be established."],
        executedAt: now()
      };
    }
    if (transition) {
      checks.push({
        name: "editable_state",
        status: "pass",
        detail:
          transition.initialState === "record-edit"
            ? "The record was already in edit state."
            : "Entered and proved the record edit state before resolving targets."
      });
      evidence.push(...transition.diagnostics);
      if (transition.editActionInvoked) {
        // The edit surface appearing and its fields finishing rendering are
        // two different moments — the real capture this binding was built
        // from showed several seconds of application activity between them.
        const settled = await waitForApplicationReaction({ root, ...options.reaction });
        evidence.push(
          settled.settled
            ? `The edit view settled ${settled.elapsedMs}ms after opening.`
            : `The edit view did not settle within ${settled.elapsedMs}ms; resolving targets anyway.`
        );
      }
    }
  }

  /* --- A: resolve every target before writing anything --------------- */
  const resolution = await resolveAllTargets(
    root,
    binding.inputs,
    adapter,
    options.resolveRetryMs ?? RESOLVE_RETRY_WINDOW_MS
  );
  if (!resolution.ok) {
    checks.push({ name: "target_resolved", status: "fail", detail: resolution.reason });
    return {
      status: "blocked",
      checks,
      evidence: [...evidence, ...resolution.diagnostics],
      warnings: [`Execution stopped before writing anything — ${resolution.reason}`],
      executedAt: now()
    };
  }
  const resolved = resolution.resolved;
  checks.push({
    name: "target_resolved",
    status: "pass",
    detail: `All ${binding.inputs.length} input target(s) resolved on the live page.`
  });

  /* --- B: set every value ---------------------------------------------- */
  let allSet = true;
  for (const { input, target } of resolved) {
    const value = inputs[input.semanticInput];
    if (value === undefined) {
      allSet = false;
      warnings.push(`No value was supplied for "${input.semanticInput}".`);
      continue;
    }
    const result = await setFieldValue(target, value, input.valueKind, adapter);
    if (!result.ok) allSet = false;
    evidence.push(`${input.semanticInput}: ${result.detail}`);
  }
  checks.push({
    name: "value_set",
    status: allSet ? "pass" : "fail",
    detail: allSet ? "Every input value was set." : "One or more input values could not be set."
  });
  if (!allSet) {
    return {
      status: "blocked",
      checks,
      evidence,
      warnings: [...warnings, "Execution stopped before committing — not every value could be set."],
      executedAt: now()
    };
  }

  /* --- C: commit --------------------------------------------------------- */
  const commit = await invokeSemanticAction(root, binding.commit.semanticAction, adapter);
  checks.push({ name: "commit_invoked", status: commit.ok ? "pass" : "fail", detail: commit.detail });
  if (!commit.ok) {
    return { status: "failed", checks, evidence, warnings, executedAt: now() };
  }
  evidence.push(commit.detail);

  /* --- D: wait for the application's asynchronous reaction --------------- */
  const reaction = await waitForApplicationReaction({ root, ...options.reaction });
  evidence.push(
    reaction.settled
      ? `The page settled ${reaction.elapsedMs}ms after committing.`
      : `The page did not settle within ${reaction.elapsedMs}ms; verification proceeded anyway.`
  );

  /* --- E: verify ----------------------------------------------------------- */
  const verification = verifyOutcome({
    root,
    checks: binding.verification,
    inputs: resolved.map(({ input }) => ({
      target: input.semanticTarget,
      expectedValue: inputs[input.semanticInput] ?? ""
    })),
    adapter
  });
  checks.push(...verification);

  return { status: deriveStatus(checks), checks, evidence, warnings, executedAt: now() };
}
