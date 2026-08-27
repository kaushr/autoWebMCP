import "./styles.css";
import { formatEmployeeCount, type Company, type Contact } from "./prospect/data";
import { invokeProspectCapability, prospectCapabilities } from "./prospect/capabilities";
import { findContacts, getCompany, searchCompanies } from "./prospect/service";
import { TrainingSession } from "./training/events";
import { confirmCandidate, semanticizeTrace, type SemanticizationResponse } from "./training/semanticizer";
import { getTrace, listTraces, type TraceSummary } from "./training/traces";
import type { ObservationTrace } from "./capture/normalize";
import { registerCapability } from "./webmcp/compiler";
import { registerHelloControl } from "./webmcp/hello";
import { startRrwebCaptureProbe } from "./capture/rrwebProbe";
import type { SemanticCapability } from "./semantic/model";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root not found.");
const appRoot: HTMLDivElement = app;

const controlMode = new URLSearchParams(window.location.search).get("control") === "1";
const captureMode = new URLSearchParams(window.location.search).get("capture") === "1";
const registration = controlMode
  ? registerHelloControl()
  : prospectCapabilities.map((capability) => registerCapability(capability, invokeProspectCapability)).every((result) => result === "registered")
    ? "registered"
    : "unavailable";

let companyResults: Company[] = searchCompanies("Acme");
let selectedCompany: Company | undefined = companyResults[0];
let contactResults: Contact[] = selectedCompany ? findContacts({ company_id: selectedCompany.id }) : [];
let selectedContact: Contact | undefined;
const stopCaptureProbe = captureMode ? startRrwebCaptureProbe((snapshot) => {
  const status = document.querySelector("#capture-probe-status");
  if (status) status.textContent = `rrweb probe active · ${snapshot.raw.total} masked raw events · ${snapshot.interactions.length} safe interactions`;
}) : undefined;
const trainingSession = new TrainingSession();
let candidate: SemanticCapability | undefined;
let ambiguities: string[] = [];
let semanticizerStatus = "Demonstrate a session, then request a candidate capability.";
let extensionTraces: TraceSummary[] = [];
let selectedTrace: ObservationTrace | undefined;
let traceStatus = "Record a session with the AutoWebMCP extension, then refresh.";

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character] ?? character);
}

function renderCompanyCard(company: Company): string {
  return `<button class="company-card ${company.id === selectedCompany?.id ? "selected" : ""}" data-company-id="${company.id}">
    <span class="company-name">${escapeHtml(company.name)}</span>
    <span>${escapeHtml(company.industry)} · ${escapeHtml(formatEmployeeCount(company.employeeCount))}</span>
  </button>`;
}

function renderContactCard(contact: Contact): string {
  return `<button class="contact-card ${contact.id === selectedContact?.id ? "selected" : ""}" data-contact-id="${contact.id}">
    <strong>${escapeHtml(contact.name)}</strong>
    <span>${escapeHtml(contact.title)}</span>
    <span class="tag">${escapeHtml(contact.function)}</span>
  </button>`;
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

function renderTrainingStudio(): string {
  const events = trainingSession.list();
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
        ${ambiguities.length ? `<p class="ambiguity">Review: ${ambiguities.map(escapeHtml).join(" · ")}</p>` : ""}
        <div class="studio-actions"><button type="submit">Save candidate edits</button><button type="button" id="confirm-capability">Confirm &amp; publish WebMCP tool</button></div>
      </form>`
    : "";

  return `<section class="training-studio" aria-label="Training Studio">
    <div class="studio-heading"><div><p class="eyebrow">Training Studio</p><h2>Teach one session. Publish one capability.</h2><p>Capture normalized evidence from this controlled application; the model proposes meaning, while the compiler produces the tool deterministically.</p></div><div class="studio-links"><a href="/prospect/">Open SignalBase &#8599;</a><a href="/?control=1">WebMCP control</a></div></div>
    <ol class="event-trace">${events.length ? events.map((event) => `<li><span>${event.type}</span><strong>${escapeHtml(event.entity)}</strong> ${escapeHtml(event.target ?? "")} <em>${escapeHtml(event.value ?? "")}</em></li>`).join("") : "<li class=empty>Start by searching, opening a company, filtering contacts, and opening a contact.</li>"}</ol>
    <div class="studio-actions"><button id="semanticize-trace" ${events.length < 2 ? "disabled" : ""}>Propose capability</button><button id="clear-training" class="secondary">Clear session</button><p class="semanticizer-status">${escapeHtml(semanticizerStatus)}</p></div>
    ${renderExtensionTraces()}
    ${candidateEditor}
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
      <div class="runtime-status ${registration}">
        <span></span> WebMCP ${registration === "registered" ? "tools registered" : "unavailable in this browser"}
      </div>
    </header>
    <main>
      <section class="hero">
        <p class="eyebrow">Prospect Intelligence</p>
        <h1>Find the people who move a deal forward.</h1>
        <p>Controlled synthetic data for the Teach → Publish → Use WebMCP demonstration.</p>
        ${captureMode ? `<p id="capture-probe-status" class="runtime-status registered">rrweb probe active · raw events remain in memory and inputs are masked</p>` : ""}
      </section>
      <section class="workspace" aria-label="Prospect research workspace">
        <aside class="panel companies-panel">
          <div class="panel-heading"><div><p class="eyebrow">01 · Companies</p><h2>Search accounts</h2></div><span>${companyResults.length}</span></div>
          <form id="company-search"><label class="sr-only" for="company-query">Search companies</label><input id="company-query" name="query" value="Acme" placeholder="Search company or industry" /><button type="submit">Search</button></form>
          <div class="result-list">${companyResults.map(renderCompanyCard).join("") || "<p class=empty>No matching companies.</p>"}</div>
        </aside>
        <section class="panel contacts-panel">
          <div class="panel-heading"><div><p class="eyebrow">02 · Contacts</p><h2>${selectedCompany ? escapeHtml(selectedCompany.name) : "Select a company"}</h2></div><span>${contactResults.length}</span></div>
          ${selectedCompany ? `<p class="company-summary">${escapeHtml(selectedCompany.description)}</p>
          <form id="contact-filter" class="filters">
            <label>Function<select name="function"><option value="">All functions</option><option>Procurement</option><option>Operations</option><option>Information Technology</option><option>Finance</option></select></label>
            <label>Seniority<select name="seniority"><option value="">All seniority</option><option>C-Level</option><option>SVP</option><option>VP</option><option>Director</option><option>Manager</option></select></label>
            <label>Title contains<input name="title_keywords" placeholder="e.g. procurement" /></label>
            <button type="submit">Apply filters</button>
          </form>
          <div class="result-list contacts">${contactResults.map(renderContactCard).join("") || "<p class=empty>No contacts match these filters.</p>"}</div>` : "<p class=empty>Select a company to view contacts.</p>"}
        </section>
        <aside class="panel detail-panel">
          <p class="eyebrow">03 · Contact detail</p>
          ${selectedContact ? `<h2>${escapeHtml(selectedContact.name)}</h2><p class="title">${escapeHtml(selectedContact.title)}</p><dl class="contact-detail"><div><dt>Function</dt><dd>${escapeHtml(selectedContact.function)}</dd></div><div><dt>Seniority</dt><dd>${escapeHtml(selectedContact.seniority)}</dd></div><div><dt>Email</dt><dd>${escapeHtml(selectedContact.email)}</dd></div></dl><p>${escapeHtml(selectedContact.responsibilitySummary)}</p>` : "<h2>Inspect a contact</h2><p class=empty>Choose a result to see the information an agent can retrieve through <code>get_contact</code>.</p>"}
        </aside>
      </section>
      ${renderTrainingStudio()}
    </main>`;

  document.querySelector<HTMLFormElement>("#company-search")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget as HTMLFormElement).get("query");
    trainingSession.record({ type: "search", entity: "company", target: "company query", value: String(query ?? "") });
    companyResults = searchCompanies(String(query ?? ""));
    selectedCompany = companyResults[0];
    contactResults = selectedCompany ? findContacts({ company_id: selectedCompany.id }) : [];
    selectedContact = undefined;
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-company-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedCompany = getCompany(button.dataset.companyId ?? "");
      if (selectedCompany) trainingSession.record({ type: "open", entity: "company", value: selectedCompany.id });
      contactResults = selectedCompany ? findContacts({ company_id: selectedCompany.id }) : [];
      selectedContact = undefined;
      render();
    });
  });

  document.querySelector<HTMLFormElement>("#contact-filter")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!selectedCompany) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const functionValue = String(form.get("function") ?? "");
    const seniorityValue = String(form.get("seniority") ?? "");
    const titleValue = String(form.get("title_keywords") ?? "");
    if (functionValue) trainingSession.record({ type: "filter", entity: "contact", target: "function", value: functionValue });
    if (seniorityValue) trainingSession.record({ type: "filter", entity: "contact", target: "seniority", value: seniorityValue });
    if (titleValue) trainingSession.record({ type: "filter", entity: "contact", target: "title keywords", value: titleValue });
    contactResults = findContacts({
      company_id: selectedCompany.id,
      function: functionValue || undefined,
      seniority: seniorityValue || undefined,
      title_keywords: titleValue || undefined
    });
    selectedContact = undefined;
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-contact-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedContact = contactResults.find((contact) => contact.id === button.dataset.contactId);
      if (selectedContact) trainingSession.record({ type: "open", entity: "contact", value: selectedContact.id });
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#clear-training")?.addEventListener("click", () => {
    trainingSession.clear();
    candidate = undefined;
    ambiguities = [];
    semanticizerStatus = "Session cleared.";
    render();
  });

  document.querySelector<HTMLButtonElement>("#semanticize-trace")?.addEventListener("click", async () => {
    semanticizerStatus = "Proposing a bounded candidate capability…";
    render();
    try {
      const response: SemanticizationResponse = await semanticizeTrace({
        application: "prospect-intelligence",
        trace: trainingSession.list(),
        uiLabels: ["Company Search", "Function", "Seniority", "Title contains", "Contact Detail"]
      });
      candidate = response.candidate;
      ambiguities = response.ambiguities;
      semanticizerStatus = "Candidate ready for human review.";
    } catch (error) {
      semanticizerStatus = error instanceof Error ? error.message : "Candidate generation failed.";
    }
    render();
  });

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
      candidate = response.candidate;
      ambiguities = response.ambiguities;
      traceStatus = "Candidate ready for human review.";
      semanticizerStatus = `Candidate proposed from extension trace ${selectedTrace.sessionId}.`;
    } catch (error) {
      traceStatus = error instanceof Error ? error.message : "Candidate generation failed.";
    }
    render();
  });

  document.querySelector<HTMLFormElement>("#candidate-editor")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!candidate) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    candidate = {
      ...candidate,
      name: String(form.get("name") ?? candidate.name),
      description: String(form.get("description") ?? candidate.description),
      inputs: candidate.inputs.map((input, index) => ({
        ...input,
        name: String(form.get(`input-name-${index}`) ?? input.name),
        required: form.get(`input-required-${index}`) === "on"
      }))
    };
    semanticizerStatus = "Candidate edits saved. Confirm when the contract is correct.";
    render();
  });

  document.querySelector<HTMLButtonElement>("#confirm-capability")?.addEventListener("click", () => {
    if (!candidate) return;
    candidate = confirmCandidate(candidate);

    // A capability taught on another application is confirmed here but has no
    // execution binding to compile against yet; live execution is a separate milestone.
    if (candidate.binding?.application !== "prospect-intelligence") {
      semanticizerStatus = "Capability confirmed. It has no execution binding in this application yet, so it is not published to WebMCP.";
      render();
      return;
    }

    const publishResult = registerCapability(candidate, invokeProspectCapability);
    semanticizerStatus = publishResult === "registered" ? "Confirmed capability published to WebMCP." : "Confirmed capability is ready, but WebMCP is unavailable in this browser.";
    render();
  });
}

render();

window.addEventListener("beforeunload", () => stopCaptureProbe?.(), { once: true });
