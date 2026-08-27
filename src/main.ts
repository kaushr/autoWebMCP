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
import { isInvestigable } from "./binding/model";
import { observedRecordType, resolveFieldMapping } from "./binding/fieldMapping";
import { defaultValidators } from "./binding/validators";
import {
  acceptedBinding,
  runBindingValidation,
  type BindingValidationRecord
} from "./binding/validation";
import {
  buildDebugBundle,
  debugBundleFilename,
  serializeDebugBundle,
  type DebugBundle
} from "./training/debugBundle";
import { getTrace, listTraces, type TraceSummary } from "./training/traces";
import type { ObservationTrace } from "./capture/normalize";
import type { CaptureEvent } from "./capture/types";
import {
  listPublishedCapabilities,
  publishCapability,
  unpublishAll,
  type PublicationRecord
} from "./webmcp/publication";
import { registerHelloControl } from "./webmcp/hello";
import { startRrwebCaptureProbe } from "./capture/rrwebProbe";
import type { SemanticCapability } from "./semantic/model";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root not found.");
const appRoot: HTMLDivElement = app;

const controlMode = new URLSearchParams(window.location.search).get("control") === "1";
const captureMode = new URLSearchParams(window.location.search).get("capture") === "1";
/**
 * The Studio publishes capabilities to the control plane; it never hosts them.
 * The only tool it can register is the browser-support control on `?control=1`.
 */
const registration = controlMode ? registerHelloControl() : document.modelContext ? "available" : "unavailable";

const stopCaptureProbe = captureMode ? startRrwebCaptureProbe((snapshot) => {
  const status = document.querySelector("#capture-probe-status");
  if (status) status.textContent = `rrweb probe active · ${snapshot.raw.total} masked raw events · ${snapshot.interactions.length} safe interactions`;
}) : undefined;
let candidate: SemanticCapability | undefined;
let ambiguities: string[] = [];
let semanticizerStatus = "Review the proposed contract, choose an execution binding, then confirm.";
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
let publications: PublicationRecord[] = [];
let publishStatus = "Nothing has been published yet.";

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character] ?? character);
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
function renderExtensionTraces(): string {
  const list = extensionTraces.length
    ? extensionTraces
        .map(
          (trace) => `<li><button class="trace-option ${trace.sessionId === selectedTrace?.sessionId ? "selected" : ""}" data-trace-id="${escapeHtml(trace.sessionId)}">
            <strong>${escapeHtml(trace.title ?? trace.application)}</strong>
            <span>${escapeHtml(trace.platform)} · ${trace.observations} observations</span>
          </button></li>`
        )
        .join("")
    : "<li class=empty>No extension traces have been handed off yet.</li>";

  const detail = selectedTrace
    ? `<ol class="event-trace">${selectedTrace.observations
        .map((observation) => `<li><span>${escapeHtml(observation.action)}</span> ${describeObservation(observation)}</li>`)
        .join("")}</ol>
       <p class="semanticizer-status">${selectedTrace.stats.captureEvents} raw capture events
         → ${selectedTrace.observations.length} normalized observations
         → ${(selectedTrace.executionEvidence ?? []).length} execution evidence groups.
         Details are under Admin / Debug.</p>`
    : "";

  return `<section class="extension-traces" aria-label="Extension traces">
    <div class="panel-heading"><div><p class="eyebrow">Browser extension</p><h2>Teach Mode captures</h2></div><span>${extensionTraces.length}</span></div>
    <ul class="trace-list">${list}</ul>
    ${detail}
    <div class="studio-actions">
      <button id="refresh-traces" class="secondary">Refresh traces</button>
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

/** Everything a human is asked to accept as the meaning of the capability. */
function semanticContract(capability: SemanticCapability): string {
  return JSON.stringify({
    name: capability.name,
    description: capability.description,
    inputs: capability.inputs.map((input) => [input.name, input.required])
  });
}

function renderBindingPicker(capability: SemanticCapability): string {
  const source = capability.provenance.sourceApplication;
  const advertised = localRegistryBindingProvider.getBindings(source);
  const selected = resolveAdvertisedBinding(capability);

  // Nothing is known about how this application executes anything. Offering
  // another application's actions here would be worse than offering none.
  if (advertised.length === 0) {
    return `<div class="binding-empty">
      <p class="eyebrow">Execution binding</p>
      <p><strong>No execution binding discovered${
        source ? ` for ${escapeHtml(source.label)}` : ""
      }.</strong> This capability can be confirmed, but cannot be published until an execution path is identified.</p>
    </div>`;
  }

  const options = advertised
    .map(
      (binding) =>
        `<option value="${escapeHtml(`${binding.application}:${binding.action}`)}" ${
          selected && selected.action === binding.action && selected.application === binding.application
            ? "selected"
            : ""
        }>${escapeHtml(binding.action)}</option>`
    )
    .join("");

  return `<label>Execution binding
    <select name="binding">
      <option value="">No execution binding</option>
      ${options}
    </select>
  </label>
  <p class="semanticizer-status">${
    selected
      ? `<code>${escapeHtml(selected.action)}</code> reads ${selected.parameters
          .map((parameter) => `<code>${escapeHtml(parameter)}</code>`)
          .join(", ")}. Rename the parameters above to match.`
      : `Automatic binding discovery is not implemented. Choose the action ${escapeHtml(
          source?.label ?? "this application"
        )} already performs for this workflow.`
  }</p>`;
}

const CHECK_MARK: Record<string, string> = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", skipped: "skipped" };

/**
 * Proof, or an honest account of why there is none. A validated result is
 * offered for acceptance rather than installed: proving a mechanism works is a
 * different judgement from deciding it should be used.
 */
function renderValidation(): string {
  const record = validation;
  const result = record?.result;

  const body = result
    ? `<dl class="capability-state">
        <div><dt>Status</dt><dd>${escapeHtml(result.status)}</dd></div>
        <div><dt>Adapter</dt><dd><code>${escapeHtml(result.adapter)}</code></dd></div>
        <div><dt>Execution binding</dt><dd>${
          record?.state === "accepted" ? "accepted" : result.binding ? "awaiting acceptance" : "none"
        }</dd></div>
      </dl>
      <ul class="reasons">${result.checks
        .map(
          (check) =>
            `<li class="check-${escapeHtml(check.status)}"><strong>${escapeHtml(
              CHECK_MARK[check.status] ?? check.status
            )}</strong> ${escapeHtml(check.name)} — ${escapeHtml(check.detail)}</li>`
        )
        .join("")}</ul>
      ${result.evidence.length ? `<ul class="reasons">${result.evidence.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>` : ""}
      ${result.warnings.length ? `<p class="ambiguity">${result.warnings.map(escapeHtml).join(" · ")}</p>` : ""}
      ${
        result.requirements.length
          ? `<p class="semanticizer-status">Required before this can be validated: ${result.requirements
              .map(escapeHtml)
              .join("; ")}.</p>`
          : ""
      }`
    : "";

  return `<div class="binding-validation">
    <p class="eyebrow">Binding validation</p>
    ${body}
    <div class="studio-actions">
      <button type="button" id="validate-binding" class="secondary">${result ? "Re-validate binding" : "Validate binding"}</button>
      ${
        result?.binding && record?.state !== "accepted"
          ? `<button type="button" id="accept-binding">Accept validated binding</button>`
          : ""
      }
      <p class="semanticizer-status">${escapeHtml(validationStatus)}</p>
    </div>
  </div>`;
}

/**
 * The proposal step between confirmation and a binding.
 *
 * A candidate is a research lead, never a binding: it does not populate the
 * execution binding, and Publish stays exactly as gated as before.
 */
function renderBindingCandidate(confirmed: boolean, bound: boolean): string {
  if (!confirmed || bound) return "";

  const record = bindingCandidate;
  const proposal = record?.proposal;
  const body = proposal
    ? `<dl class="capability-state">
        <div><dt>Binding family</dt><dd>${escapeHtml(proposal.candidate?.bindingFamily ?? "none proposed")}</dd></div>
        <div><dt>Eligibility</dt><dd>${escapeHtml(proposal.eligibility)}</dd></div>
        <div><dt>Confidence</dt><dd>${escapeHtml(proposal.confidence)}</dd></div>
        <div><dt>Direct replay</dt><dd>prohibited</dd></div>
      </dl>
      ${
        proposal.candidate
          ? `<p class="semanticizer-status">${escapeHtml(proposal.candidate.mechanism)}${
              proposal.candidate.observedTransport
                ? ` · observed transport <code>${escapeHtml(proposal.candidate.observedTransport)}</code>`
                : ""
            }</p>`
          : ""
      }
      ${proposal.evidence.length ? `<ul class="reasons">${proposal.evidence.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>` : ""}
      ${proposal.warnings.length ? `<p class="ambiguity">${proposal.warnings.map(escapeHtml).join(" · ")}</p>` : ""}
      ${
        proposal.validationRequired.length
          ? `<p class="semanticizer-status">Before this can become a binding: ${proposal.validationRequired
              .map(escapeHtml)
              .join("; ")}.</p>`
          : ""
      }
      <p class="semanticizer-status">A candidate is a lead to investigate, not an execution binding.
        The execution binding stays unset and publication stays blocked.</p>`
    : "";

  const validationBlock = proposal && isInvestigable(proposal) ? renderValidation() : "";

  return `<div class="binding-candidate">
    <p class="eyebrow">Binding candidate</p>
    ${body}
    ${validationBlock}
    <div class="studio-actions">
      <button type="button" id="generate-binding" class="secondary">${
        proposal ? "Regenerate binding candidate" : "Suggest execution binding"
      }</button>
      ${
        proposal && isInvestigable(proposal)
          ? `<button type="button" id="accept-binding-candidate" class="secondary" ${
              record?.state === "accepted-for-validation" ? "disabled" : ""
            }>${record?.state === "accepted-for-validation" ? "Accepted for validation" : "Accept for validation"}</button>
             <button type="button" id="reject-binding-candidate" class="secondary" ${
               record?.state === "rejected" ? "disabled" : ""
             }>${record?.state === "rejected" ? "Rejected" : "Reject"}</button>`
          : ""
      }
      <p class="semanticizer-status">${escapeHtml(bindingStatus)}</p>
    </div>
  </div>`;
}

/** The two questions the lifecycle keeps apart, answered side by side. */
function renderCapabilityState(capability: SemanticCapability, confirmed: boolean, bound: boolean): string {
  const source = capability.provenance.sourceApplication;
  return `<dl class="capability-state">
    <div><dt>Learned from</dt><dd>${escapeHtml(source?.label ?? "Unknown application")}</dd></div>
    <div><dt>Semantic capability</dt><dd>${confirmed ? "Confirmed" : "Awaiting confirmation"}</dd></div>
    <div><dt>Execution binding</dt><dd>${
      acceptedBinding(validation) ? "Validated and accepted" : bound ? "Resolved" : "Not discovered"
    }</dd></div>
    <div><dt>Publication</dt><dd>${confirmed && bound ? "Ready" : "Blocked"}</dd></div>
  </dl>`;
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
    ? `${renderTraceIdentity(selectedTrace)}${renderCaptureStream(selectedTrace)}${renderNormalizedPanel(selectedTrace)}${renderEvidencePanel(selectedTrace)}${renderSemanticizerRuns()}${renderBindingRuns()}${renderValidationRuns()}${renderLifecyclePanel()}${renderExportPanel()}${renderComparison()}${renderReset()}`
    : `<p class="semanticizer-status">Select a Teach Mode capture to inspect what was observed and transformed.</p>
       ${renderSemanticizerRuns()}${renderBindingRuns()}${renderValidationRuns()}${renderExportPanel()}${renderComparison()}${renderReset()}`;

  return `<details class="admin-debug">
    <summary>Admin / Debug</summary>
    <p class="semanticizer-status">Everything AutoWebMCP observed, transformed, sent to the model, and read back.
      Development observability: it reads the pipeline and never changes it.</p>
    ${body}
  </details>`;
}

function renderTrainingStudio(): string {
  const confirmed = Boolean(candidate?.provenance.confirmedByHuman);
  // Two routes to a binding, both requiring a human: selecting one the
  // application advertises, or accepting one validation proved. Neither is
  // weakened by the other, and a mere candidate is neither.
  const bound = candidate
    ? Boolean(resolveAdvertisedBinding(candidate)) || Boolean(acceptedBinding(validation))
    : false;
  const candidateEditor = candidate
    ? `<form id="candidate-editor" class="candidate-editor">
        <div class="panel-heading"><div><p class="eyebrow">Candidate capability</p><h2>Review before publication</h2></div><span>Human confirmation required</span></div>
        <label>Capability name<input name="name" value="${escapeHtml(candidate.name)}" /></label>
        <label>Description<textarea name="description">${escapeHtml(candidate.description)}</textarea></label>
        <div class="input-list">${candidate.inputs
          .map(
            (input, index) => `<div><label>Parameter <input name="input-name-${index}" value="${escapeHtml(input.name)}" /></label><label class="checkbox"><input name="input-required-${index}" type="checkbox" ${input.required ? "checked" : ""} /> Required</label></div>`
          )
          .join("")}</div>
        ${renderBindingPicker(candidate)}
        ${renderCapabilityState(candidate, confirmed, bound)}
        ${renderBindingCandidate(confirmed, bound)}
        ${ambiguities.length ? `<p class="ambiguity">Review: ${ambiguities.map(escapeHtml).join(" · ")}</p>` : ""}
        <div class="studio-actions">
          <button type="submit">Save candidate edits</button>
          <button type="button" id="confirm-capability" ${confirmed ? "disabled" : ""}>${confirmed ? "Confirmed" : "Confirm capability"}</button>
          <button type="button" id="publish-capability" class="${confirmed && bound ? "" : "secondary"}" ${confirmed && bound ? "" : "disabled"}>Publish to WebMCP</button>
          <p class="semanticizer-status">${escapeHtml(semanticizerStatus)}</p>
        </div>
      </form>`
    : "";

  return `<section class="training-studio" aria-label="Training Studio">
    ${renderExtensionTraces()}
    ${candidateEditor}
    ${renderPublications()}
    ${renderAdminDebug()}
  </section>`;
}

function render(): void {
  if (controlMode) {
    appRoot.innerHTML = `
      <main class="control-shell">
        <p class="eyebrow">AutoWebMCP · controlled WebMCP test</p>
        <h1>WebMCP hello-world control</h1>
        <p>This isolated controlled page registers <code>hello_webmcp</code> with the same minimal tool shape as the Salesforce spike.</p>
        <dl class="diagnostics">
          <div><dt>document.modelContext</dt><dd>${document.modelContext ? "available" : "unavailable"}</dd></div>
          <div><dt>crossOriginIsolated</dt><dd>${String(window.crossOriginIsolated)}</dd></div>
          <div><dt>Registration</dt><dd>${registration}</dd></div>
        </dl>
        <a href="/">Return to Prospect Intelligence</a>
      </main>`;
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
      ${renderTrainingStudio()}
    </main>`;

  document.querySelector<HTMLButtonElement>("#refresh-traces")?.addEventListener("click", async () => {
    traceStatus = "Loading extension traces…";
    render();
    try {
      extensionTraces = await listTraces();
      traceStatus = extensionTraces.length
        ? "Select a capture to review its normalized evidence."
        : "No traces yet. Start and stop a training session in the extension.";
    } catch (error) {
      traceStatus = error instanceof Error ? error.message : "Could not reach the trace endpoint.";
    }
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-trace-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        selectedTrace = await getTrace(button.dataset.traceId ?? "");
        traceStatus = `Loaded ${selectedTrace.observations.length} observations from ${selectedTrace.application.host}.`;
      } catch (error) {
        traceStatus = error instanceof Error ? error.message : "Could not load that trace.";
      }
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#semanticize-extension-trace")?.addEventListener("click", async () => {
    if (!selectedTrace) return;
    traceStatus = "Proposing a bounded candidate capability from extension evidence…";
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
      ambiguities = run.ambiguities;
      traceStatus = "Candidate ready for human review.";
      semanticizerStatus = `Candidate proposed from extension trace ${selectedTrace.sessionId}.`;
    } catch (error) {
      traceStatus = error instanceof Error ? error.message : "Candidate generation failed.";
    }
    render();
  });

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
      inputs: candidate.inputs.map((input, index) => ({
        ...input,
        name: String(form.get(`input-name-${index}`) ?? input.name),
        required: form.get(`input-required-${index}`) === "on"
      }))
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
    semanticizerStatus = candidate && resolveAdvertisedBinding(candidate)
      ? "Candidate edits saved. Confirm when the contract is correct."
      : "Candidate edits saved. Choose an execution binding before confirming.";
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
      ? "Meaning confirmed and an execution binding is resolved. Ready to publish."
      : "Meaning confirmed. Publication stays blocked until an execution binding exists for this application.";
    render();
  });

  // Publication is the moment the taught site gains a capability. The Studio
  // hands the confirmed contract to the control plane; the site compiles it.
  document.querySelector<HTMLButtonElement>("#publish-capability")?.addEventListener("click", async () => {
    if (!candidate) return;
    publishStatus = "Publishing…";
    render();
    try {
      const record = await publishCapability(candidate);
      publications = await listPublishedCapabilities();
      publishStatus = `Published ${record.capability.id}. Reload or return to the taught site to see it registered.`;
    } catch (error) {
      publishStatus = error instanceof Error ? error.message : "Publishing failed.";
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#generate-binding")?.addEventListener("click", async () => {
    if (!candidate || !selectedTrace) return;
    bindingStatus = "Proposing a binding candidate from the strongest execution evidence…";
    render();
    try {
      const result = await inferBindingCandidate(candidate, selectedTrace, selectedTrace.observations);
      if (result.run) bindingRuns = [...bindingRuns, result.run];
      bindingCandidate = { state: "proposed", proposal: result.proposal };
      bindingStatus = result.proposal.candidate
        ? "Candidate proposed. It is a lead to validate, not a binding."
        : "No safe binding candidate was found from this evidence.";
    } catch (error) {
      bindingStatus = error instanceof Error ? error.message : "Binding inference failed.";
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#validate-binding")?.addEventListener("click", async () => {
    if (!candidate || !selectedTrace || !bindingCandidate) return;
    validationStatus = "Validating the proposed mechanism…";
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
          ? "Mechanism validated. Accept it to make it the execution binding."
          : `Validation returned ${result.status}. No execution binding was created.`;
    } catch (error) {
      validationStatus = error instanceof Error ? error.message : "Validation failed.";
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#accept-binding")?.addEventListener("click", () => {
    if (!validation?.result.binding) return;
    // Technical proof and product approval are different decisions.
    validation = { ...validation, state: "accepted" };
    validationStatus = "Validated binding accepted. It is now this capability's execution binding.";
    render();
  });

  document.querySelector<HTMLButtonElement>("#accept-binding-candidate")?.addEventListener("click", () => {
    if (!bindingCandidate) return;
    // Recorded only. The execution binding stays unset until a human selects a
    // validated one, and publication is unchanged.
    bindingCandidate = { ...bindingCandidate, state: "accepted-for-validation" };
    bindingStatus = "Accepted for validation. It is still not an execution binding.";
    render();
  });

  document.querySelector<HTMLButtonElement>("#reject-binding-candidate")?.addEventListener("click", () => {
    if (!bindingCandidate) return;
    bindingCandidate = { ...bindingCandidate, state: "rejected" };
    bindingStatus = "Candidate rejected.";
    render();
  });

  document.querySelector<HTMLButtonElement>("#reset-control-plane")?.addEventListener("click", async () => {
    const confirmed = window.confirm(
      "This clears all local AutoWebMCP Teach Mode traces, inference runs, candidates and publications.\n\n" +
        "It does not change the source application, its data, the extension, or any configuration."
    );
    if (!confirmed) return;

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
      semanticizerStatus = "Review the proposed contract, choose an execution binding, then confirm.";
      publishStatus = "Nothing has been published yet.";
      comparisonStatus = `Cleared ${result.traces} traces and ${result.publications} publications.`;
    } catch (error) {
      comparisonStatus = error instanceof Error ? error.message : "Reset failed.";
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
    render();
    try {
      const summaries = await listTraces();
      const loaded = await Promise.all(summaries.map((summary) => getTrace(summary.sessionId)));
      comparisonTraces = loaded;
      comparisonStatus = `${loaded.length} captures loaded. Compare the request each Save produced.`;
    } catch (error) {
      comparisonStatus = error instanceof Error ? error.message : "Could not load captures.";
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#refresh-publications")?.addEventListener("click", async () => {
    try {
      publications = await listPublishedCapabilities();
      publishStatus = publications.length ? "Published capabilities loaded." : "Nothing has been published yet.";
    } catch (error) {
      publishStatus = error instanceof Error ? error.message : "Could not reach the control plane.";
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#unpublish-all")?.addEventListener("click", async () => {
    try {
      const removed = await unpublishAll();
      publications = [];
      publishStatus = `Unpublished ${removed}. WebMCP has no unregister, so reload the taught site to clear its tool surface.`;
    } catch (error) {
      publishStatus = error instanceof Error ? error.message : "Could not reach the control plane.";
    }
    render();
  });
}

render();

void listPublishedCapabilities()
  .then((records) => {
    publications = records;
    if (records.length) publishStatus = "Published capabilities loaded.";
    render();
  })
  .catch(() => {
    publishStatus = "Control plane unreachable. Run `npm run dev:semanticizer` to publish.";
    render();
  });

window.addEventListener("beforeunload", () => stopCaptureProbe?.(), { once: true });
