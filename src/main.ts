import "./styles.css";
import { confirmCandidate, semanticizeTrace, type SemanticizerRun } from "./training/semanticizer";
import { localRegistryBindingProvider, resolveAdvertisedBinding } from "./training/bindingProvider";
import { sourceApplicationFor } from "./training/sourceApplication";
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

/** The two questions the lifecycle keeps apart, answered side by side. */
function renderCapabilityState(capability: SemanticCapability, confirmed: boolean, bound: boolean): string {
  const source = capability.provenance.sourceApplication;
  return `<dl class="capability-state">
    <div><dt>Learned from</dt><dd>${escapeHtml(source?.label ?? "Unknown application")}</dd></div>
    <div><dt>Semantic capability</dt><dd>${confirmed ? "Confirmed" : "Awaiting confirmation"}</dd></div>
    <div><dt>Execution binding</dt><dd>${bound ? "Resolved" : "Not discovered"}</dd></div>
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
    ? `${renderTraceIdentity(selectedTrace)}${renderCaptureStream(selectedTrace)}${renderNormalizedPanel(selectedTrace)}${renderEvidencePanel(selectedTrace)}${renderSemanticizerRuns()}${renderLifecyclePanel()}${renderExportPanel()}${renderComparison()}`
    : `<p class="semanticizer-status">Select a Teach Mode capture to inspect what was observed and transformed.</p>
       ${renderSemanticizerRuns()}${renderExportPanel()}${renderComparison()}`;

  return `<details class="admin-debug">
    <summary>Admin / Debug</summary>
    <p class="semanticizer-status">Everything AutoWebMCP observed, transformed, sent to the model, and read back.
      Development observability: it reads the pipeline and never changes it.</p>
    ${body}
  </details>`;
}

function renderTrainingStudio(): string {
  const confirmed = Boolean(candidate?.provenance.confirmedByHuman);
  const bound = candidate ? Boolean(resolveAdvertisedBinding(candidate)) : false;
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
