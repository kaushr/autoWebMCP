import "./styles.css";
import { confirmCandidate, semanticizeTrace } from "./training/semanticizer";
import { localRegistryBindingProvider, resolveAdvertisedBinding } from "./training/bindingProvider";
import { sourceApplicationFor } from "./training/sourceApplication";
import { getTrace, listTraces, type TraceSummary } from "./training/traces";
import type { ObservationTrace } from "./capture/normalize";
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
       <p class="semanticizer-status">${selectedTrace.stats.captureEvents} raw capture events and ${selectedTrace.stats.rrwebEvents} rrweb events reduced to ${selectedTrace.observations.length} observations.</p>`
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
      const response = await semanticizeTrace({
        traceKind: "extension",
        application: selectedTrace.application.host,
        platform: selectedTrace.application.platform,
        trace: selectedTrace.observations,
        uiLabels: selectedTrace.labels
      });
      candidate = {
        ...response.candidate,
        provenance: {
          ...response.candidate.provenance,
          sourceApplication: sourceApplicationFor(
            selectedTrace.application.platform,
            selectedTrace.application.host
          )
        }
      };
      ambiguities = response.ambiguities;
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
