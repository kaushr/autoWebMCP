import "./styles.css";
import { confirmCandidate, semanticizeTrace, type SemanticizerRun } from "./training/semanticizer";
import { localRegistryBindingProvider, resolveAdvertisedBinding } from "./training/bindingProvider";
import { sourceApplicationFor } from "./training/sourceApplication";
import {
  inferBindingCandidate,
  resetControlPlane,
  type BindingCandidateRecord,
  type BindingInferenceRun
} from "./training/bindingInference";
import { observedRecordType, resolveFieldMapping } from "./binding/fieldMapping";
import { defaultValidators } from "./binding/validators";
import { runBindingValidation, type BindingValidationRecord } from "./binding/validation";
import {
  buildDebugBundle,
  debugBundleFilename,
  serializeDebugBundle,
  type DebugBundle
} from "./training/debugBundle";
import { deriveStudioLifecycle, type StudioLifecycleView } from "./training/studioLifecycle";
import {
  getTrace,
  listTraces,
  summaryDurationMs,
  updateTraceRecording,
  withRecordingMetadata,
  type TraceSummary
} from "./training/traces";
import {
  buildTestFormFields,
  summarizeExecutionPlan,
  validateTestInputs,
  type TestFormField
} from "./training/executionTestForm";
import type { ObservationTrace } from "./capture/normalize";
import type { CaptureEvent, CapturePlatform } from "./capture/types";
import {
  listPublishedCapabilities,
  publishCapability,
  unpublishAll,
  withResolvedValueDomains,
  type PublicationRecord
} from "./webmcp/publication";
import { registerHelloControl } from "./webmcp/hello";
import {
  collectInvocationArguments,
  describeWebMcpSurface,
  harnessFieldsFor,
  normalizeInputSchema,
  readToolResult,
  verdictFor,
  type HarnessField,
  type HarnessInvocationOutcome
} from "./webmcp/harness";
import type { RegisteredTool } from "./webmcp/types";
import { startRrwebCaptureProbe } from "./capture/rrwebProbe";
import type { CapabilityInputValues, SemanticCapability } from "./semantic/model";
import { proposeBrowserBinding } from "./binding/browserExecution/propose";
import { applicationIntelligenceForPlatform } from "./binding/browserExecution/adapters";
import type { InputCanonicalization } from "./training/canonicalInputs";
import { describeWithdrawnConfirmation, groundCapability } from "./training/semanticGrounding";
import { proposeQueryBinding, type QueryProposal } from "./binding/browserExecution/proposeQuery";
import { entityIdentityPolicyForPlatform } from "./binding/browserExecution/adapters";
import type { QueryOutcome } from "./binding/browserExecution/query";
import { emptyTenantIntelligence, tenantIntelligenceFrom } from "./applicationIntelligence/tenant";
import { mergeTenantSnapshots, type TenantFactConflict } from "./applicationIntelligence/observedTenant";
import { observedTenantFromBinding } from "./training/tenantObservations";
import type { DomainInspection } from "./binding/browserExecution/execute";
import type { ExecutionResult } from "./binding/browserExecution/result";
import { assessExecutionReadiness } from "./training/executionReadiness";
import { planValueDomainAcquisition, type ValueDomainSource } from "./training/valueDomainResolution";
import {
  beginOperation,
  failed,
  isCurrent,
  isWorking,
  succeeded,
  type OperationKind,
  type OperationRegistry,
  type OperationState
} from "./training/operationState";
import type {
  EpistemicNeed,
  FieldClarification,
  TenantIntelligenceSnapshot,
  TenantIntelligenceSource
} from "./applicationIntelligence/model";

/**
 * What this installation knows about the customer's own org.
 *
 * Empty by default and deliberately so: no supported Salesforce metadata
 * path is installed, and inventing org configuration would be worse than
 * admitting we do not have it. An operator (or a future org service) sets
 * a real snapshot here; everything downstream already reads through the
 * same seam, so nothing else changes when one arrives.
 */
let tenantIntelligence: TenantIntelligenceSource = emptyTenantIntelligence();
/**
 * The tenant snapshot currently installed, kept alongside the source so a
 * later observation can be merged into it rather than replacing it.
 * Undefined means nothing is known about this org yet, which is the honest
 * starting state of every session.
 */
let installedTenantSnapshot: TenantIntelligenceSnapshot | undefined;
/** Disagreements between installed metadata and what the application showed. Surfaced, never resolved silently. */
let tenantConflicts: TenantFactConflict[] = [];

/**
 * Facts a human supplied when neither tenant nor standard knowledge could
 * name a field. Kept for this capability only and never promoted into
 * application knowledge: a person telling us what their org calls a field
 * is not the vendor documenting it.
 */
let fieldClarifications: FieldClarification[] = [];

/**
 * The pre-confirmation semantic grounding pass.
 *
 * `groundingNeeds` are questions whose answers can still change the
 * agent-facing contract, so they are asked while the contract is still
 * open. `groundingRenames` record where a canonical name replaced the
 * label a human demonstrated, because they are about to confirm a contract
 * whose parameter names differ from what they saw on screen.
 * `groundingNoncanonical` are inputs whose names remain this org's
 * vocabulary — usable, and honestly less portable than a grounded one.
 */
let groundingNeeds: EpistemicNeed[] = [];
let groundingRenames: InputCanonicalization[] = [];
let groundingNoncanonical: string[] = [];
/** Inputs nothing could ground. Different from noncanonical: these cannot execute at all. */
let groundingUnresolved: string[] = [];

/* ------------------------- entity search ------------------------- *
 * A read-only capability's own lifecycle, kept beside the mutation
 * one rather than folded into it: a search has no commit to invoke, no
 * record to verify, and returns candidates instead of a changed record.
 * ----------------------------------------------------------------- */
let queryProposal: QueryProposal | undefined;
let queryOutcome: QueryOutcome | undefined;
let queryAccepted = false;
let queryTerm = "";
let queryStatus = "";

/**
 * Value domains read from the live application, keyed by capability input.
 *
 * The most accurate source there is for what a control will currently
 * accept — record type, dependent picklists, and permissions all narrow it
 * in ways no stored snapshot knows — so these outrank any materialized
 * domain on the binding.
 */
let liveValueDomains: Record<string, string[]> = {};
let liveDomainProblems: Record<string, string> = {};
/** Drives the prominent warning: a state we changed and could not prove we put back. */
let liveDomainRestorationFailed = false;
/** Where each acquired domain came from. Kept for provenance even though acquisition is invisible. */
let liveDomainSources: Record<string, ValueDomainSource> = {};
/** The full decision trail, for Admin / Debug. */
let domainAcquisitionTrail: string[] = [];
/**
 * Which binding has already had its domains acquired.
 *
 * Acquisition starts from rendering, so without this every re-render would
 * re-open the application.
 */
let domainAcquisitionFor: string | undefined;

/** One slot per async action, so every click is visibly acknowledged. */
let operations: OperationRegistry = {};

/**
 * Runs one async Studio action with a visible busy state.
 *
 * The guard matters as much as the spinner: a slow response that arrives
 * after the user has clicked again, or moved to another trace, must not
 * overwrite what they are looking at now.
 */
async function runOperation(
  kind: OperationKind,
  workingMessage: string,
  work: (state: OperationState) => Promise<{ message: string; warning?: boolean }>
): Promise<void> {
  if (isWorking(operations, kind)) return; // duplicate click while working
  const state = beginOperation(kind, workingMessage);
  operations = { ...operations, [kind]: state };
  render();

  try {
    const outcome = await work(state);
    if (!isCurrent(operations, state)) return; // superseded; do not clobber newer state
    operations = { ...operations, [kind]: succeeded(state, outcome.message, outcome.warning) };
  } catch (error) {
    if (!isCurrent(operations, state)) return;
    operations = {
      ...operations,
      [kind]: failed(state, error instanceof Error ? error.message : String(error))
    };
  }
  render();
}

/**
 * Marks an action busy for the duration of its work.
 *
 * For handlers that already report their own progress in words: this adds
 * only the button state and the duplicate-click guard, so a click is
 * acknowledged immediately and cannot be fired twice.
 */
async function withBusy(kind: OperationKind, work: () => Promise<void>): Promise<void> {
  if (isWorking(operations, kind)) return;
  const state = beginOperation(kind, "");
  operations = { ...operations, [kind]: state };
  render();
  try {
    await work();
  } finally {
    if (isCurrent(operations, state)) {
      const next = { ...operations };
      delete next[kind];
      operations = next;
    }
    render();
  }
}

/**
 * Satisfies the "which values does this field accept" need automatically.
 *
 * Called from rendering rather than from a click: the need is one the
 * system identifies for itself, and asking the user to press a button to
 * start it made them the orchestrator of an acquisition they have no
 * special ability to perform. They are the escalation path, not the first
 * resort.
 *
 * Guarded twice: once against a second run for the same binding (rendering
 * happens constantly), and once against concurrency by the operation
 * registry.
 */
async function acquireValueDomains(): Promise<void> {
  const binding = browserBindingCandidate?.proposal.binding;
  if (!binding || !candidate) return;
  if (domainAcquisitionFor === binding.id || isWorking(operations, "acquire-domains")) return;

  const fields = buildTestFormFields(candidate, binding, liveValueDomains);
  const plan = planValueDomainAcquisition(fields, binding);
  domainAcquisitionTrail = plan.trail;
  if (plan.acquirable.length === 0) return;

  // Claim this binding before awaiting, so a re-render mid-flight cannot
  // start a second acquisition for the same need.
  domainAcquisitionFor = binding.id;
  const forCapability = candidate.id;

  await runOperation("acquire-domains", `Loading valid ${describeNeeds(plan.acquirable)} choices…`, async () => {
    const acquisition = await extensionBridgeExecutionClient.acquireDomains(binding);
    // The user may have moved to another trace while this was in flight.
    if (candidate?.id !== forCapability) return { message: "" };

    if (!acquisition.ok) {
      liveDomainProblems = {};
      liveDomainRestorationFailed = false;
      domainAcquisitionTrail = [...domainAcquisitionTrail, `Live application acquisition failed: ${acquisition.detail}`];
      throw new Error(acquisition.detail);
    }

    liveValueDomains = acquisition.inspection.options;
    liveDomainProblems = acquisition.inspection.unresolved;
    liveDomainSources = Object.fromEntries(
      Object.keys(acquisition.inspection.options).map((name) => [name, "live-application-state" as const])
    );

    // What the application just told us about this org is tenant knowledge,
    // so it is kept as tenant knowledge — dated, marked `observed-live`, and
    // available to every later resolution — instead of dying in the variable
    // above. Metadata, if any is ever installed, still governs identity and
    // type; a reading only governs the value domain it actually read.
    const observed = observedTenantFromBinding(binding, acquisition.inspection.options, new Date().toISOString());
    if (observed) {
      const merged = mergeTenantSnapshots(installedTenantSnapshot, observed);
      installedTenantSnapshot = merged.snapshot;
      tenantConflicts = merged.conflicts;
      useTenantIntelligence(tenantIntelligenceFrom(merged.snapshot));
      domainAcquisitionTrail = [
        ...domainAcquisitionTrail,
        `Tenant intelligence updated from the live application (${observed.objects[0]?.fields.length ?? 0} field(s), observed-live).`,
        ...merged.conflicts.map((conflict) => `Conflict: ${conflict.detail}`)
      ];
    }
    liveDomainRestorationFailed =
      acquisition.inspection.restoration.page === "unproven" ||
      acquisition.inspection.restoration.page === "failed" ||
      acquisition.inspection.restoration.control === "unproven";
    domainAcquisitionTrail = [...domainAcquisitionTrail, ...acquisition.inspection.evidence];

    // A disagreement between what this org's metadata says and what its
    // application just showed is worth a person's attention: it usually
    // means the metadata predates a change. It is never resolved silently.
    const conflictNote =
      tenantConflicts.length > 0
        ? ` ${tenantConflicts.length} tenant fact${tenantConflicts.length === 1 ? "" : "s"} disagreed with installed ` +
          `org metadata — see Admin / Debug. ${tenantConflicts.map((conflict) => conflict.detail).join(" ")}`
        : "";
    return {
      message: `${describeInspection(acquisition.inspection)}${conflictNote}`,
      ...(liveDomainRestorationFailed || tenantConflicts.length > 0 ? { warning: true } : {})
    };
  });
}

/** "Stage" / "Stage and Region", for the busy line. */
function describeNeeds(needs: readonly { label: string }[]): string {
  return needs.map((need) => need.label).join(" and ");
}

/** The busy/result line for one action, announced to assistive technology. */
function renderOperationStatus(kind: OperationKind, fallback = ""): string {
  const state = operations[kind];
  if (!state) return fallback ? `<p class="semanticizer-status">${escapeHtml(fallback)}</p>` : "";
  const working = state.status === "working";
  const tone = state.warning ? "ambiguity" : "semanticizer-status";
  return `<p class="${tone}${working ? " working" : ""}" role="status" aria-live="polite" aria-busy="${working}">
    ${working ? '<span class="spinner" aria-hidden="true"></span>' : ""}${escapeHtml(
      state.phase ? `${state.message} — ${state.phase}` : state.message
    )}
  </p>`;
}

/**
 * What the inspection did, in one line the user can act on.
 *
 * Restoration failure is deliberately not buried in Admin/Debug: if
 * AutoWebMCP opened the user's record for editing and cannot prove it
 * closed it again, the user's own application is in a state they did not
 * ask for and should look at.
 */
function describeInspection(inspection: DomainInspection): string {
  const found = Object.keys(inspection.options).length;
  const missing = Object.keys(inspection.unresolved).length;
  const total = Object.values(inspection.options).reduce((sum, values) => sum + values.length, 0);
  const read = found
    ? `✓ ${total} valid choice${total === 1 ? "" : "s"} found.` + (missing ? ` ${missing} field could not be read.` : "")
    : "No valid choices could be found. The values remain unknown.";

  if (inspection.restoration.control === "unproven") {
    return `${read} A control AutoWebMCP opened could not be proven closed — review the application tab before continuing.`;
  }
  switch (inspection.restoration.page) {
    case "proven":
      return `${read} The application was returned to its previous state.`;
    case "unproven":
    case "failed":
      return `${read} AutoWebMCP could not prove the application returned to its previous state. Review the application tab before continuing.`;
    default:
      return inspection.initialPageState === "record-edit"
        ? `${read} Your existing edit session was left open.`
        : read;
  }
}
let clarificationDraft: Record<string, string> = {};

export function useTenantIntelligence(source: TenantIntelligenceSource): void {
  tenantIntelligence = source;
}
import { acceptedBrowserBinding, type BrowserBindingCandidateRecord, type BrowserBindingValidationRecord } from "./binding/browserExecution/model";
import { extensionBridgeExecutionClient } from "./training/browserExecutionClient";
import { registerCapability } from "./webmcp/compiler";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root not found.");
const appRoot: HTMLDivElement = app;

const controlMode = new URLSearchParams(window.location.search).get("control") === "1";
const captureMode = new URLSearchParams(window.location.search).get("capture") === "1";
/**
 * The Studio publishes capabilities to the control plane; it never hosts them
 * as a taught application would. `?control=1` is its own local proof surface
 * instead: once a capability with an accepted browser execution binding is
 * published, this same document registers it as a real WebMCP tool, whose
 * `execute` calls through the extension bridge to the live tab — proving the
 * callable path (`semantic capability → accepted browser execution binding →
 * browser execution engine → live page`) without needing the taught
 * application's own origin to host `document.modelContext` itself.
 */
const registration = controlMode ? registerHelloControl() : document.modelContext ? "available" : "unavailable";
const browserExecutionRegistered = new Set<string>();

/* --------------------- judge-facing WebMCP harness --------------------- *
 * What this browser actually permits a page to do, established by asking
 * rather than assuming. Registration is page-side by definition; discovery
 * and invocation are separate permissions a browser could reasonably
 * withhold, and the panel is only allowed to claim what is present.
 * ---------------------------------------------------------------------- */
const webMcpSurface = describeWebMcpSurface(document.modelContext);
/** Tools as the browser reports them. Empty until `getTools()` answers. */
let discoveredTools: RegisteredTool[] = [];
let discoveryError = "";
let selectedToolName = "";
let harnessValues: Record<string, string> = {};
let harnessErrors: string[] = [];
let harnessOutcome: HarnessInvocationOutcome | undefined;
let harnessStatus = "";

/**
 * Asks the browser which tools an agent would see on this document.
 *
 * Deliberately the browser's answer and not our own registry: what this
 * page passed to `registerTool` is evidence that registration was
 * attempted, while `getTools()` is evidence that the tool actually exists
 * on the surface an agent reads. Only the second supports the claim the
 * panel is here to make.
 */
async function refreshDiscoveredTools(): Promise<void> {
  if (!webMcpSurface.canDiscover || !document.modelContext) return;
  try {
    discoveredTools = await document.modelContext.getTools();
    discoveryError = "";
    if (!discoveredTools.some((tool) => tool.name === selectedToolName)) {
      selectedToolName = discoveredTools.find((tool) => tool.name !== "hello_webmcp")?.name ?? "";
      harnessValues = {};
      harnessOutcome = undefined;
    }
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
  }
}

/** The tool the judge is testing, as the browser describes it. */
function selectedTool(): RegisteredTool | undefined {
  return discoveredTools.find((tool) => tool.name === selectedToolName);
}

function selectedToolFields(): HarnessField[] {
  return harnessFieldsFor(selectedTool()?.inputSchema);
}

/**
 * Invokes the selected tool THROUGH WebMCP.
 *
 * The whole value of this panel rests on this function calling
 * `executeTool` and nothing else. Calling the capability's own execute
 * callback here would exercise our code from our code and prove nothing
 * about the agent-facing surface, so there is deliberately no fallback
 * path: if the browser cannot invoke, the button is not offered and the
 * panel says why.
 */
async function invokeSelectedTool(): Promise<void> {
  const tool = selectedTool();
  if (!tool || !document.modelContext?.executeTool) return;

  const collected = collectInvocationArguments(selectedToolFields(), harnessValues);
  harnessErrors = collected.errors;
  harnessOutcome = undefined;
  if (!collected.ok) {
    harnessStatus = "";
    render();
    return;
  }

  await runOperation("invoke-webmcp", `Invoking ${tool.name} through WebMCP…`, async () => {
    // Both shapes are the browser's, established empirically: the
    // RegisteredTool object itself, and the arguments JSON-encoded.
    const result = await document.modelContext!.executeTool(tool, JSON.stringify(collected.args));
    harnessOutcome = readToolResult(result, "webmcp");
    return { message: describeOutcome(harnessOutcome) };
  });
}

function describeOutcome(outcome: HarnessInvocationOutcome): string {
  if (outcome.query) {
    const found = outcome.query.candidates.length;
    return found === 0
      ? "The search ran and found nothing."
      : `The search found ${found} candidate${found === 1 ? "" : "s"} — choose one by its identity.`;
  }
  if (!outcome.execution) return outcome.unparsed ?? "The tool returned a response.";
  switch (outcome.execution.status) {
    case "succeeded":
      return "The tool ran, the application saved, and every check passed.";
    case "partially_verified":
      return "The tool ran and saved, but not every check could be answered.";
    case "blocked":
      return "The tool stopped before writing anything.";
    default:
      return "The tool ran and did not complete successfully.";
  }
}

/** A WebMCP tool's inputs arrive untyped; the engine writes strings to the DOM regardless of a field's declared type. */
function invokeBrowserExecutionBinding(subject: SemanticCapability, inputs: CapabilityInputValues): Promise<unknown> {
  const record = publications.find((entry) => entry.capability.id === subject.id);

  // A search is a different operation, not a mutation with its commit
  // skipped: it writes nothing, needs no confirmation, and returns
  // candidates rather than a verified record. Routed accordingly.
  if (record?.queryBinding) {
    const terms: Record<string, string> = {};
    for (const [name, value] of Object.entries(inputs)) terms[name] = value === undefined ? "" : String(value);
    return extensionBridgeExecutionClient.query(record.queryBinding, terms);
  }

  const executionBinding = record?.executionBinding;
  if (!executionBinding) {
    throw new Error(`No accepted browser execution binding is published for "${subject.id}".`);
  }
  const stringInputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(inputs)) stringInputs[name] = value === undefined ? "" : String(value);
  // The agent path, and the reason the flag exists. An agent has opened
  // nothing and chosen nothing, so an execution it starts must name the
  // record it means. The Studio's own manual test deliberately does not set
  // this: there, a human chose the record by opening it.
  return extensionBridgeExecutionClient.execute(executionBinding, stringInputs, { requireTarget: true });
}

/** Registers any published capability this control-mode document has not already exposed. */
function syncBrowserExecutionRegistrations(): void {
  if (!controlMode) return;
  for (const record of publications) {
    // Either binding makes a capability callable. A search has a query
    // binding and no execution binding — requiring the latter published it
    // to the control plane and then never registered it, so it existed
    // everywhere except the surface an agent reads.
    const callable = record.executionBinding ?? record.queryBinding;
    if (!callable || browserExecutionRegistered.has(record.capability.id)) continue;
    if (registerCapability(record.capability, invokeBrowserExecutionBinding) === "registered") {
      browserExecutionRegistered.add(record.capability.id);
    }
  }
}

const stopCaptureProbe = captureMode ? startRrwebCaptureProbe((snapshot) => {
  const status = document.querySelector("#capture-probe-status");
  if (status) status.textContent = `rrweb probe active · ${snapshot.raw.total} masked raw events · ${snapshot.interactions.length} safe interactions`;
}) : undefined;
let candidate: SemanticCapability | undefined;
let ambiguities: string[] = [];
let semanticizerStatus = "Review the proposed contract, then confirm its meaning.";
let extensionTraces: TraceSummary[] = [];
let selectedTrace: ObservationTrace | undefined;
let traceStatus = "Record a session with the Teach Mode extension, then refresh.";
/** Every semanticizer invocation this session made, oldest first. Ephemeral. */
let semanticizerRuns: SemanticizerRun[] = [];
/** Traces loaded side by side for the comparison table. Ephemeral. */
let comparisonTraces: ObservationTrace[] = [];
let comparisonStatus = "Load the captures to compare what each workflow did.";
let exportStatus = "";
let bindingRuns: BindingInferenceRun[] = [];
let bindingCandidate: BindingCandidateRecord | undefined;
let bindingStatus = "";
let validationRuns: BindingValidationRecord[] = [];
let validation: BindingValidationRecord | undefined;
let validationStatus = "";
/**
 * The second execution strategy, kept in its own state precisely parallel
 * to `bindingCandidate`/`validation` above — the two routes never share a
 * variable, so one can be rejected while the other is accepted without
 * either overwriting the other's evidence.
 */
let browserBindingCandidate: BrowserBindingCandidateRecord | undefined;
let browserBindingStatus = "";
/** Raw values the browser-execution test form has collected so far. */
let browserTestValues: Record<string, string> = {};
let browserTestErrors: string[] = [];
let traceDetailsStatus = "";
let browserBindingValidation: BrowserBindingValidationRecord | undefined;
let browserValidationStatus = "";
let publications: PublicationRecord[] = [];
let publishStatus = "Nothing has been published yet.";
/**
 * Set only while the control plane appears unreachable. Distinct from any
 * single panel's status caption: a dead connection fails every panel at once,
 * and a one-line message next to whichever button happened to be clicked is
 * easy to read as "that one thing is broken" rather than "nothing here can
 * work right now". This is checked at the top of the page instead.
 */
let connectionIssue: string | undefined;

/**
 * `TypeError` is what `fetch` throws when a request never reached a server at
 * all — refused connection, DNS failure, or, locally, no dev server listening.
 * That is a different failure from the server responding with an error, and
 * it is what "Reset doesn't clear all the traces" turned out to be: the reset
 * call itself never reached the control plane, so nothing was cleared, and
 * every other panel failed the same way in the same moment for the same
 * reason. A per-panel caption alone did not make that obvious.
 */
function describeActionFailure(action: string, error: unknown): string {
  if (error instanceof TypeError) {
    connectionIssue =
      "AutoWebMCP cannot reach its local control plane, so nothing on this page can update right now. " +
      "Start it (`npm run dev:semanticizer`) or confirm it is still running, then try again.";
    return `${action} could not reach the control plane.`;
  }
  connectionIssue = undefined;
  return error instanceof Error ? error.message : `${action} failed.`;
}

/**
 * Clears the current candidate/execution/validation pointers.
 *
 * A binding candidate and a validation result describe *this* capability. If
 * a different trace is loaded, or a new candidate is proposed, or the
 * execution suggestion is regenerated, the previous candidate's evidence and
 * the previous validation's proof no longer describe anything current — they
 * must not silently keep rendering as if they still applied to whatever
 * replaced them. Run histories (`bindingRuns`, `validationRuns`) are not
 * touched: those are the audit trail and are meant to accumulate.
 */
function clearExecutionState(): void {
  bindingCandidate = undefined;
  bindingStatus = "";
  validation = undefined;
  validationStatus = "";
  browserBindingCandidate = undefined;
  fieldClarifications = [];
  clarificationDraft = {};
  groundingNeeds = [];
  groundingRenames = [];
  groundingNoncanonical = [];
  groundingUnresolved = [];
  queryProposal = undefined;
  queryOutcome = undefined;
  queryAccepted = false;
  queryTerm = "";
  queryStatus = "";
  liveValueDomains = {};
  liveDomainProblems = {};
  liveDomainRestorationFailed = false;
  liveDomainSources = {};
  domainAcquisitionTrail = [];
  domainAcquisitionFor = undefined;
  operations = {};
  browserBindingStatus = "";
  browserBindingValidation = undefined;
  browserValidationStatus = "";
  browserTestValues = {};
  browserTestErrors = [];
}

/**
 * One malformed field in one capture event should not take down the whole
 * render. `value` is typed as `string` because every real call site has one,
 * but a Studio rendering arbitrary trace/debug data from the network is
 * exactly the place a missing field surfaces, and the previous unconditional
 * `.replace` turned that into a full-page crash rather than a blank cell.
 */
function escapeHtml(value: string): string {
  if (value === undefined || value === null) return "";
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character] ?? character);
}

/** Unmissable on purpose: a dead connection is not one panel's problem. */
function renderConnectionBanner(): string {
  if (!connectionIssue) return "";
  return `<div class="connection-banner" role="alert"><strong>Connection problem.</strong> ${escapeHtml(
    connectionIssue
  )}</div>`;
}

function describeObservation(observation: ObservationTrace["observations"][number]): string {
  const parts: string[] = [];
  if (observation.field?.label) parts.push(escapeHtml(observation.field.label));
  if (observation.field?.context) parts.push(`in ${escapeHtml(observation.field.context)}`);
  if (observation.target) parts.push(escapeHtml(observation.target));
  if (observation.oldValue !== undefined || observation.newValue !== undefined) {
    parts.push(`<em>${escapeHtml(observation.oldValue ?? "∅")} → ${escapeHtml(observation.newValue ?? "∅")}</em>`);
  }
  if (observation.effects?.length) parts.push(`<small>${observation.effects.map(escapeHtml).join(" · ")}</small>`);
  return parts.join(" ");
}

/**
 * "How did the application do it", shown next to the trace and never folded
 * into the capability. Correlation, not causation, so the wording stays
 * observational.
 */
/** One capture card: what the human named it, where it came from, when, and how much. */
function renderTraceCard(trace: TraceSummary): string {
  const platformLabel = sourceApplicationFor(trace.platform as CapturePlatform, trace.application).label;
  const capturedAt = new Date(trace.startedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
  const durationMs = summaryDurationMs(trace);
  const duration = durationMs !== undefined ? ` · ${Math.max(1, Math.round(durationMs / 1000))} sec` : "";
  const description =
    trace.description && trace.description.length > 140
      ? `${trace.description.slice(0, 140)}…`
      : trace.description;
  const heading = trace.name ?? trace.title ?? trace.application;
  // The page title earns a line only when the heading is a human-given name
  // that differs from it — otherwise it would just repeat the heading.
  const subtitle = [platformLabel, trace.title && trace.title !== heading ? trace.title : undefined]
    .filter(Boolean)
    .join(" · ");

  return `<li><button class="trace-option ${trace.sessionId === selectedTrace?.sessionId ? "selected" : ""}" data-trace-id="${escapeHtml(trace.sessionId)}">
      <strong>${escapeHtml(heading)}</strong>
      <span>${escapeHtml(subtitle)}</span>
      <span>${escapeHtml(capturedAt)} · ${trace.observations} obs${escapeHtml(duration)} · <small>${escapeHtml(trace.sessionId.slice(0, 14))}</small></span>
      ${description ? `<span class="trace-description">${escapeHtml(description)}</span>` : ""}
    </button></li>`;
}

/**
 * Recording name and description are human metadata: editing them changes
 * what the person calls this capture and nothing else — the session
 * identity, events, observations, and evidence are untouched by design.
 */
/**
 * How the valid choices were established, for Admin / Debug.
 *
 * The user never sees this — acquisition is meant to feel like ordinary
 * form preparation — but the reasoning is retained: what was needed, which
 * sources were considered, which one answered, and what the live
 * inspection did to the application.
 */
function renderDomainProvenance(): string {
  const values = Object.entries(liveValueDomains);
  if (domainAcquisitionTrail.length === 0 && values.length === 0) {
    return panel(
      "Value-domain acquisition",
      "none yet",
      `<p class="semanticizer-status">No constrained field has needed its valid values resolved yet.</p>`
    );
  }

  // The values themselves, not merely their provenance: inspecting what
  // AutoWebMCP believes the domain to be must not require running a test.
  const sources = values
    .map(
      ([name, options]) =>
        `<li><code>${escapeHtml(name)}</code> — ${escapeHtml(liveDomainSources[name] ?? "unknown source")}` +
        `<ul class="reasons">${options.map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join("")}</ul></li>`
    )
    .join("");

  return panel(
    "Value-domain acquisition",
    values.length ? `${values.length} resolved` : "unresolved",
    `${sources ? `<ul class="reasons">${sources}</ul>` : ""}
     <ul class="need-path">${domainAcquisitionTrail.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>
     <div class="studio-actions">
       <button type="button" class="secondary" data-acquire-domains="debug">Read choices from application</button>
     </div>`
  );
}

function renderTraceDetailsEditor(): string {
  if (!selectedTrace) return "";
  const recording = selectedTrace.recording;
  return `<details class="admin-raw">
    <summary>Edit recording details</summary>
    <div class="trace-details-form">
      <label>Recording name
        <input id="trace-name" value="${escapeHtml(recording?.name ?? "")}" placeholder="${escapeHtml(selectedTrace.application.title ?? "Untitled recording")}" />
      </label>
      <label>Description
        <textarea id="trace-description" rows="2">${escapeHtml(recording?.description ?? "")}</textarea>
      </label>
      <div class="studio-actions">
        <button type="button" id="save-trace-details" class="secondary">Save details</button>
        <p class="semanticizer-status">${escapeHtml(traceDetailsStatus)}</p>
      </div>
    </div>
  </details>`;
}

function renderExtensionTraces(): string {
  const list = extensionTraces.length
    ? extensionTraces.map(renderTraceCard).join("")
    : "<li class=empty>No extension traces have been handed off yet.</li>";

  const detail = selectedTrace
    ? `<ol class="event-trace">${selectedTrace.observations
        .map((observation) => `<li><span>${escapeHtml(observation.action)}</span> ${describeObservation(observation)}</li>`)
        .join("")}</ol>
       <p class="semanticizer-status">${selectedTrace.stats.captureEvents} raw capture events
         → ${selectedTrace.observations.length} normalized observations
         → ${(selectedTrace.executionEvidence ?? []).length} execution evidence groups.
         Details are under Admin / Debug.</p>
       ${renderTraceDetailsEditor()}`
    : "";

  return `<section class="extension-traces" aria-label="Extension traces">
    <div class="panel-heading"><div><p class="eyebrow">Browser extension</p><h2>Teach Mode captures</h2></div><span>${extensionTraces.length}</span></div>
    <ul class="trace-list">${list}</ul>
    ${detail}
    <div class="studio-actions">
      <button id="refresh-traces" class="secondary" ${isWorking(operations, "refresh-traces") ? "disabled" : ""}>${
        isWorking(operations, "refresh-traces") ? "Refreshing…" : "Refresh traces"
      }</button>
      <button id="semanticize-extension-trace" ${selectedTrace ? "" : "disabled"}>Propose capability from trace</button>
      <p class="semanticizer-status">${escapeHtml(traceStatus)}</p>
    </div>
  </section>`;
}

function renderPublications(): string {
  const list = publications.length
    ? `<ul class="trace-list">${publications
        .map(
          (record) => `<li><div class="trace-option"><strong>${escapeHtml(record.capability.name)}</strong>
            <span><code>${escapeHtml(record.capability.id)}</code> · ${record.capability.inputs.length} inputs · published ${escapeHtml(
              record.publishedAt.slice(11, 19)
            )}</span></div></li>`
        )
        .join("")}</ul>`
    : "<p class=empty>No capability has been published. Cooperative sites expose nothing until one is.</p>";

  return `<section class="extension-traces" aria-label="Published capabilities">
    <div class="panel-heading"><div><p class="eyebrow">Control plane</p><h2>Published capabilities</h2></div><span>${publications.length}</span></div>
    ${list}
    <div class="studio-actions">
      <button id="refresh-publications" class="secondary">Refresh</button>
      <button id="unpublish-all" class="secondary" ${publications.length ? "" : "disabled"}>Unpublish all</button>
      <p class="semanticizer-status">${escapeHtml(publishStatus)}</p>
    </div>
  </section>`;
}

/**
 * The targeting parameters, shown apart from the demonstrated fields.
 *
 * A person is about to approve a contract containing an input they never
 * typed into anything. Rendering it in the same list as Stage and Close
 * Date would read as "another editable field we found", which is exactly
 * the wrong idea: it does not change a value on the record, it decides
 * WHICH record everything else applies to.
 *
 * Not editable, because its name and necessity come from the application's
 * own model rather than from anything a person chose — and an agent
 * calling the published tool has to supply precisely this name.
 */
function renderTargetIdentityInputs(capability: SemanticCapability): string {
  const identity = capability.inputs.filter((input) => input.role === "target-identity");
  if (identity.length === 0) return "";

  return `<div class="lifecycle-section target-identity">
    <p class="eyebrow">Execution target</p>
    <p class="semanticizer-status">Added by AutoWebMCP, not demonstrated. An agent calling this capability has not
      opened any record, so it must say which one it means — otherwise the write would land on whichever record
      happened to be on screen. Verified before writing and again after saving.</p>
    <ul class="reasons">${identity
      .map(
        (input) =>
          `<li><code>${escapeHtml(input.name)}</code> · required · ${escapeHtml(input.description)}</li>`
      )
      .join("")}</ul>
  </div>`;
}

/** Everything a human is asked to accept as the meaning of the capability. */
function semanticContract(capability: SemanticCapability): string {
  return JSON.stringify({
    name: capability.name,
    description: capability.description,
    inputs: capability.inputs.map((input) => [input.name, input.type, input.required])
  });
}

/**
 * The four-stage lifecycle header. One row, always visible once a capability
 * exists, so a person can see where they are without reading any internal
 * state name. `Capability → Execution → Validation → Publication`.
 */
function renderLifecycleStages(view: StudioLifecycleView): string {
  const stage = (name: string, statusClass: string, label: string): string =>
    `<li class="lifecycle-stage stage-${escapeHtml(statusClass)}"><span class="stage-name">${escapeHtml(
      name
    )}</span><span class="stage-badge">${escapeHtml(label)}</span></li>`;

  return `<ol class="lifecycle-stages">
    ${stage("Capability", view.capability.status, view.capability.label)}
    ${stage("Execution", view.execution.status, view.execution.label)}
    ${stage("Validation", view.validation.status, view.validation.label)}
    ${stage("Publication", view.publication.status, view.publication.label)}
  </ol>`;
}

/**
 * The Execution stage. Two routes converge here, and both are shown: the
 * application's own advertised actions (how SignalBase reaches a binding
 * today), and a suggested execution path built from evidence and platform
 * policy (how a constrained platform like Salesforce reaches one). Neither
 * route is SignalBase- or Salesforce-specific; which one has anything to show
 * depends only on what the taught application advertises and what evidence
 * exists.
 */
function renderExecutionStage(capability: SemanticCapability, view: StudioLifecycleView): string {
  if (view.capability.status !== "confirmed") {
    return `<div class="lifecycle-section">
      <p class="eyebrow">Execution</p>
      <p class="semanticizer-status">Execution analysis will be available after the capability is confirmed.</p>
    </div>`;
  }

  const source = capability.provenance.sourceApplication;
  const advertised = localRegistryBindingProvider.getBindings(source);
  const selected = resolveAdvertisedBinding(capability);

  const picker =
    view.execution.status === "advertised" || advertised.length > 0
      ? `<label>Or select a known action this application already performs
          <select name="binding">
            <option value="">No execution binding</option>
            ${advertised
              .map(
                (binding) =>
                  `<option value="${escapeHtml(`${binding.application}:${binding.action}`)}" ${
                    selected && selected.action === binding.action && selected.application === binding.application
                      ? "selected"
                      : ""
                  }>${escapeHtml(binding.action)}</option>`
              )
              .join("")}
          </select>
        </label>
        ${
          selected
            ? `<p class="semanticizer-status"><code>${escapeHtml(selected.action)}</code> reads ${selected.parameters
                .map((parameter) => `<code>${escapeHtml(parameter)}</code>`)
                .join(", ")}. Rename the parameters above to match.</p>`
            : ""
        }`
      : "";

  const suggestion =
    view.execution.status === "advertised"
      ? ""
      : `${
          view.execution.family
            ? `<dl class="capability-state">
                <div><dt>Suggested execution</dt><dd>${escapeHtml(view.execution.family)}</dd></div>
                <div><dt>Direct replay</dt><dd>prohibited</dd></div>
              </dl>
              ${view.execution.mechanism ? `<p class="semanticizer-status">${escapeHtml(view.execution.mechanism)}</p>` : ""}`
            : `<p class="semanticizer-status">${escapeHtml(view.execution.label)}</p>`
        }
        <div class="studio-actions">
          <button type="button" id="generate-binding" class="secondary">${
            bindingCandidate ? "Look for another execution path" : "Suggest an execution path"
          }</button>
          ${
            view.execution.canValidate
              ? `<button type="button" id="validate-binding" ${isWorking(operations, "validate-binding") ? "disabled" : ""}>${
                  isWorking(operations, "validate-binding") ? "Validating…" : "Validate this execution path"
                }</button>`
              : ""
          }
          ${
            view.execution.status === "candidate" && view.execution.canReject
              ? `<button type="button" id="reject-binding-candidate" class="secondary">Reject this suggestion</button>`
              : ""
          }
          <p class="semanticizer-status">${escapeHtml(bindingStatus)}</p>
        </div>`;

  return `<div class="lifecycle-section">
    <p class="eyebrow">Execution</p>
    ${picker}
    ${suggestion}
  </div>`;
}

/**
 * The Validation stage. Concise by design: full checks, raw evidence, and
 * warnings already live in Admin / Debug (`renderValidationRuns`), read from
 * the same `validation` state. This stage summarizes rather than duplicates.
 */
function renderValidationStage(view: StudioLifecycleView): string {
  if (view.capability.status !== "confirmed" || view.execution.status === "not-analyzed") {
    return `<div class="lifecycle-section">
      <p class="eyebrow">Validation</p>
      <p class="semanticizer-status">Nothing to validate yet.</p>
    </div>`;
  }
  if (view.validation.status === "not-applicable") {
    return `<div class="lifecycle-section">
      <p class="eyebrow">Validation</p>
      <p class="semanticizer-status">Not required: this execution path is one the application already advertises.</p>
    </div>`;
  }

  const requirementsText =
    view.validation.status === "requires-setup" && view.validation.requirements.length
      ? `<p class="semanticizer-status">Required before this can become agent-executable:
          ${view.validation.requirements.map(escapeHtml).join("; ")}.</p>`
      : "";

  const explanation =
    view.validation.status === "requires-setup"
      ? `<p class="semanticizer-status">AutoWebMCP understands the capability and identified a supported execution
          family, but that mechanism cannot be reached from the current execution context.</p>`
      : "";

  return `<div class="lifecycle-section">
    <p class="eyebrow">Validation</p>
    ${explanation}
    ${requirementsText}
    <div class="studio-actions">
      ${
        view.validation.canAccept
          ? `<button type="button" id="accept-binding">Accept execution binding</button>`
          : ""
      }
      <p class="semanticizer-status">${escapeHtml(validationStatus)}</p>
    </div>
  </div>`;
}

/**
 * The second execution strategy: driving the taught application's own
 * browser UI rather than calling a supported API. Shown as its own section
 * so both routes stay honestly visible at once — a Salesforce capability can
 * sit at "Setup required" on the supported-API route while this one is
 * "available / testable", and neither display hides the other.
 */
function renderBrowserExecutionStage(view: StudioLifecycleView): string {
  if (view.capability.status !== "confirmed" || view.browserExecution.status === "not-applicable") return "";

  const binding = view.browserExecution.binding;
  const body = binding
    ? `<dl class="capability-state">
        <div><dt>Platform</dt><dd>${escapeHtml(binding.platform)}</dd></div>
        <div><dt>Record type</dt><dd>${escapeHtml(binding.context.recordType ?? "unspecified")}</dd></div>
        <div><dt>Commit action</dt><dd>${escapeHtml(binding.commit.semanticAction.label)}</dd></div>
      </dl>
      <ul class="reasons">${binding.inputs
        .map(
          (input) =>
            `<li><code>${escapeHtml(input.semanticInput)}</code> → the ${escapeHtml(
              input.semanticTarget.role
            )} labelled "${escapeHtml(input.semanticTarget.label)}"${
              input.semanticTarget.section ? ` in "${escapeHtml(input.semanticTarget.section)}"` : ""
            }</li>`
        )
        .join("")}</ul>
      <p class="semanticizer-status">Re-resolved from the live page at execution time — never a recorded coordinate,
        selector, or replay script. Safety: no coordinates, no XPath, no private-transport replay, no credential
        extraction.</p>
      ${binding.evidence.length ? `<ul class="reasons">${binding.evidence.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>` : ""}`
    : view.browserExecution.status === "no-safe-candidate"
      ? `<p class="semanticizer-status">${escapeHtml(
          browserBindingCandidate?.proposal.warnings.join(" ") ?? "No safe browser execution path was found from the available evidence."
        )}</p>`
      : "";

  return `<div class="lifecycle-section">
    <p class="eyebrow">Semantic browser execution</p>
    ${renderEpistemicNeeds()}
    ${body}
    <div class="studio-actions">
      <button type="button" id="suggest-browser-binding" class="secondary" ${
        isWorking(operations, "suggest-binding") ? "disabled" : ""
      }>${
        isWorking(operations, "suggest-binding")
          ? "Suggesting…"
          : browserBindingCandidate
            ? "Suggest again"
            : "Suggest browser execution"
      }</button>
      ${
        view.browserExecution.status === "proposed" && view.browserExecution.canReject
          ? `<button type="button" id="reject-browser-binding" class="secondary">Reject this suggestion</button>`
          : ""
      }
      <p class="semanticizer-status">${escapeHtml(browserBindingStatus)}</p>
    </div>
    ${view.browserExecution.canTest && candidate && binding ? renderBrowserTestForm(candidate, binding) : ""}
  </div>`;
}



/**
 * Runs the deterministic proposal with whatever is currently known.
 *
 * Deliberately re-runnable: answering an epistemic need calls this again
 * and nothing else. Semantic inference is not repeated — the capability's
 * meaning was already confirmed by a human, and only the grounding of its
 * fields was ever in question.
 */
function runBrowserBindingProposal(): void {
  if (!candidate || !selectedTrace) return;
  const intelligence = {
    ...applicationIntelligenceForPlatform(selectedTrace.application.platform, tenantIntelligence),
    clarifications: fieldClarifications
  };
  const proposal = proposeBrowserBinding(candidate, selectedTrace, intelligence);
  browserBindingCandidate = { state: "proposed", proposal };

  const blocking = (proposal.needs ?? []).filter((need) => need.blocking);
  browserBindingStatus = proposal.binding
    ? "Browser execution path suggested from the captured evidence. Test it before accepting."
    : blocking.length > 0
      ? `${blocking.length === 1 ? "One fact is" : `${blocking.length} facts are`} missing before a binding can be built.`
      : `No safe browser execution path was found: ${proposal.warnings.join(" ")}`;
}

/**
 * Grounds the proposed capability and settles its agent-facing names,
 * BEFORE a human is asked to confirm anything.
 *
 * The lifecycle defect this exists to fix: canonicalization used to run
 * once, at proposal time, on whatever knowledge happened to exist then.
 * Field identity, though, could arrive later — from a human answering
 * which field a label meant — and by then the contract had been confirmed.
 * Renaming it afterwards would publish something the human never approved;
 * not renaming it would publish one org's vocabulary forever. The fix is
 * ordering, not a new mechanism: resolve identity while the contract is
 * still open.
 *
 * DOM-free by construction. `canonicalizeCapabilityInputs` and
 * `resolveFieldMapping` are pure functions over the trace and what the
 * knowledge layers hold; nothing here resolves a live control, opens a
 * page, or creates execution state. Semantic identity and a DOM locator
 * stay different things — only the first can change what an agent sees,
 * and the second is still re-resolved fresh at execution time.
 */
function runSemanticGrounding(): void {
  if (!candidate || !selectedTrace) return;
  const intelligence = {
    ...applicationIntelligenceForPlatform(selectedTrace.application.platform, tenantIntelligence),
    clarifications: fieldClarifications
  };

  const grounded = groundCapability(candidate, selectedTrace, intelligence);
  candidate = grounded.capability;
  groundingNeeds = grounded.needs;
  groundingRenames = grounded.renames;
  groundingNoncanonical = grounded.noncanonical;
  groundingUnresolved = grounded.unresolved;
  if (grounded.confirmationWithdrawn) semanticizerStatus = describeWithdrawnConfirmation(grounded.renames);
}

/**
 * Records a human answer and immediately retries resolution.
 *
 * The answer is kept as what it is — human-supplied, scoped to this
 * capability — so a later metadata source can confirm it, strengthen its
 * provenance, or contradict it, rather than finding it already promoted
 * into application truth.
 */
function recordClarification(observedLabel: string, objectApiName: string, apiName: string): void {
  const trimmed = apiName.trim();
  if (!trimmed || !observedLabel || !selectedTrace) return;

  fieldClarifications = [
    ...fieldClarifications.filter(
      (entry) => entry.observedLabel.toLowerCase() !== observedLabel.toLowerCase()
    ),
    {
      platform: selectedTrace.application.platform,
      ...(objectApiName ? { objectApiName } : {}),
      observedLabel,
      apiName: trimmed,
      source: "human-confirmed",
      answeredAt: new Date().toISOString(),
      scope: "capability"
    }
  ];
  clarificationDraft = {};
  // Grounding first: the answer may settle a field identity, and identity
  // decides the contract's own parameter names. Only once that has settled
  // is there any point re-deriving how to execute it — and a binding is
  // re-proposed only if one already existed, so answering a question before
  // confirmation never manufactures execution state.
  runSemanticGrounding();
  if (browserBindingCandidate) runBrowserBindingProposal();
  render();
}

/**
 * An epistemic need, rendered as the question it is.
 *
 * The alternative — burying "could not ground stage" in a warning string —
 * throws away the most useful thing the system worked out: exactly which
 * fact would unblock it. Suggestions are shown as suggestions, with where
 * each came from, and confirming one is a deliberate act.
 */
function renderEpistemicNeed(need: EpistemicNeed, needIndex: number, source: "grounding" | "binding"): string {
  const heading =
    need.status === "needs-information"
      ? "Needs information"
      : need.status === "needs-setup"
        ? "Needs setup"
        : need.status === "ambiguous"
          ? "Needs a decision"
          : "Blocked";

  const known = [
    need.knownEvidence.objectApiName ? `object <code>${escapeHtml(need.knownEvidence.objectApiName)}</code>` : undefined,
    need.knownEvidence.observedLabel ? `observed label "${escapeHtml(need.knownEvidence.observedLabel)}"` : undefined,
    need.knownEvidence.observedIdentifier
      ? `observed identifier <code>${escapeHtml(need.knownEvidence.observedIdentifier)}</code>`
      : undefined
  ].filter(Boolean);

  const suggestions = (need.suggestedAnswers ?? [])
    .map(
      (suggestion, index) =>
        `<li><code>${escapeHtml(suggestion.value)}</code>
           <small>${escapeHtml(suggestion.detail)}</small>
           <button type="button" class="secondary" data-accept-suggestion="${index}" data-need-index="${needIndex}"
             data-need-label="${escapeHtml(need.knownEvidence.observedLabel ?? "")}"
             data-need-object="${escapeHtml(need.knownEvidence.objectApiName ?? "")}"
             data-need-source="${source}"
           >This one</button></li>`
    )
    .join("");

  // How the system got here. Shown because "I could not resolve this" is a
  // far weaker thing to read than the steps that were actually tried.
  const trail = (need.resolutionPath ?? []).length
    ? `<ul class="need-path">${(need.resolutionPath ?? []).map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>`
    : "";

  // Identified per need, not by one shared id. Two unanswerable fields in
  // one capability used to render two elements carrying the same id, so
  // `querySelector` found only the first and the second question could not
  // be answered at all. Grounding now asks these before confirmation, which
  // makes more than one of them entirely ordinary.
  const answerId = `clarification-answer-${source}-${needIndex}`;
  // The answer that was missing entirely. A global search box is not a
  // field on any record, and until now the only way past this question was
  // to name an API field that does not exist — a false answer, given
  // because it was the only one the form accepted.
  const notAField = need.knownEvidence.inputName
    ? `<button type="button" class="secondary not-a-record-field"
         data-input-name="${escapeHtml(need.knownEvidence.inputName)}">
         This is not a record field — it searches or navigates
       </button>`
    : "";
  const answerBox =
    need.blocking
      ? `<div class="need-answer">
          ${notAField}
          <label>${suggestions ? "Or another field API name" : "Field API name"}
            <input id="${answerId}" class="clarification-answer" value="${escapeHtml(clarificationDraft[answerId] ?? "")}"
              placeholder="e.g. Implementation_Region__c"
              data-need-label="${escapeHtml(need.knownEvidence.observedLabel ?? "")}"
              data-need-object="${escapeHtml(need.knownEvidence.objectApiName ?? "")}" />
          </label>
          <button type="button" class="secondary submit-clarification" data-answer-id="${answerId}">Use this API name</button>
        </div>`
      : "";

  return `<div class="epistemic-need ${need.blocking ? "blocking" : "advisory"}">
    <p class="eyebrow">${escapeHtml(heading)}</p>
    <p>${escapeHtml(need.question)}</p>
    <p class="semanticizer-status">${escapeHtml(need.reason)}</p>
    ${known.length ? `<p class="semanticizer-status">Already known: ${known.join(", ")}. You are not being asked for these.</p>` : ""}
    ${trail}
    ${suggestions ? `<ul class="need-suggestions">${suggestions}</ul>` : ""}
    ${answerBox}
  </div>`;
}

function renderEpistemicNeeds(): string {
  const needs = browserBindingCandidate?.proposal.needs ?? [];
  if (needs.length === 0) return "";
  return needs.map((need, index) => renderEpistemicNeed(need, index, "binding")).join("");
}

/**
 * What grounding settled, and what it still needs, shown WHERE THE HUMAN
 * CONFIRMS — not later, next to execution.
 *
 * These three things all bear on the same decision. A rename explains why
 * a parameter is called `stage` when the screen said "Sales Stage". An
 * open question is one whose answer would change that name, so it belongs
 * before the button and not after it. A name that stayed tenant-derived is
 * a property of the contract being approved, so it is said plainly rather
 * than left for someone to infer from its absence.
 *
 * Suppressed once a binding exists: from then on the same questions are
 * the execution stage's, and rendering both would put two answer boxes on
 * one page.
 */
function renderSemanticGrounding(): string {
  if (browserBindingCandidate) return "";
  const renames = groundingRenames.length
    ? `<ul class="reasons">${groundingRenames
        .map((rename) => `<li>${escapeHtml(rename.detail)}</li>`)
        .join("")}</ul>`
    : "";
  // Two different situations, deliberately worded differently. One
  // executes and travels badly; the other does not execute. Calling both
  // "not canonical" would tell someone their capability merely lacks
  // portability when in fact it will not bind.
  const noncanonical = groundingNoncanonical.length
    ? `<p class="ambiguity">${escapeHtml(
        `${groundingNoncanonical.map((name) => `"${name}"`).join(", ")} ` +
          `${groundingNoncanonical.length === 1 ? "is named" : "are named"} after what this org calls the field, because ` +
          "the vendor's own model has no name for it. This works and will execute; its contract is specific to this " +
          "org rather than portable to another running the same application."
      )}</p>`
    : "";
  const unresolved = groundingUnresolved.length
    ? `<p class="ambiguity">${escapeHtml(
        `${groundingUnresolved.map((name) => `"${name}"`).join(", ")} ` +
          `${groundingUnresolved.length === 1 ? "matches nothing" : "match nothing"} that was demonstrated in this ` +
          "recording, so no execution path can be built for it. Rename the parameter to the field that was actually " +
          "used, remove it, or record the workflow again."
      )}</p>`
    : "";
  const questions = groundingNeeds.map((need, index) => renderEpistemicNeed(need, index, "grounding")).join("");
  if (!renames && !noncanonical && !unresolved && !questions) return "";

  return `<div class="lifecycle-section">
    <p class="eyebrow">Semantic grounding</p>
    ${questions}
    ${renames}
    ${noncanonical}
    ${unresolved}
  </div>`;
}

/** One typed control per field, per the canonical input contract. */
function renderTestControl(field: TestFormField): string {
  const value = browserTestValues[field.name] ?? "";
  switch (field.control) {
    case "date":
      return `<input type="date" data-test-input="${escapeHtml(field.name)}" value="${escapeHtml(value)}" />`;
    case "number":
      return `<input type="number" data-test-input="${escapeHtml(field.name)}" value="${escapeHtml(value)}" />`;
    case "checkbox":
      return `<input type="checkbox" data-test-input="${escapeHtml(field.name)}" ${value === "true" ? "checked" : ""} />`;
    case "select":
      // A fixed set of choices whose contents are not established stays a
      // disabled select, never a text box: the field is constrained whether
      // or not anyone has enumerated it, and offering free text would invite
      // exactly the arbitrary business value the application will refuse.
      if (field.domainUnknown) {
        // Acquisition runs by itself, so the control reports the state of
        // that work rather than offering the user a job to start.
        const acquiring = isWorking(operations, "acquire-domains");
        const why = liveDomainProblems[field.name];
        return `<select data-test-input="${escapeHtml(field.name)}" disabled aria-busy="${acquiring}">
            <option value="">${escapeHtml(acquiring ? "Loading valid choices…" : "Valid values are not known")}</option>
          </select>
          <small class="domain-unknown">${
            acquiring
              ? `<span class="spinner" aria-hidden="true"></span>${escapeHtml(`Loading valid ${field.label} choices…`)}`
              : escapeHtml(
                  why || operations["acquire-domains"]?.status === "failed"
                    ? `Valid ${field.label} choices could not be determined automatically.` +
                      (why ? ` ${why}` : "")
                    : `${field.label} is a fixed set of choices whose values are not known yet.`
                )
          }</small>`;
      }
      return `<select data-test-input="${escapeHtml(field.name)}">
        <option value="">Choose…</option>
        ${(field.options ?? []).map((option) => `<option value="${escapeHtml(option)}" ${value === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
      </select>`;
    default:
      return `<input type="text" data-test-input="${escapeHtml(field.name)}" value="${escapeHtml(value)}" />`;
  }
}

/**
 * The execution test form. Controls come from the capability's canonical
 * input types, values are validated and canonicalized before the explicit
 * confirmation, and confirmation summarizes what will actually be done —
 * it never collects values one-by-one through prompts.
 */
function renderBrowserTestForm(
  capability: SemanticCapability,
  binding: NonNullable<BrowserBindingCandidateRecord["proposal"]["binding"]>
): string {
  const fields = buildTestFormFields(capability, binding, liveValueDomains);
  const readiness = assessExecutionReadiness(fields, binding);
  const testing = isWorking(operations, "run-browser-test");
  // The form is where the need becomes concrete, so it is where resolving
  // it begins. Guarded inside against re-entry from repeated renders.
  void acquireValueDomains();
  return `<div class="test-form">
    <p class="eyebrow">Test execution</p>
    ${renderOperationStatus("acquire-domains")}
    ${fields
      .map(
        (field) => `<label>${escapeHtml(field.label)}${field.required ? " *" : ""}
          ${renderTestControl(field)}
        </label>${
          field.domainUnknown && !isWorking(operations, "acquire-domains")
            ? `<div class="studio-actions"><button type="button" class="secondary" data-acquire-domains="retry">Try again</button></div>`
            : ""
        }`
      )
      .join("")}
    ${browserTestErrors.length ? `<p class="ambiguity">${browserTestErrors.map(escapeHtml).join(" · ")}</p>` : ""}
    <div class="studio-actions">
      <button type="button" id="run-browser-test" ${
        readiness.canRun && !testing && !isWorking(operations, "acquire-domains") ? "" : "disabled"
      }>${testing ? "Running test…" : "Run test"}</button>
      ${
        readiness.canRun
          ? renderOperationStatus("run-browser-test")
          : `<p class="semanticizer-status">${escapeHtml(readiness.summary)}</p>`
      }
    </div>
  </div>`;
}

/**
 * The browser route's own validation summary — a test result, not a
 * supported-interface proof, so its language stays "tested" and "verified"
 * rather than "validated" against a documented interface.
 */
/**
 * Per-input before/requested/after-write/after-save.
 *
 * Four separate facts, shown separately: a result that said only "value"
 * left a live failure unreadable, because nothing distinguished what the
 * record held from what the test had asked for.
 */
function renderTransactions(result: ExecutionResult): string {
  if (!result.transactions?.length) return "";
  return `<ul class="reasons">${result.transactions
    .map(
      (transaction) => `<li><code>${escapeHtml(transaction.name)}</code>${
        transaction.apiName ? ` <small>${escapeHtml(transaction.apiName)}</small>` : ""
      }
        <ul class="need-path">
          <li>current application value: ${escapeHtml(transaction.beforeValue ?? "unreadable")}</li>
          <li>requested test value: ${escapeHtml(transaction.requestedValue)}</li>
          <li>after write: ${escapeHtml(transaction.afterWriteValue ?? "unreadable")}</li>
          ${transaction.afterSaveValue !== undefined ? `<li>after save: ${escapeHtml(transaction.afterSaveValue)}</li>` : ""}
          <li>input verified: ${escapeHtml(transaction.verified)}</li>
        </ul>
      </li>`
    )
    .join("")}</ul>`;
}

function renderBrowserValidationStage(view: StudioLifecycleView): string {
  // Nothing to show before a test has actually run — the browser-execution
  // section above already carries the "not tested yet" state via its own
  // Test/Suggest actions, so an empty result section here would just repeat
  // that with no new information.
  const result = browserBindingValidation?.result;
  if (!result) return "";

  const checks = `<ul class="reasons">${result.checks
    .map(
      (check) =>
        `<li class="check-${escapeHtml(check.status)}"><strong>${escapeHtml(
          check.status.toUpperCase()
        )}</strong> ${escapeHtml(check.name)} — ${escapeHtml(check.detail)}</li>`
    )
    .join("")}</ul>
    ${renderTransactions(result)}
    ${result.evidence.length ? `<ul class="reasons">${result.evidence.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>` : ""}
    ${result.warnings.length ? `<p class="ambiguity">${result.warnings.map(escapeHtml).join(" · ")}</p>` : ""}`;

  return `<div class="lifecycle-section">
    <p class="eyebrow">Browser execution test result</p>
    <p class="semanticizer-status">${escapeHtml(view.browserValidation.label)}</p>
    ${checks}
    <div class="studio-actions">
      ${
        view.browserValidation.canAccept
          ? `<button type="button" id="accept-browser-binding">Accept execution binding</button>`
          : ""
      }
      <p class="semanticizer-status">${escapeHtml(browserValidationStatus)}</p>
    </div>
  </div>`;
}

/** The Publication stage. Always says exactly why, never a bare disabled button. */
/**
 * The entity-search lifecycle: propose, run it for real, accept, publish.
 *
 * Deliberately parallel to the mutation stage rather than merged with it.
 * A search has nothing to commit and no record to verify; what a human is
 * judging is whether it returned the right candidates from the real
 * application, which is a different question from whether a write landed.
 */
function renderQueryStage(capability: SemanticCapability): string {
  if (capability.provenance.confirmedByHuman !== true) return "";
  if (!capability.safety.readOnly && !queryProposal) return "";

  const binding = queryProposal?.binding;
  const body = binding
    ? `<ul class="reasons">${binding.evidence.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
       <dl class="capability-state">
         <div><dt>Finds</dt><dd>${escapeHtml(binding.entityType)}</dd></div>
         <div><dt>Search field</dt><dd>${escapeHtml(binding.query.semanticTarget.label)}</dd></div>
         <div><dt>Run by</dt><dd>${escapeHtml(binding.submit?.label ?? binding.submitKey ?? "typing alone")}</dd></div>
       </dl>
       <div class="test-form">
         <label>${escapeHtml(binding.query.inputName)}
           <input type="text" id="query-term" value="${escapeHtml(queryTerm)}" placeholder="e.g. Acme Renewal" />
         </label>
         <div class="studio-actions">
           <button type="button" id="run-query" ${isWorking(operations, "run-query") ? "disabled" : ""}>${
             isWorking(operations, "run-query") ? "Searching…" : "Run search"
           }</button>
           ${
             queryOutcome && queryOutcome.candidates.length > 0 && !queryAccepted
               ? `<button type="button" id="accept-query">Accept search</button>`
               : ""
           }
         </div>
         ${renderOperationStatus("run-query", queryStatus)}
       </div>
       ${renderQueryCandidates()}`
    : `<p class="semanticizer-status">${escapeHtml(
        queryProposal?.warnings.join(" ") ?? "No search has been suggested from this recording yet."
      )}</p>`;

  return `<div class="lifecycle-section">
    <p class="eyebrow">Entity search</p>
    ${body}
    <div class="studio-actions">
      <button type="button" id="suggest-query" class="secondary">${
        binding ? "Suggest again" : "Suggest an entity search"
      }</button>
      ${queryAccepted ? `<p class="semanticizer-status">Search accepted. It will be published with the capability.</p>` : ""}
    </div>
  </div>`;
}

/** What the application offered, with the identity a later step would use. */
function renderQueryCandidates(): string {
  if (!queryOutcome) return "";
  if (queryOutcome.candidates.length === 0) {
    return `<p class="semanticizer-status">${escapeHtml(
      queryOutcome.warnings.join(" ") || "The search returned no candidates."
    )}</p>`;
  }
  // Type is a column, not a footnote. A search returns whatever the
  // application found, and which KIND of record a candidate is decides
  // whether a given tool can act on it at all — an Account id handed to an
  // Opportunity tool is refused at the mutation, and a caller should be
  // able to see that coming.
  return `<div class="table-scroll"><table class="comparison">
      <thead><tr><th>Name</th><th>Type</th><th>Identity</th></tr></thead>
      <tbody>${queryOutcome.candidates
        .map(
          (candidate) =>
            `<tr><td>${escapeHtml(candidate.name)}</td>
             <td>${escapeHtml(candidate.entityType)}</td>
             <td><code>${escapeHtml(candidate.id)}</code></td></tr>`
        )
        .join("")}</tbody>
    </table></div>
    ${
      queryOutcome.warnings.length
        ? `<p class="ambiguity">${queryOutcome.warnings.map(escapeHtml).join(" ")}</p>`
        : ""
    }`;
}

function renderPublicationStage(view: StudioLifecycleView): string {
  return `<div class="lifecycle-section">
    <p class="eyebrow">Publication</p>
    ${
      view.publication.reason
        ? `<p class="semanticizer-status">${escapeHtml(view.publication.reason)}</p>`
        : ""
    }
    <div class="studio-actions">
      <button type="button" id="publish-capability" class="${view.publication.canPublish ? "" : "secondary"}" ${
    view.publication.canPublish ? "" : "disabled"
  }>Publish WebMCP capability</button>
      <p class="semanticizer-status">${escapeHtml(publishStatus)}</p>
    </div>
  </div>`;
}

/* ----------------------- admin / debug surface ---------------------- *
 * The provenance plane: what was observed, what it was transformed into,
 * what was sent to the model, what came back, and what was read out of it.
 * It only reads state the pipeline already produced — nothing here changes
 * a capability, a binding, or a publication.
 * ------------------------------------------------------------------- */

function json(value: unknown): string {
  return `<pre class="admin-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function panel(title: string, count: string, body: string): string {
  return `<details class="admin-panel"><summary>${escapeHtml(title)} <span>${escapeHtml(count)}</span></summary>${body}</details>`;
}

function describeCaptureEvent(event: CaptureEvent): string {
  const parts = [`<span>${escapeHtml(event.kind)}</span>`];
  if (event.actionLabel) parts.push(`<strong>${escapeHtml(event.actionLabel)}</strong>`);
  if (event.field?.label) parts.push(escapeHtml(event.field.label));
  if (event.field?.section) parts.push(`<small>in ${escapeHtml(event.field.section)}</small>`);
  if (event.value) {
    parts.push(
      event.value.masked
        ? "<em>value masked</em>"
        : `<em>${escapeHtml(event.value.from ?? "∅")} → ${escapeHtml(event.value.to ?? "∅")}</em>`
    );
  }
  if (event.network) {
    const net = event.network;
    parts.push(
      `<em>${escapeHtml(net.method)} ${escapeHtml(net.endpoint)} · ${net.failed ? "failed" : net.status} · ${net.durationMs}ms · ${escapeHtml(net.resourceType)}</em>`
    );
  }
  if (event.reaction) {
    const signals = Object.entries(event.reaction)
      .filter(([, value]) => value === true)
      .map(([key]) => key);
    parts.push(`<small>${signals.length ? escapeHtml(signals.join(", ")) : "no visible reaction"}</small>`);
  }
  return parts.join(" ");
}

function renderTraceIdentity(trace: ObservationTrace): string {
  const label = sourceApplicationFor(trace.application.platform, trace.application.host).label;
  return `<dl class="trace-identity">
    <div><dt>Source application</dt><dd><strong>${escapeHtml(label)}</strong></dd></div>
    <div><dt>Session</dt><dd><code>${escapeHtml(trace.sessionId)}</code></dd></div>
    <div><dt>Captured</dt><dd>${escapeHtml(trace.startedAt)}</dd></div>
    <div><dt>Host</dt><dd>${escapeHtml(trace.application.host)}</dd></div>
    <div><dt>Pipeline</dt><dd>${trace.stats.captureEvents} raw → ${trace.observations.length} observations →
      ${(trace.executionEvidence ?? []).length} evidence groups</dd></div>
  </dl>`;
}

function renderCaptureStream(trace: ObservationTrace): string {
  const events = trace.captureEvents ?? [];
  if (events.length === 0) {
    return panel(
      "Capture stream",
      "unavailable",
      `<p class="semanticizer-status">This trace was captured before the capture stream was carried across the
        handoff. Re-record to inspect it.</p>`
    );
  }

  const lines = [...events]
    .sort((left, right) => left.t - right.t)
    .map((event) => `<li><code>${event.t}ms</code> ${describeCaptureEvent(event)}</li>`)
    .join("");

  return panel(
    "Capture stream",
    `${events.length} events`,
    `<ol class="admin-stream">${lines}</ol>
     <details class="admin-raw"><summary>JSON</summary>${json(events)}</details>`
  );
}

function renderNormalizedPanel(trace: ObservationTrace): string {
  const lines = trace.observations
    .map(
      (observation) =>
        `<li><code>${observation.t}ms</code> <span>${escapeHtml(observation.action)}</span> ${describeObservation(observation)}</li>`
    )
    .join("");

  return panel(
    "Normalized trace",
    `${trace.stats.captureEvents} → ${trace.observations.length}`,
    `<ol class="admin-stream">${lines}</ol>
     <details class="admin-raw"><summary>JSON</summary>${json(trace.observations)}</details>`
  );
}

function renderEvidencePanel(trace: ObservationTrace): string {
  const evidence = trace.executionEvidence ?? [];
  const scored = evidence
    .map(
      (entry) => `<li><strong>${escapeHtml(entry.actionLabel ?? entry.action)}</strong>
        <small>${(entry.causalCandidates ?? []).length} causal ${
          (entry.causalCandidates ?? []).length === 1 ? "candidate" : "candidates"
        } of ${(entry.networkEffects ?? []).length} correlated requests</small>
        <ul class="network-effects">${(entry.networkEffects ?? [])
          .map(
            (effect) => `<li class="effect-${escapeHtml(effect.confidence)}">
              <span>${escapeHtml(effect.method)}</span> <code>${escapeHtml(effect.pathPattern)}</code>
              <em>${effect.failed ? "failed" : String(effect.status)}</em>
              <strong>${escapeHtml(effect.confidence.toUpperCase())}</strong>
              <small class="role-${escapeHtml(effect.role ?? "nearby")}">${
                (effect.role ?? "nearby") === "causal-candidate" ? "causal candidate" : "nearby activity"
              }</small>
              <ul class="reasons">${(effect.reasons ?? [])
                .map((reason) => `<li>${escapeHtml(reason)}</li>`)
                .join("")}</ul>
              <small>binding eligibility: ${escapeHtml(effect.bindingEligibility ?? "unresolved")}</small>
            </li>`
          )
          .join("")}</ul>
        ${
          (entry.applicationEffects ?? []).length
            ? `<small>Application: ${(entry.applicationEffects ?? []).map(escapeHtml).join(" · ")}</small>`
            : ""
        }
      </li>`
    )
    .join("");

  return panel(
    "Execution evidence",
    evidence.length ? `${evidence.length} correlated` : "none observed",
    `<p class="semanticizer-status">Observed correlation only. Confidence says how strongly the evidence
      associates a mechanism with an action; it says nothing about whether that mechanism may be called.
      Binding eligibility is a separate axis and is unresolved for everything until platform knowledge exists.</p>
     ${evidence.length ? `<ul class="evidence-list">${scored}</ul>${json(evidence)}` : "<p class=empty>No network activity was correlated with this session.</p>"}`
  );
}

function renderSemanticizerRuns(): string {
  if (semanticizerRuns.length === 0) {
    return panel(
      "Semantic inference runs",
      "none yet",
      `<p class="semanticizer-status">Propose a capability from a trace to record a run.</p>`
    );
  }

  const runs = semanticizerRuns
    .map((run, index) => {
      const result = run.candidate
        ? `<details class="admin-raw"><summary>Parsed result</summary>${json({
            candidate: run.candidate,
            ambiguities: run.ambiguities
          })}</details>`
        : `<details class="admin-raw" open><summary>Parsed result — failed</summary>
            <p class="ambiguity">${escapeHtml(run.parseError ?? "unknown parse error")}</p></details>`;

      return `<details class="admin-run">
        <summary>Run #${index + 1} · <code>${escapeHtml(run.diagnostics.model)}</code> ·
          ${run.diagnostics.latencyMs}ms · ${run.candidate ? "parsed" : "parse failed"}</summary>
        <p class="semanticizer-status">
          run <code>${escapeHtml(run.runId)}</code> ·
          trace <code>${escapeHtml(run.traceSessionId)}</code> ·
          prompt <code>${escapeHtml(run.diagnostics.promptVersion)}</code> ·
          ${escapeHtml(run.diagnostics.requestedAt)}
          ${run.diagnostics.providerResponseId ? ` · provider <code>${escapeHtml(run.diagnostics.providerResponseId)}</code>` : ""}
        </p>
        <details class="admin-raw"><summary>Request</summary>${json({
          model: run.diagnostics.model,
          parameters: run.diagnostics.parameters,
          instructions: run.diagnostics.instructions,
          input: safeJsonParse(run.diagnostics.input)
        })}</details>
        <details class="admin-raw"><summary>Raw response</summary><pre class="admin-json">${escapeHtml(
          run.rawResponse
        )}</pre></details>
        ${result}
      </details>`;
    })
    .join("");

  return panel(
    "Semantic inference runs",
    `${semanticizerRuns.length}`,
    `<p class="semanticizer-status">The model answers one question: what business capability did this workflow
      represent? It is never asked what API should execute it — execution binding is chosen by a human from the
      taught application's advertised actions.</p>${runs}`
  );
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Several recordings side by side. The question it exists to answer is whether
 * different field updates converge on one underlying transport — which would
 * make that transport a generic record-save mechanism rather than a
 * business-specific capability. The table shows the evidence; it draws no such
 * conclusion, because that is a judgement about a platform, not about timing.
 */
/** The one place the bundle is assembled, for both the panel and the download. */
function currentDebugBundle(): DebugBundle | undefined {
  if (!selectedTrace) return undefined;
  return buildDebugBundle({
    trace: selectedTrace,
    runs: semanticizerRuns,
    candidate,
    ambiguities,
    publications,
    bindingRuns,
    bindingCandidate,
    validationRuns,
    validation,
    // The browser execution route: the proposed binding, the test result
    // with its per-input transactions, how any constrained domain was
    // established, and any human answers behind a grounding.
    ...(browserBindingCandidate ? { browserBindingCandidate } : {}),
    ...(browserBindingValidation ? { browserValidation: browserBindingValidation } : {}),
    valueDomains: {
      resolved: liveValueDomains,
      sources: liveDomainSources,
      unresolved: liveDomainProblems,
      trail: domainAcquisitionTrail
    },
    clarifications: fieldClarifications,
    exportedAt: new Date().toISOString()
  });
}

/** Read-only. The controls that change any of this stay in the normal workflow. */
function renderLifecyclePanel(): string {
  const bundle = currentDebugBundle();
  const lifecycle = bundle?.capabilityLifecycle;
  if (!lifecycle?.candidate) {
    return panel(
      "Capability lifecycle",
      "no candidate",
      `<p class="semanticizer-status">No capability has been proposed from this capture yet.</p>`
    );
  }

  const binding = lifecycle.executionBinding;
  return panel(
    "Capability lifecycle",
    lifecycle.publishable ? "publishable" : "blocked",
    `<dl class="capability-state">
      <div><dt>Candidate</dt><dd><code>${escapeHtml(lifecycle.candidate.id)}</code></dd></div>
      <div><dt>Semantic confirmation</dt><dd>${escapeHtml(lifecycle.semanticConfirmation ?? "—")}</dd></div>
      <div><dt>Execution binding</dt><dd>${
        binding ? `<code>${escapeHtml(`${binding.application}.${binding.action}`)}</code>` : "not discovered"
      }</dd></div>
      <div><dt>Publishability</dt><dd>${lifecycle.publishable ? "ready" : "blocked"}</dd></div>
      <div><dt>Publication</dt><dd>${
        lifecycle.publication ? escapeHtml(lifecycle.publication.publishedAt) : "not published"
      }</dd></div>
    </dl>`
  );
}

function renderExportPanel(): string {
  if (!selectedTrace) {
    return panel(
      "Export",
      "no capture selected",
      `<p class="semanticizer-status">Select a Teach Mode capture to export its evidence.</p>
       <div class="studio-actions"><button id="download-bundle" class="secondary" disabled>Download debug bundle</button></div>`
    );
  }

  return panel(
    "Export",
    debugBundleFilename(selectedTrace.sessionId),
    `<p class="semanticizer-status">Everything safely retained about
      <code>${escapeHtml(selectedTrace.sessionId)}</code>: capture stream, normalized observations, execution
      evidence, every semantic inference run, and the capability lifecycle. It carries no credential, header,
      body, or query value, because the pipeline never retained any.</p>
     <div class="studio-actions">
       <button id="download-bundle">Download debug bundle</button>
       <button id="copy-bundle" class="secondary">Copy JSON</button>
       <p class="semanticizer-status">${escapeHtml(exportStatus)}</p>
     </div>`
  );
}

function renderBindingRuns(): string {
  if (bindingRuns.length === 0) {
    return panel(
      "Binding inference runs",
      bindingCandidate ? "resolved without a model" : "none yet",
      `<p class="semanticizer-status">${
        bindingCandidate
          ? "The strongest evidence was decided deterministically; no model call was needed."
          : "Confirm a capability and suggest an execution binding to record a run."
      }</p>`
    );
  }

  const runs = bindingRuns
    .map(
      (run, index) => `<details class="admin-run">
        <summary>Run #${index + 1} · <code>${escapeHtml(run.diagnostics.model)}</code> ·
          ${run.diagnostics.latencyMs}ms · ${run.proposal ? "parsed" : "parse failed"}</summary>
        <p class="semanticizer-status">run <code>${escapeHtml(run.runId)}</code> ·
          capability <code>${escapeHtml(run.capabilityId)}</code> ·
          trace <code>${escapeHtml(run.traceSessionId)}</code> ·
          prompt <code>${escapeHtml(run.diagnostics.promptVersion)}</code></p>
        <details class="admin-raw"><summary>Request</summary>${json({
          model: run.diagnostics.model,
          parameters: run.diagnostics.parameters,
          instructions: run.diagnostics.instructions,
          input: safeJsonParse(run.diagnostics.input)
        })}</details>
        <details class="admin-raw"><summary>Raw response</summary><pre class="admin-json">${escapeHtml(
          run.rawResponse
        )}</pre></details>
        <details class="admin-raw"><summary>Parsed result</summary>${
          run.proposal ? json(run.proposal) : `<p class="ambiguity">${escapeHtml(run.parseError ?? "unknown")}</p>`
        }</details>
      </details>`
    )
    .join("");

  return panel(
    "Binding inference runs",
    `${bindingRuns.length} · candidate ${bindingCandidate?.state ?? "none"}`,
    `<p class="semanticizer-status">A separate question from semantic inference, asked with its own prompt:
      given the capability and the strongest evidence, which supported mechanism is worth investigating?</p>${runs}`
  );
}

function renderValidationRuns(): string {
  if (validationRuns.length === 0) {
    return panel(
      "Binding validation runs",
      "none yet",
      `<p class="semanticizer-status">Validate a binding candidate to record a run.</p>`
    );
  }

  const runs = validationRuns
    .map(
      (record, index) => `<details class="admin-run">
        <summary>Run #${index + 1} · <code>${escapeHtml(record.result.adapter)}</code> ·
          ${escapeHtml(record.result.status)}</summary>
        <p class="semanticizer-status">capability <code>${escapeHtml(record.result.capabilityId)}</code> ·
          ${escapeHtml(record.result.sourceApplication.label)} · ${escapeHtml(record.result.validatedAt)} ·
          state ${escapeHtml(record.state)}</p>
        <details class="admin-raw" open><summary>Checks</summary>${json(record.result.checks)}</details>
        <details class="admin-raw"><summary>Evidence and requirements</summary>${json({
          evidence: record.result.evidence,
          warnings: record.result.warnings,
          requirements: record.result.requirements
        })}</details>
        <details class="admin-raw"><summary>Resulting binding</summary>${
          record.result.binding ? json(record.result.binding) : "<p class=empty>No binding was created.</p>"
        }</details>
      </details>`
    )
    .join("");

  return panel(
    "Binding validation runs",
    `${validationRuns.length} · ${validation?.state ?? "none"}`,
    `<p class="semanticizer-status">Deterministic proof, or an account of why there is none. A validated
      mechanism still requires human acceptance before it becomes the execution binding.</p>${runs}`
  );
}

function renderReset(): string {
  return panel(
    "Reset",
    "destructive",
    `<p class="semanticizer-status">Clears every local Teach Mode trace, inference run, candidate and
      publication from this control plane. It does not touch the source application, its data, the
      extension, or any configuration, and everything it drops is already lost on restart.</p>
     <div class="studio-actions"><button id="reset-control-plane" class="secondary">Clear all traces and artifacts</button></div>`
  );
}

function renderComparison(): string {
  if (comparisonTraces.length === 0) {
    return panel(
      "Compare captures",
      "not loaded",
      `<p class="semanticizer-status">${escapeHtml(comparisonStatus)}</p>
       <div class="studio-actions"><button id="load-comparison" class="secondary">Load all captures</button></div>`
    );
  }

  const rows = comparisonTraces
    .flatMap((trace) => {
      const label = sourceApplicationFor(trace.application.platform, trace.application.host).label;
      const evidence = trace.executionEvidence ?? [];
      const runs = semanticizerRuns.filter((run) => run.traceSessionId === trace.sessionId);
      const candidate = runs[runs.length - 1]?.candidate;

      if (evidence.length === 0) {
        return [
          `<tr><td>${escapeHtml(label)}</td><td><code>${escapeHtml(trace.sessionId)}</code></td>
           <td colspan="5" class="empty">no network evidence</td>
           <td>${candidate ? escapeHtml(candidate.name) : "—"}</td></tr>`
        ];
      }

      return evidence.flatMap((entry) =>
        (entry.networkEffects ?? []).map(
          (effect) => `<tr>
            <td>${escapeHtml(label)}</td>
            <td><code>${escapeHtml(trace.sessionId)}</code></td>
            <td>${escapeHtml(entry.actionLabel ?? entry.action)}</td>
            <td><span>${escapeHtml(effect.method)}</span> <code>${escapeHtml(effect.pathPattern)}</code></td>
            <td>${effect.failed ? "failed" : effect.status} · +${effect.startedAfterMs}ms</td>
            <td class="effect-${escapeHtml(effect.confidence)}">${escapeHtml(effect.confidence)}${
              effect.backgroundLikely ? " · background" : ""
            }</td>
            <td>${(entry.applicationEffects ?? []).length ? escapeHtml((entry.applicationEffects ?? []).join(", ")) : "—"}</td>
            <td>${
              candidate
                ? `${escapeHtml(candidate.name)} <small>(${candidate.inputs.map((input) => escapeHtml(input.name)).join(", ")})</small>`
                : "—"
            }</td>
          </tr>`
        )
      );
    })
    .join("");

  return panel(
    "Compare captures",
    `${comparisonTraces.length} loaded`,
    `<p class="semanticizer-status">${escapeHtml(comparisonStatus)}</p>
     <div class="table-scroll"><table class="comparison">
       <thead><tr><th>Application</th><th>Session</th><th>Action</th><th>Request</th><th>Result</th>
         <th>Confidence</th><th>Application reaction</th><th>Proposed capability</th></tr></thead>
       <tbody>${rows}</tbody>
     </table></div>
     <div class="studio-actions"><button id="load-comparison" class="secondary">Reload captures</button></div>`
  );
}

function renderAdminDebug(): string {
  const body = selectedTrace
    ? `${renderTraceIdentity(selectedTrace)}${renderCaptureStream(selectedTrace)}${renderNormalizedPanel(selectedTrace)}${renderEvidencePanel(selectedTrace)}${renderSemanticizerRuns()}${renderBindingRuns()}${renderValidationRuns()}${renderDomainProvenance()}${renderLifecyclePanel()}${renderExportPanel()}${renderComparison()}${renderReset()}`
    : `<p class="semanticizer-status">Select a Teach Mode capture to inspect what was observed and transformed.</p>
       ${renderSemanticizerRuns()}${renderBindingRuns()}${renderValidationRuns()}${renderDomainProvenance()}${renderExportPanel()}${renderComparison()}${renderReset()}`;

  return `<details class="admin-debug">
    <summary>Admin / Debug</summary>
    <p class="semanticizer-status">Everything AutoWebMCP observed, transformed, sent to the model, and read back.
      Development observability: it reads the pipeline and never changes it.</p>
    ${body}
  </details>`;
}

function renderTrainingStudio(): string {
  const candidateEditor = candidate
    ? (() => {
        const capability = candidate;
        const confirmed = capability.provenance.confirmedByHuman;
        const advertisedBound = Boolean(resolveAdvertisedBinding(capability));
        const published = publications.some((record) => record.capability.id === capability.id);
        const view = deriveStudioLifecycle({
          capability,
          advertisedBound,
          bindingCandidate,
          validation,
          browserBindingCandidate,
          browserBindingValidation,
          queryAccepted,
          published
        });

        return `<form id="candidate-editor" class="candidate-editor">
        <div class="panel-heading"><div><p class="eyebrow">Candidate capability</p><h2>Review before publication</h2></div><span>Human confirmation required</span></div>
        ${renderLifecycleStages(view)}
        <label>Capability name<input name="name" value="${escapeHtml(capability.name)}" /></label>
        <label>Description<textarea name="description">${escapeHtml(capability.description)}</textarea></label>
        ${renderTargetIdentityInputs(capability)}
        <div class="input-list">${capability.inputs
          .map((input, index) =>
            input.role === "target-identity"
              ? ""
              : `<div><label>Parameter <input name="input-name-${index}" value="${escapeHtml(input.name)}" /></label><label>Type <select name="input-type-${index}">${(["string", "date", "number", "boolean"] as const)
              .map((type) => `<option value="${type}" ${input.type === type ? "selected" : ""}>${type}</option>`)
              .join("")}</select></label><label class="checkbox"><input name="input-required-${index}" type="checkbox" ${input.required ? "checked" : ""} /> Required</label></div>`
          )
          .join("")}</div>
        ${ambiguities.length ? `<p class="ambiguity">Review: ${ambiguities.map(escapeHtml).join(" · ")}</p>` : ""}
        ${renderSemanticGrounding()}
        <div class="studio-actions">
          <button type="submit">Save changes</button>
          ${confirmed ? "" : `<button type="button" id="confirm-capability">Confirm capability</button>`}
          <p class="semanticizer-status">${escapeHtml(semanticizerStatus)}</p>
        </div>
        ${renderExecutionStage(capability, view)}
        ${renderValidationStage(view)}
        ${renderBrowserExecutionStage(view)}
        ${renderBrowserValidationStage(view)}
        ${renderQueryStage(capability)}
        ${renderPublicationStage(view)}
      </form>`;
      })()
    : "";

  return `<section class="training-studio" aria-label="Training Studio">
    ${renderExtensionTraces()}
    ${candidateEditor}
    ${renderPublications()}
    ${renderAdminDebug()}
  </section>`;
}

/** One control, built from the published schema and nothing else. */
function renderHarnessControl(field: HarnessField): string {
  const value = harnessValues[field.name] ?? "";
  const id = `wm-${field.name}`;
  switch (field.control) {
    case "enum":
      return `<select id="${id}" data-harness-input="${escapeHtml(field.name)}">
        <option value="">Choose…</option>
        ${(field.options ?? [])
          .map(
            (option) =>
              `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`
          )
          .join("")}
      </select>`;
    case "date":
      return `<input id="${id}" type="date" data-harness-input="${escapeHtml(field.name)}" value="${escapeHtml(value)}" />`;
    case "number":
    case "integer":
      return `<input id="${id}" type="number" ${field.control === "integer" ? 'step="1"' : ""}
        data-harness-input="${escapeHtml(field.name)}" value="${escapeHtml(value)}" />`;
    case "boolean":
      return `<input id="${id}" type="checkbox" data-harness-input="${escapeHtml(field.name)}" ${
        value === "true" ? "checked" : ""
      } />`;
    case "unsupported":
      // Shown, never guessed at. A control that sent the wrong shape would
      // be worse than an honest gap.
      return `<p class="ambiguity">This test form cannot render this parameter's schema:</p>
        <pre class="admin-json">${escapeHtml(field.rawSchema ?? "")}</pre>`;
    default:
      return `<input id="${id}" type="text" data-harness-input="${escapeHtml(field.name)}" value="${escapeHtml(value)}" />`;
  }
}

/** The four facts, per input, exactly as the execution engine established them. */
function renderHarnessTransactions(outcome: HarnessInvocationOutcome): string {
  const transactions = outcome.execution?.transactions ?? [];
  if (transactions.length === 0) return "";
  const verdictLabel = { verified: "verified", mismatch: "MISMATCH", unverifiable: "not verifiable" };
  return `<div class="table-scroll"><table class="comparison">
    <thead><tr><th>Input</th><th>Before</th><th>Requested</th><th>After write</th><th>After save</th><th>Verified</th></tr></thead>
    <tbody>${transactions
      .map((transaction) => {
        const verdict = verdictFor(transaction);
        return `<tr>
          <td><code>${escapeHtml(transaction.name)}</code>${
            transaction.apiName ? `<br><small>${escapeHtml(transaction.apiName)}</small>` : ""
          }</td>
          <td>${escapeHtml(transaction.beforeValue ?? "—")}</td>
          <td>${escapeHtml(transaction.requestedValue)}</td>
          <td>${escapeHtml(transaction.afterWriteValue ?? "—")}</td>
          <td>${escapeHtml(transaction.afterSaveValue ?? "—")}</td>
          <td class="${verdict === "verified" ? "check-pass" : verdict === "mismatch" ? "check-fail" : "check-blocked"}">
            <strong>${verdictLabel[verdict]}</strong>
          </td>
        </tr>`;
      })
      .join("")}</tbody>
  </table></div>`;
}

/** A search's answer: the candidates, and the identity each one hands on. */
function renderHarnessCandidates(outcome: HarnessInvocationOutcome): string {
  const query = outcome.query;
  if (!query) return "";
  if (query.candidates.length === 0) {
    return `<p class="semanticizer-status">${escapeHtml(
      query.warnings.join(" ") || "The search found nothing."
    )}</p>`;
  }
  return `<div class="table-scroll"><table class="comparison">
      <thead><tr><th>Name</th><th>Type</th><th>Identity</th></tr></thead>
      <tbody>${query.candidates
        .map(
          (candidate) =>
            `<tr><td>${escapeHtml(candidate.name)}</td><td>${escapeHtml(candidate.entityType)}</td>
             <td><code>${escapeHtml(candidate.id)}</code></td></tr>`
        )
        .join("")}</tbody>
    </table></div>
    ${query.warnings.length ? `<p class="ambiguity">${query.warnings.map(escapeHtml).join(" ")}</p>` : ""}`;
}

function renderHarnessResult(): string {
  if (!harnessOutcome) return "";
  const execution = harnessOutcome.execution;
  const checks = execution?.checks ?? [];

  return `<div class="lifecycle-section">
    <p class="eyebrow">Invocation result</p>
    <p class="semanticizer-status">${escapeHtml(
      harnessOutcome.route === "webmcp"
        ? "Invoked through the browser's WebMCP API — the same call an agent makes."
        : "Run directly against the capability, bypassing WebMCP."
    )}</p>
    ${
      harnessOutcome.unparsed
        ? `<p class="ambiguity">${escapeHtml(harnessOutcome.unparsed)}</p>
           <pre class="admin-json">${escapeHtml(harnessOutcome.text)}</pre>`
        : ""
    }
    ${execution || harnessOutcome.query ? `<p><strong>${escapeHtml(describeOutcome(harnessOutcome))}</strong></p>` : ""}
    ${renderHarnessCandidates(harnessOutcome)}
    ${renderHarnessTransactions(harnessOutcome)}
    ${
      checks.length
        ? `<ul class="reasons">${checks
            .map(
              (check) =>
                `<li class="check-${check.status === "pass" ? "pass" : check.status === "fail" ? "fail" : "skipped"}">
                  <strong>${check.status.toUpperCase()}</strong> ${escapeHtml(check.name)} — ${escapeHtml(check.detail)}
                </li>`
            )
            .join("")}</ul>`
        : ""
    }
    ${
      execution?.warnings.length
        ? `<ul class="reasons">${execution.warnings.map((warning) => `<li class="ambiguity">${escapeHtml(warning)}</li>`).join("")}</ul>`
        : ""
    }
    <details class="admin-raw"><summary>Raw tool response</summary>
      <pre class="admin-json">${escapeHtml(harnessOutcome.text)}</pre>
    </details>
  </div>`;
}

/**
 * The judge's panel.
 *
 * Every claim here is gated on what `describeWebMcpSurface` actually
 * found. Where the browser cannot answer, the panel says so instead of
 * substituting something that looks equivalent.
 */
function renderWebMcpHarness(): string {
  if (!webMcpSurface.available) {
    return `<div class="lifecycle-section">
      <p class="eyebrow">WebMCP</p>
      <p><strong>WebMCP is not available in this browser.</strong></p>
      <p class="semanticizer-status">This page needs a browser exposing <code>document.modelContext</code> —
        Chrome with <code>chrome://flags/#enable-webmcp-testing</code> enabled, or another WebMCP-capable client.
        Nothing below can be shown honestly without it.</p>
    </div>`;
  }

  const tools = discoveredTools.filter((tool) => tool.name !== "hello_webmcp");
  const tool = selectedTool();
  const fields = selectedToolFields();

  const surfaceNote = webMcpSurface.canDiscover
    ? `Listed by <code>document.modelContext.getTools()</code> — the browser's own answer about what an agent can see.`
    : `This browser does not let a page enumerate WebMCP tools, so the list below is what this document
       passed to <code>registerTool()</code>. That is evidence of registration, not of agent-side discovery.`;

  const listing = webMcpSurface.canDiscover
    ? tools.length
      ? `<ul class="reasons">${tools
          .map(
            (entry) =>
              `<li><code>${escapeHtml(entry.name)}</code>${entry.description ? ` — ${escapeHtml(entry.description)}` : ""}</li>`
          )
          .join("")}</ul>`
      : `<p class="semanticizer-status">No published capability is registered on this document yet.
           Publish one in the Studio, then reload this page.</p>`
    : `<ul class="reasons">${
        browserExecutionRegistered.size
          ? [...browserExecutionRegistered].map((id) => `<li><code>${escapeHtml(id)}</code></li>`).join("")
          : `<li>Nothing registered yet.</li>`
      }</ul>`;

  // Normalized before display too: showing the browser's raw string would
  // render an escaped blob, which is what first revealed the shape.
  const normalizedSchema = normalizeInputSchema(tool?.inputSchema);
  const schema = normalizedSchema
    ? `<details class="admin-raw" open><summary>Agent-facing input schema</summary>
        <pre class="admin-json">${escapeHtml(JSON.stringify(normalizedSchema, null, 2))}</pre>
      </details>`
    : "";

  const form = tool
    ? `<div class="test-form">
        ${fields
          .map(
            (field) => `<label>${escapeHtml(field.name)}${field.required ? " *" : ""}
              ${field.description ? `<small class="domain-unknown">${escapeHtml(field.description)}</small>` : ""}
              ${renderHarnessControl(field)}
            </label>`
          )
          .join("")}
        ${harnessErrors.length ? `<p class="ambiguity">${harnessErrors.map(escapeHtml).join(" · ")}</p>` : ""}
        <div class="studio-actions">
          ${
            webMcpSurface.canInvoke
              ? `<button type="button" id="invoke-webmcp" ${isWorking(operations, "invoke-webmcp") ? "disabled" : ""}>
                   ${isWorking(operations, "invoke-webmcp") ? "Invoking…" : "Invoke via WebMCP"}
                 </button>`
              : ""
          }
        </div>
        ${renderOperationStatus("invoke-webmcp", harnessStatus)}
        ${
          webMcpSurface.canInvoke
            ? ""
            : `<p class="ambiguity">This browser does not let a page invoke a WebMCP tool — invocation is the
                 agent's to make. Call <code>${escapeHtml(tool.name)}</code> from a WebMCP-capable agent or the
                 Model Context Tool Inspector to exercise it. Nothing here will run it and call that WebMCP.</p>`
        }
      </div>`
    : "";

  return `<div class="lifecycle-section">
    <p class="eyebrow">WebMCP</p>
    <p><strong>Registered on this document</strong> — <code>${escapeHtml(window.location.origin)}</code></p>
    <p class="semanticizer-status">${surfaceNote}</p>
    ${discoveryError ? `<p class="ambiguity">${escapeHtml(discoveryError)}</p>` : ""}
    ${listing}
    ${
      tools.length > 1
        ? `<label>Tool to test
            <select id="harness-tool">${tools
              .map(
                (entry) =>
                  `<option value="${escapeHtml(entry.name)}" ${entry.name === selectedToolName ? "selected" : ""}>${escapeHtml(entry.name)}</option>`
              )
              .join("")}</select>
          </label>`
        : ""
    }
    ${schema}
    ${form}
    ${renderHarnessResult()}
  </div>`;
}

/**
 * Control-mode event wiring.
 *
 * Separate from the Studio's own `bindEvents` because the two documents
 * render entirely different pages; sharing one binder would mean querying
 * for controls that cannot exist.
 */
function bindHarnessEvents(): void {
  for (const control of document.querySelectorAll<HTMLElement>("[data-harness-input]")) {
    const commit = (event: Event): void => {
      const element = event.currentTarget as HTMLInputElement | HTMLSelectElement;
      const name = element.getAttribute("data-harness-input");
      if (!name) return;
      harnessValues = {
        ...harnessValues,
        [name]:
          element instanceof HTMLInputElement && element.type === "checkbox" ? String(element.checked) : element.value
      };
    };
    // Held without re-rendering: render() rebuilds innerHTML and would take
    // the focus out of the control mid-entry.
    control.addEventListener("change", commit);
    control.addEventListener("input", commit);
  }

  document.querySelector<HTMLSelectElement>("#harness-tool")?.addEventListener("change", (event) => {
    selectedToolName = (event.currentTarget as HTMLSelectElement).value;
    harnessValues = {};
    harnessErrors = [];
    harnessOutcome = undefined;
    render();
  });

  document.querySelector<HTMLButtonElement>("#invoke-webmcp")?.addEventListener("click", () => {
    void invokeSelectedTool();
  });
}

function render(): void {
  if (controlMode) {
    appRoot.innerHTML = `
      <main class="control-shell">
        <p class="eyebrow">AutoWebMCP · WebMCP surface</p>
        <h1>Test a published capability</h1>
        <p>Capabilities published in the Studio are registered on this document as real WebMCP tools.
          This page exercises them through the browser's own WebMCP API — the same surface an agent uses.</p>
        <p class="semanticizer-status">The tool runs against the application it was taught from, through the
          Teach Mode extension. AutoWebMCP Studio publishes the capability; the target application does not host
          it. Start the extension on that application's tab before invoking.</p>
        ${renderWebMcpHarness()}
        <dl class="diagnostics">
          <div><dt>document.modelContext</dt><dd>${document.modelContext ? "available" : "unavailable"}</dd></div>
          <div><dt>Page-side discovery</dt><dd>${webMcpSurface.canDiscover ? "supported" : "not supported"}</dd></div>
          <div><dt>Page-side invocation</dt><dd>${webMcpSurface.canInvoke ? "supported" : "not supported"}</dd></div>
          <div><dt>crossOriginIsolated</dt><dd>${String(window.crossOriginIsolated)}</dd></div>
          <div><dt>Hello-world registration</dt><dd>${registration}</dd></div>
        </dl>
        <a href="/">Return to the Training Studio</a>
      </main>`;
    bindHarnessEvents();
    return;
  }

  appRoot.innerHTML = `
    <header class="topbar">
      <a class="brand" href="/">Auto<span>WebMCP</span></a>
      <div class="runtime-status ${registration === "unavailable" ? "" : "registered"}">
        <span></span> WebMCP ${registration === "unavailable" ? "unavailable in this browser" : "available in this browser"}
      </div>
    </header>
    <main>
      <section class="hero">
        <p class="eyebrow">Training Studio</p>
        <h1>Teach a workflow. Publish a capability.</h1>
        <p>Understand what a human demonstrated, bind it to behaviour the application already has,
        and publish it for agents. Evidence arrives from the Teach Mode extension as a captured trace.</p>
        <div class="studio-links"><a href="/prospect/">Open SignalBase &#8599;</a><a href="/?control=1">WebMCP control</a></div>
        ${captureMode ? `<p id="capture-probe-status" class="runtime-status registered">rrweb probe active · raw events remain in memory and inputs are masked</p>` : ""}
      </section>
      ${renderConnectionBanner()}
      ${renderTrainingStudio()}
    </main>`;

  document.querySelector<HTMLButtonElement>("#refresh-traces")?.addEventListener("click", () =>
    void withBusy("refresh-traces", async () => {
    traceStatus = "Loading extension traces…";
    connectionIssue = undefined;
    render();
    try {
      extensionTraces = await listTraces();
      traceStatus = extensionTraces.length
        ? "Select a capture to review its normalized evidence."
        : "No traces yet. Start and stop a training session in the extension.";
    } catch (error) {
      traceStatus = describeActionFailure("Refreshing traces", error);
    }
    render();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-trace-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      connectionIssue = undefined;
      try {
        selectedTrace = await getTrace(button.dataset.traceId ?? "");
        traceStatus = `Loaded ${selectedTrace.observations.length} observations from ${selectedTrace.application.host}.`;
      } catch (error) {
        traceStatus = describeActionFailure("Loading that trace", error);
      }
      // A newly selected capture has its own capability, execution, and
      // validation story; the previous one's does not carry over.
      candidate = undefined;
      ambiguities = [];
      clearExecutionState();
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#save-trace-details")?.addEventListener("click", async () => {
    if (!selectedTrace) return;
    const name = document.querySelector<HTMLInputElement>("#trace-name")?.value ?? "";
    const description = document.querySelector<HTMLTextAreaElement>("#trace-description")?.value ?? "";
    connectionIssue = undefined;
    try {
      await updateTraceRecording(selectedTrace.sessionId, { name, description });
      // Metadata only: the local trace object keeps its identity and every
      // piece of evidence; only what the human calls it changes.
      selectedTrace = withRecordingMetadata(selectedTrace, { name, description });
      extensionTraces = await listTraces();
      traceDetailsStatus = "Recording details saved.";
    } catch (error) {
      traceDetailsStatus = describeActionFailure("Saving recording details", error);
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#semanticize-extension-trace")?.addEventListener("click", () =>
    void withBusy("propose-capability", async () => {
    if (!selectedTrace) return;
    traceStatus = "Proposing a bounded candidate capability from extension evidence…";
    connectionIssue = undefined;
    render();
    try {
      const run = await semanticizeTrace({
        traceKind: "extension",
        traceSessionId: selectedTrace.sessionId,
        application: selectedTrace.application.host,
        platform: selectedTrace.application.platform,
        trace: selectedTrace.observations,
        uiLabels: selectedTrace.labels
      });
      // Every run is kept, including one the parser rejected. Re-proposing
      // must not erase the evidence of what the previous attempt returned.
      semanticizerRuns = [...semanticizerRuns, run];

      if (!run.candidate) {
        traceStatus = `The model responded, but the candidate could not be parsed: ${run.parseError}`;
        semanticizerStatus = "See Admin / Debug for the raw response.";
        render();
        return;
      }

      const proposed = run.candidate;
      // A freshly proposed capability starts its own execution/validation
      // story; whatever the previous candidate had is not this one's.
      clearExecutionState();

      candidate = {
        ...proposed,
        provenance: {
          ...proposed.provenance,
          sourceApplication: sourceApplicationFor(
            selectedTrace.application.platform,
            selectedTrace.application.host
          )
        }
      };
      // The model named the inputs after the labels this org happens to
      // use. Grounding settles what those labels actually are, and moves
      // any input the application's own model identifies onto the vendor's
      // vocabulary — all of it before a human confirms, because these names
      // are what an agent will see.
      runSemanticGrounding();
      ambiguities = run.ambiguities;
      traceStatus = groundingNeeds.length
        ? "Candidate ready for review. Answer the outstanding question first — it decides the parameter names."
        : "Candidate ready for human review.";
      semanticizerStatus = `Candidate proposed from extension trace ${selectedTrace.sessionId}.`;
    } catch (error) {
      traceStatus = describeActionFailure("Candidate generation", error);
    }
    render();
  }));

  /** One read of the editor, so changing the binding never discards typed edits. */
  function applyCandidateEdits(element: HTMLFormElement): void {
    if (!candidate) return;
    const form = new FormData(element);
    const binding = String(form.get("binding") ?? "");
    const [application, action] = binding.split(":");

    const edited: SemanticCapability = {
      ...candidate,
      name: String(form.get("name") ?? candidate.name),
      description: String(form.get("description") ?? candidate.description),
      inputs: candidate.inputs.map((input, index) => {
        // Targeting parameters render as text, not as form controls, so the
        // form carries no values for them. Reading their absence as edits
        // would quietly clear `required` on the one input that must never
        // be optional.
        if (input.role === "target-identity") return input;
        const type = String(form.get(`input-type-${index}`) ?? input.type);
        return {
          ...input,
          name: String(form.get(`input-name-${index}`) ?? input.name),
          type: (["string", "date", "number", "boolean"] as const).includes(type as never)
            ? (type as (typeof input)["type"])
            : input.type,
          required: form.get(`input-required-${index}`) === "on"
        };
      })
    };

    if (application && action) edited.binding = { application, action };
    else delete edited.binding;

    // The binding is not part of what a human confirmed, so changing it leaves
    // confirmation standing. Changing the contract itself does not.
    if (candidate.provenance.confirmedByHuman && semanticContract(edited) !== semanticContract(candidate)) {
      edited.provenance = { ...edited.provenance, source: "inferred", confirmedByHuman: false };
      semanticizerStatus = "The contract changed, so confirmation was withdrawn. Review and confirm again.";
    }
    candidate = edited;
  }

  document.querySelector<HTMLFormElement>("#candidate-editor")?.addEventListener("submit", (event) => {
    event.preventDefault();
    applyCandidateEdits(event.currentTarget as HTMLFormElement);
    // Confirming only needs the contract to be right — execution is a
    // separate, later step, whichever route it ends up taking.
    semanticizerStatus = "Changes saved. Confirm when the description and parameters are correct.";
    render();
  });

  document.querySelector<HTMLSelectElement>("#candidate-editor select[name=binding]")?.addEventListener(
    "change",
    (event) => {
      const form = (event.currentTarget as HTMLSelectElement).form;
      if (!form) return;
      applyCandidateEdits(form);
      render();
    }
  );

  // Confirmation is its own step. It records that a human accepted the contract
  // and unlocks publication; it does not put a tool on any site.
  document.querySelector<HTMLButtonElement>("#confirm-capability")?.addEventListener("click", () => {
    if (!candidate) return;

    // Confirmation answers "did we understand this correctly", nothing more.
    // A capability can be understood on an application we cannot yet drive.
    candidate = confirmCandidate(candidate);
    semanticizerStatus = resolveAdvertisedBinding(candidate)
      ? "Meaning confirmed and an execution path is already available. Ready to publish."
      : "Meaning confirmed. Next: find or select how this capability should execute.";
    render();
  });

  // Publication is the moment the taught site gains a capability. The Studio
  // hands the confirmed contract to the control plane; the site compiles it.
  document.querySelector<HTMLButtonElement>("#suggest-query")?.addEventListener("click", () => {
    if (!candidate || !selectedTrace) return;
    queryProposal = proposeQueryBinding(
      candidate,
      selectedTrace,
      entityIdentityPolicyForPlatform(selectedTrace.application.platform)
    );
    queryOutcome = undefined;
    queryAccepted = false;
    queryStatus = "";
    render();
  });

  const term = document.querySelector<HTMLInputElement>("#query-term");
  // Held without re-rendering, so typing is not interrupted.
  term?.addEventListener("input", () => {
    queryTerm = term.value;
  });

  document.querySelector<HTMLButtonElement>("#run-query")?.addEventListener("click", () => {
    const binding = queryProposal?.binding;
    if (!binding) return;
    void runOperation("run-query", "Searching the application…", async () => {
      queryOutcome = await extensionBridgeExecutionClient.query(binding, { [binding.query.inputName]: queryTerm });
      return {
        message:
          queryOutcome.candidates.length > 0
            ? `Found ${queryOutcome.candidates.length} candidate(s).`
            : "The search returned no candidates."
      };
    });
  });

  document.querySelector<HTMLButtonElement>("#accept-query")?.addEventListener("click", () => {
    // The same judgement accepting a mutation binding is: a human saw it
    // return real candidates from the real application.
    queryAccepted = true;
    // Publication reads the capability's own binding, so accepting a
    // search records one — the same step accepting an execution binding
    // takes, for the same reason.
    const source = candidate?.provenance.sourceApplication;
    if (candidate && source) candidate = { ...candidate, binding: { application: source.id, action: candidate.id } };
    queryStatus = "Search accepted. Publication is now unblocked.";
    render();
  });

  document.querySelector<HTMLButtonElement>("#publish-capability")?.addEventListener("click", () =>
    void withBusy("publish-capability", async () => {
    if (!candidate) return;
    publishStatus = "Publishing…";
    connectionIssue = undefined;
    render();
    try {
      // Whatever the value domains resolved to — the org's own tenant
      // metadata, or what the live control offered — belongs in the
      // contract an agent will read. Resolving them and then publishing a
      // bare string is how the first live publication shipped a `stage`
      // input with no legal values on it.
      const accepted = acceptedBrowserBinding(browserBindingValidation);
      const domains: Record<string, string[]> = {};
      for (const input of accepted?.inputs ?? []) {
        const declared = input.applicationField?.options;
        if (declared?.length) domains[input.semanticInput] = [...declared];
      }
      for (const [name, values] of Object.entries(liveValueDomains)) {
        if (values.length) domains[name] = [...values];
      }
      // A search publishes its own binding. Accepting it is the same
      // judgement accepting a mutation binding is: a human saw it return
      // real candidates from the real application.
      const query = queryAccepted ? queryProposal?.binding ?? undefined : undefined;
      const record = await publishCapability(
        withResolvedValueDomains(candidate, domains),
        accepted,
        query ?? undefined
      );
      publications = await listPublishedCapabilities();
      syncBrowserExecutionRegistrations();
      publishStatus = `Published ${record.capability.id}. Reload or return to the taught site to see it registered.`;
    } catch (error) {
      publishStatus = describeActionFailure("Publishing", error);
    }
    render();
  }));

  document.querySelector<HTMLButtonElement>("#generate-binding")?.addEventListener("click", async () => {
    if (!candidate || !selectedTrace) return;
    bindingStatus = "Looking for an execution path in the strongest evidence…";
    connectionIssue = undefined;
    // A new suggestion supersedes whatever was validated for the previous
    // one; that proof does not carry over to a different candidate.
    clearExecutionState();
    render();
    try {
      const result = await inferBindingCandidate(candidate, selectedTrace, selectedTrace.observations);
      if (result.run) bindingRuns = [...bindingRuns, result.run];
      bindingCandidate = { state: "proposed", proposal: result.proposal };
      bindingStatus = result.proposal.candidate
        ? "Execution path suggested. It is a lead to validate, not a binding."
        : "No safe execution path was found from this evidence.";
    } catch (error) {
      bindingStatus = describeActionFailure("Execution analysis", error);
    }
    render();
  });

  // "Validate this execution path" both marks the suggestion as investigated
  // and runs the validator, as one action: nothing currently reads the
  // intermediate "accepted-for-validation" state as a precondition for
  // anything else, so presenting it as a separate click only added a step
  // that looked like it should mean something and did not.
  document.querySelector<HTMLButtonElement>("#validate-binding")?.addEventListener("click", () =>
    void withBusy("validate-binding", async () => {
    if (!candidate || !selectedTrace || !bindingCandidate) return;
    bindingCandidate = { ...bindingCandidate, state: "accepted-for-validation" };
    validationStatus = "Validating the suggested execution path…";
    connectionIssue = undefined;
    render();

    const mapping = resolveFieldMapping(candidate, selectedTrace);
    const recordType = observedRecordType(selectedTrace);
    try {
      const result = await runBindingValidation(
        {
          capabilityId: candidate.id,
          capabilityInputs: candidate.inputs.map((input) => ({ name: input.name, required: input.required })),
          sourceApplication: candidate.provenance.sourceApplication ?? { id: "unknown", label: "Unknown application" },
          candidate: bindingCandidate.proposal,
          fieldMapping: mapping.mapping,
          fieldMappingAmbiguities: mapping.ambiguities,
          ...(recordType ? { observedRecordType: recordType } : {}),
          validatedAt: new Date().toISOString()
        },
        defaultValidators
      );

      validation = { state: result.status === "validated" ? "validated" : "none", result };
      validationRuns = [...validationRuns, validation];
      validationStatus =
        result.status === "validated"
          ? "Validated. Accept it to make it the execution binding."
          : `Validation result: ${result.status}. No execution binding was created.`;
    } catch (error) {
      validationStatus = describeActionFailure("Validation", error);
    }
    render();
  }));

  document.querySelector<HTMLButtonElement>("#accept-binding")?.addEventListener("click", () => {
    if (!candidate || !validation?.result.binding) return;
    const operation = validation.result.binding.operation;
    // Technical proof and product approval are different decisions.
    validation = { ...validation, state: "accepted" };
    // Publication's gate reads `capability.binding`, the same field the
    // SignalBase picker below sets — an accepted binding from this route
    // must populate it too, or the button this unlocks would fail the
    // moment it were clicked.
    const source = candidate.provenance.sourceApplication;
    if (source) candidate = { ...candidate, binding: { application: source.id, action: operation || candidate.id } };
    validationStatus = "Execution binding accepted. Publication is now unblocked.";
    render();
  });

  document.querySelector<HTMLButtonElement>("#reject-binding-candidate")?.addEventListener("click", () => {
    if (!bindingCandidate) return;
    bindingCandidate = { ...bindingCandidate, state: "rejected" };
    // A rejected suggestion's evidence is not a reason to keep whatever it
    // might have already been validated against.
    validation = undefined;
    validationStatus = "";
    bindingStatus = "Suggestion rejected. Suggest another execution path, or select one manually below.";
    render();
  });

  // Deterministic — built entirely from evidence the capture already
  // recorded, the same evidence `fieldMapping.ts` reads. No model call, so
  // there is nothing to wait on and nothing that can time out here.
  // Answering an epistemic need. Both paths go through the same recording
  // step, so a confirmed suggestion and a typed answer carry identical
  // human provenance — a suggestion the system offered is still only a
  // suggestion until a person accepts it.
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-accept-suggestion]")) {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.acceptSuggestion);
      const from =
        button.dataset.needSource === "grounding" ? groundingNeeds : (browserBindingCandidate?.proposal.needs ?? []);
      const need = from[Number(button.dataset.needIndex)];
      const suggestion = need?.suggestedAnswers?.[index];
      if (!suggestion) return;
      recordClarification(button.dataset.needLabel ?? "", button.dataset.needObject ?? "", suggestion.value);
    });
  }

  for (const input of document.querySelectorAll<HTMLInputElement>("input.clarification-answer")) {
    input.addEventListener("input", () => {
      // Held without re-rendering: render() rebuilds innerHTML and would
      // take the focus out of the field mid-answer. Keyed per question, so
      // typing an answer to one does not appear inside another.
      clarificationDraft = { ...clarificationDraft, [input.id]: input.value };
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("button.not-a-record-field")) {
    button.addEventListener("click", () => {
      const name = button.dataset.inputName;
      if (!candidate || !name) return;
      // Reclassified, not answered: the input keeps its name and stops
      // being something grounding looks for a record field behind.
      candidate = {
        ...candidate,
        inputs: candidate.inputs.map((input) => (input.name === name ? { ...input, role: "query" as const } : input))
      };
      runSemanticGrounding();
      semanticizerStatus = `"${name}" is now treated as a search term rather than a field on the record.`;
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("button.submit-clarification")) {
    button.addEventListener("click", () => {
      const input = document.querySelector<HTMLInputElement>(`#${CSS.escape(button.dataset.answerId ?? "")}`);
      if (!input) return;
      recordClarification(input.dataset.needLabel ?? "", input.dataset.needObject ?? "", input.value);
    });
  }

  document.querySelector<HTMLButtonElement>("#suggest-browser-binding")?.addEventListener("click", () =>
    void withBusy("suggest-binding", async () => {
    if (!candidate || !selectedTrace) return;
    browserBindingValidation = undefined;
    browserValidationStatus = "";
    runBrowserBindingProposal();
    render();
  }));

  // A real write against the live page: gathers the values to test with,
  // requires an explicit confirmation beyond the click itself, then runs the
  // engine through the Teach Mode extension's live tab access.
  // `browserBindingStatus` drives the Semantic Browser Execution panel's own
  // caption, which is always on screen; `browserValidationStatus` drives the
  // separate Test Result section, which only exists once a result object
  // does. Every branch below sets both, so a cancellation or an early
  // failure — which never produces a result — is still visible somewhere,
  // instead of silently updating a variable with no render path.
  // The typed test form: values collect silently (no re-render per
  // keystroke — a full innerHTML rebuild would eat focus), validation and
  // canonicalization run BEFORE the confirmation, and the confirmation
  // summarizes what will be done rather than asking for anything.
  for (const control of document.querySelectorAll<HTMLElement>("[data-test-input]")) {
    control.addEventListener("change", (event) => {
      const element = event.currentTarget as HTMLInputElement | HTMLSelectElement;
      const name = element.getAttribute("data-test-input");
      if (!name) return;
      browserTestValues = {
        ...browserTestValues,
        [name]: element instanceof HTMLInputElement && element.type === "checkbox"
          ? String(element.checked)
          : element.value
      };
    });
  }

  // Retrying, and the Admin / Debug affordance, both re-enter the same
  // automatic acquisition. There is no separate manual mechanism.
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-acquire-domains]")) {
    button.addEventListener("click", () => {
      domainAcquisitionFor = undefined;
      void acquireValueDomains();
    });
  }

  document.querySelector<HTMLButtonElement>("#run-browser-test")?.addEventListener("click", () =>
    void withBusy("run-browser-test", async () => {
    const binding = browserBindingCandidate?.proposal.binding;
    if (!candidate || !binding) return;

    const fields = buildTestFormFields(candidate, binding, liveValueDomains);
    const validation = validateTestInputs(fields, browserTestValues);
    if (!validation.ok) {
      // Invalid or missing required inputs block here — the target
      // application has not been touched.
      browserTestErrors = validation.errors;
      render();
      return;
    }
    browserTestErrors = [];
    const inputs = validation.values;

    const confirmed = window.confirm(
      summarizeExecutionPlan(
        fields,
        inputs,
        binding.commit.semanticAction.label,
        binding.sourceApplication.label
      )
    );
    if (!confirmed) {
      browserBindingStatus = "Test cancelled.";
      browserValidationStatus = "Test cancelled.";
      render();
      return;
    }

    browserBindingStatus = "Testing browser execution — writing through the live page…";
    browserValidationStatus = browserBindingStatus;
    connectionIssue = undefined;
    render();
    try {
      const result = await extensionBridgeExecutionClient.execute(binding, inputs);
      browserBindingCandidate = browserBindingCandidate ? { ...browserBindingCandidate, state: "tested" } : undefined;
      browserBindingValidation = { state: "tested", binding, result };
      browserBindingStatus = `Test finished: ${result.status}.`;
      browserValidationStatus = browserBindingStatus;
    } catch (error) {
      browserBindingStatus = error instanceof Error ? error.message : "Browser execution test failed.";
      browserValidationStatus = browserBindingStatus;
    }
    render();
  }));

  document.querySelector<HTMLButtonElement>("#accept-browser-binding")?.addEventListener("click", () => {
    if (!candidate || !browserBindingValidation) return;
    // Technical proof and product approval are different decisions, the same
    // rule the supported-API route follows above.
    browserBindingValidation = { ...browserBindingValidation, state: "accepted" };
    if (browserBindingCandidate) browserBindingCandidate = { ...browserBindingCandidate, state: "accepted" };
    const source = candidate.provenance.sourceApplication;
    if (source) candidate = { ...candidate, binding: { application: source.id, action: candidate.id } };
    browserValidationStatus = "Execution binding accepted. Publication is now unblocked.";
    render();
  });

  document.querySelector<HTMLButtonElement>("#reject-browser-binding")?.addEventListener("click", () => {
    if (!browserBindingCandidate) return;
    browserBindingCandidate = { ...browserBindingCandidate, state: "rejected" };
    browserBindingValidation = undefined;
    browserValidationStatus = "";
    browserBindingStatus = "Suggestion rejected.";
    render();
  });

  document.querySelector<HTMLButtonElement>("#reset-control-plane")?.addEventListener("click", async () => {
    const confirmed = window.confirm(
      "This clears all local AutoWebMCP Teach Mode traces, inference runs, candidates and publications.\n\n" +
        "It does not change the source application, its data, the extension, or any configuration."
    );
    if (!confirmed) return;

    connectionIssue = undefined;
    try {
      const result = await resetControlPlane();
      extensionTraces = [];
      selectedTrace = undefined;
      comparisonTraces = [];
      semanticizerRuns = [];
      bindingRuns = [];
      bindingCandidate = undefined;
      validation = undefined;
      validationRuns = [];
      validationStatus = "";
      candidate = undefined;
      ambiguities = [];
      publications = [];
      exportStatus = "";
      bindingStatus = "";
      traceStatus = "Record a session with the Teach Mode extension, then refresh.";
      semanticizerStatus = "Review the proposed contract, then confirm its meaning.";
      publishStatus = "Nothing has been published yet.";
      comparisonStatus = `Cleared ${result.traces} traces and ${result.publications} publications.`;
    } catch (error) {
      comparisonStatus = describeActionFailure("Reset", error);
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#download-bundle")?.addEventListener("click", () => {
    const bundle = currentDebugBundle();
    if (!bundle || !selectedTrace) return;

    const blob = new Blob([serializeDebugBundle(bundle)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = debugBundleFilename(selectedTrace.sessionId);
    link.click();
    URL.revokeObjectURL(url);

    exportStatus = `Downloaded ${debugBundleFilename(selectedTrace.sessionId)}.`;
    render();
  });

  document.querySelector<HTMLButtonElement>("#copy-bundle")?.addEventListener("click", async () => {
    const bundle = currentDebugBundle();
    if (!bundle) return;
    try {
      await navigator.clipboard.writeText(serializeDebugBundle(bundle));
      exportStatus = "Bundle copied to the clipboard.";
    } catch {
      exportStatus = "The browser refused clipboard access; use Download instead.";
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#load-comparison")?.addEventListener("click", async () => {
    comparisonStatus = "Loading captures…";
    connectionIssue = undefined;
    render();
    try {
      const summaries = await listTraces();
      const loaded = await Promise.all(summaries.map((summary) => getTrace(summary.sessionId)));
      comparisonTraces = loaded;
      comparisonStatus = `${loaded.length} captures loaded. Compare the request each Save produced.`;
    } catch (error) {
      comparisonStatus = describeActionFailure("Loading captures", error);
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#refresh-publications")?.addEventListener("click", async () => {
    connectionIssue = undefined;
    try {
      publications = await listPublishedCapabilities();
      publishStatus = publications.length ? "Published capabilities loaded." : "Nothing has been published yet.";
      syncBrowserExecutionRegistrations();
    } catch (error) {
      publishStatus = describeActionFailure("Refreshing publications", error);
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#unpublish-all")?.addEventListener("click", async () => {
    connectionIssue = undefined;
    try {
      const removed = await unpublishAll();
      publications = [];
      publishStatus = `Unpublished ${removed}. WebMCP has no unregister, so reload the taught site to clear its tool surface.`;
    } catch (error) {
      publishStatus = describeActionFailure("Unpublish all", error);
    }
    render();
  });
}

render();

void listPublishedCapabilities()
  .then((records) => {
    publications = records;
    if (records.length) publishStatus = "Published capabilities loaded.";
    syncBrowserExecutionRegistrations();
    // Registration has happened; ask the browser what it can now see.
    void refreshDiscoveredTools().then(render);
    render();
  })
  .catch((error) => {
    publishStatus = describeActionFailure("Loading publications", error);
    render();
  });

window.addEventListener("beforeunload", () => stopCaptureProbe?.(), { once: true });
