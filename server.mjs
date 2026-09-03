import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import OpenAI from "openai";

const port = Number(process.env.PORT ?? 8787);
const staticRoot = join(process.cwd(), "dist");
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const capabilitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidate", "ambiguities"],
  properties: {
    candidate: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "description", "inputs", "outputs", "binding", "provenance", "safety"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        inputs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "description", "type", "required"],
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              type: { type: "string", enum: ["string", "date", "number", "boolean"] },
              required: { type: "boolean" }
            }
          }
        },
        outputs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "description", "type"],
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              type: { type: "string", enum: ["object", "array", "string", "number", "boolean"] }
            }
          }
        },
        binding: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["application", "action"],
          properties: { application: { type: "string" }, action: { type: "string" } }
        },
        provenance: {
          type: "object",
          additionalProperties: false,
          required: ["source", "observationIds", "confirmedByHuman"],
          properties: {
            source: { type: "string", enum: ["inferred"] },
            observationIds: { type: "array", items: { type: "string" } },
            confirmedByHuman: { type: "boolean", enum: [false] }
          }
        },
        safety: {
          type: "object",
          additionalProperties: false,
          required: ["readOnly", "requiresConfirmation"],
          properties: { readOnly: { type: "boolean" }, requiresConfirmation: { type: "boolean" } }
        }
      }
    },
    ambiguities: { type: "array", items: { type: "string" } }
  }
};

/**
 * Bumped whenever the instructions or response schema change, so a recorded
 * semanticizer run can be read against the prompt that actually produced it.
 */
const SEMANTICIZER_PROMPT_VERSION = "2026-08-27.1";

/** Binding inference is a separate question, so it versions separately. */
const BINDING_PROMPT_VERSION = "2026-08-27.1";

const bindingCandidateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidate", "confidence", "eligibility", "evidence", "warnings", "validationRequired"],
  properties: {
    candidate: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["bindingFamily", "mechanism", "observedTransport"],
      properties: {
        bindingFamily: { type: "string" },
        mechanism: { type: "string" },
        observedTransport: { type: ["string", "null"] }
      }
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    eligibility: {
      type: "string",
      enum: [
        "supported-candidate",
        "needs-validation",
        "private-observed-transport",
        "unsafe-to-replay",
        "unresolved",
        "no-safe-candidate"
      ]
    },
    evidence: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    validationRequired: { type: "array", items: { type: "string" } }
  }
};

/** Ephemeral in-memory handoff buffer. Traces are never written to disk. */
const traces = new Map();
const MAX_TRACES = 20;

/**
 * Capabilities a human has confirmed and then deliberately published.
 *
 * This is the control plane the cooperative site reads on load: a site holds no
 * generated capability until one is published here, and everything is lost on
 * restart, which is exactly the reset the demo wants.
 */
const publications = new Map();

function corsHeaders(request) {
  const origin = request.headers.origin ?? "";
  const allowed = /^chrome-extension:\/\//.test(origin) || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  return allowed
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    : {};
}

function send(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, limit = 100_000) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw new Error("Request too large");
  }
  return JSON.parse(body);
}

function summarizeTrace(entry) {
  const { trace, receivedAt } = entry;
  return {
    sessionId: trace.sessionId,
    application: trace.application.host,
    platform: trace.application.platform,
    ...(trace.application.title ? { title: trace.application.title } : {}),
    ...(trace.recording?.name ? { name: trace.recording.name } : {}),
    ...(trace.recording?.description ? { description: trace.recording.description } : {}),
    startedAt: trace.startedAt,
    ...(trace.endedAt ? { endedAt: trace.endedAt } : {}),
    observations: trace.observations.length,
    receivedAt
  };
}

/**
 * Updates only a trace's human-supplied recording metadata. The session
 * identity and every piece of captured evidence stay exactly as received —
 * this is what the person calls the recording, never what was observed.
 */
function updateTraceRecording(sessionId, body) {
  const entry = traces.get(sessionId);
  if (!entry) return undefined;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (name || description) {
    entry.trace.recording = {
      ...(name ? { name } : {}),
      ...(description ? { description } : {})
    };
  } else {
    delete entry.trace.recording;
  }
  return summarizeTrace(entry);
}

/** Extension → Training Studio handoff. */
async function ingestTrace(request, response) {
  const trace = await readJson(request, 2_000_000);
  if (trace?.version !== 1 || typeof trace.sessionId !== "string" || !Array.isArray(trace.observations)) {
    send(response, 400, { error: "A version 1 observation trace is required." }, corsHeaders(request));
    return;
  }

  traces.set(trace.sessionId, { trace, receivedAt: new Date().toISOString() });
  while (traces.size > MAX_TRACES) traces.delete(traces.keys().next().value);

  console.log(`trace ${trace.sessionId}: ${trace.observations.length} observations from ${trace.application.host}`);
  send(response, 201, { sessionId: trace.sessionId, observations: trace.observations.length }, corsHeaders(request));
}

/** The publication boundary. Confirmation is the gate, so it is checked here too. */
function capabilityProblem(capability) {
  if (!capability || typeof capability !== "object") return "A capability object is required.";
  if (!/^[a-z][a-z0-9_]*$/.test(capability.id ?? "")) return "Capability id must be lower snake case.";
  if (typeof capability.name !== "string" || capability.name === "") return "Capability name is required.";
  if (!Array.isArray(capability.inputs)) return "Capability inputs must be an array.";
  if (capability.provenance?.source !== "confirmed" || capability.provenance?.confirmedByHuman !== true) {
    return "Only a human-confirmed capability can be published.";
  }

  // Understanding a workflow and knowing how to execute it are separate
  // achievements. Publication requires both, and the UI is not the only gate.
  const binding = capability.binding;
  if (!binding || typeof binding.application !== "string" || typeof binding.action !== "string") {
    return "A capability with no execution binding cannot be published.";
  }
  const source = capability.provenance?.sourceApplication;
  if (source && source.id !== binding.application) {
    return "An execution binding must belong to the application the capability was learned from.";
  }
  return undefined;
}

async function publishCapability(request, response) {
  const body = await readJson(request, 200_000);
  const capability = body?.capability;
  const problem = capabilityProblem(capability);
  if (problem) {
    send(response, 400, { error: problem }, corsHeaders(request));
    return;
  }

  // Carried alongside, not required by, the gate above: a browser execution
  // binding is declarative metadata a later invoker can use to find *how* to
  // perform the capability, the same idea `binding/browserExecution/model.ts`
  // documents on the client side. Passthrough only — this server does not
  // interpret it.
  const record = {
    capability,
    publishedAt: new Date().toISOString(),
    ...(body?.executionBinding ? { executionBinding: body.executionBinding } : {}),
    ...(body?.queryBinding ? { queryBinding: body.queryBinding } : {})
  };
  publications.set(capability.id, record);
  console.log(`published capability ${capability.id}`);
  send(response, 201, record, corsHeaders(request));
}

async function semanticize(request, response) {
  if (!openai) {
    send(response, 503, { error: "OPENAI_API_KEY is not configured on this server." });
    return;
  }

  const input = await readJson(request, 500_000);
  if (input?.traceKind !== "extension" || !Array.isArray(input?.trace)) {
    send(response, 400, { error: "An extension observation trace is required." });
    return;
  }

  const instructions = [
    "Infer exactly ONE lightweight candidate business capability from the observed evidence.",
    "Move up an abstraction level: the whole demonstration is one capability, never one capability per UI step.",
    "Never propose per-step primitives such as opening a record, setting a filter, or clicking a result.",
    "Do not invent application truth, selectors, APIs, workflows, or validation rules.",
    "Name the capability for the business outcome, never for the sequence of UI steps.",
    "Generalize: the specific values the human chose become inputs, never part of the capability name.",
    "Every id, input name, and output name must be lower snake case derived from the visible label.",
    "Return an inferred, unconfirmed candidate; a human confirms it separately.",
    "The evidence was observed by a browser extension on a real application.",
    "Each observation carries an action, the field label and section it touched, the value transition, and how the application reacted.",
    "Derive inputs from the fields the human actually varied, using their visible labels.",
    "Set binding to null unless the evidence directly establishes a named existing application action."
  ];

  const model = process.env.OPENAI_MODEL ?? "gpt-5.4";
  const modelInput = JSON.stringify({
    application: input.application,
    platform: input.platform ?? "generic",
    trace: input.trace,
    uiLabels: input.uiLabels ?? []
  });

  const requestedAt = Date.now();
  const modelResponse = await openai.responses.create({
    model,
    store: false,
    instructions: instructions.join(" "),
    input: modelInput,
    text: {
      format: {
        type: "json_schema",
        name: "semantic_capability",
        strict: true,
        schema: capabilitySchema
      }
    }
  });

  /**
   * The server keeps building the prompt; it just stops being the only thing
   * that ever sees it. The raw model output is returned unparsed so a bad
   * model response and a bad parser are distinguishable downstream.
   *
   * Everything here is already safe to show: instructions are static text, the
   * input is the sanitized evidence trace, and no credential is in scope.
   * `output_text` is the provider-visible response, not hidden reasoning, which
   * is neither requested nor stored.
   */
  send(response, 200, {
    raw: modelResponse.output_text,
    diagnostics: {
      runId: `run-${requestedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      requestedAt: new Date(requestedAt).toISOString(),
      latencyMs: Date.now() - requestedAt,
      model,
      promptVersion: SEMANTICIZER_PROMPT_VERSION,
      instructions,
      input: modelInput,
      parameters: {
        store: false,
        responseFormat: "json_schema",
        schemaName: "semantic_capability",
        strict: true
      },
      ...(modelResponse.id ? { providerResponseId: modelResponse.id } : {})
    }
  });
}

/**
 * Binding inference. A different question from semantic inference, so a
 * separate call, separate prompt version, and separate run history.
 */
async function inferBindingCandidate(request, response) {
  if (!openai) {
    send(response, 503, { error: "OPENAI_API_KEY is not configured on this server." });
    return;
  }

  const input = await readJson(request, 200_000);
  if (!input?.capability?.id || !Array.isArray(input?.causalCandidates)) {
    send(response, 400, { error: "A prepared binding-candidate input is required." });
    return;
  }

  const instructions = [
    "Propose which reusable, supported execution mechanism should be investigated as the binding for a demonstrated capability.",
    "You are given a semantic capability, the application it was demonstrated on, and the request that most plausibly carried the action.",
    "The observed transport is evidence of what happened. It is never permission to call it, and you must never propose replaying it.",
    "Propose a FAMILY of supported mechanisms, never a specific URL, payload, or code.",
    "Respect the supplied platform policy: never claim an eligibility stronger than its maximum, and treat its warnings as binding.",
    "An internal or unversioned transport means the supported equivalent is the candidate, and it is unvalidated.",
    "Prefer honest uncertainty. If the evidence does not support a mechanism, return a null candidate with eligibility no-safe-candidate.",
    "Evidence entries must describe what was observed, in plain language, without asserting causation."
  ];

  const model = process.env.OPENAI_BINDING_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4";
  const modelInput = JSON.stringify(input);
  const requestedAt = Date.now();

  const modelResponse = await openai.responses.create({
    model,
    store: false,
    instructions: instructions.join(" "),
    input: modelInput,
    text: {
      format: { type: "json_schema", name: "binding_candidate", strict: true, schema: bindingCandidateSchema }
    }
  });

  send(response, 200, {
    raw: modelResponse.output_text,
    diagnostics: {
      runId: `bind-${requestedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      requestedAt: new Date(requestedAt).toISOString(),
      latencyMs: Date.now() - requestedAt,
      model,
      promptVersion: BINDING_PROMPT_VERSION,
      instructions,
      input: modelInput,
      parameters: { store: false, responseFormat: "json_schema", schemaName: "binding_candidate", strict: true },
      ...(modelResponse.id ? { providerResponseId: modelResponse.id } : {})
    }
  });
}

/**
 * Development reset. Clears the ephemeral control plane and nothing else: no
 * source application data, no configuration, no code. Everything it drops was
 * already lost on restart.
 */
function resetControlPlane(request, response) {
  const cleared = { traces: traces.size, publications: publications.size };
  traces.clear();
  publications.clear();
  console.log(`control plane reset: ${cleared.traces} traces, ${cleared.publications} publications`);
  send(response, 200, { cleared: true, ...cleared }, corsHeaders(request));
}

const mimeTypes = { ".css": "text/css", ".html": "text/html", ".js": "application/javascript", ".svg": "image/svg+xml" };

createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS" && request.url?.startsWith("/api/")) {
      response.writeHead(204, corsHeaders(request));
      response.end();
      return;
    }
    if (request.method === "POST" && request.url === "/api/semanticize") {
      await semanticize(request, response);
      return;
    }
    if (request.method === "POST" && request.url === "/api/binding-candidate") {
      await inferBindingCandidate(request, response);
      return;
    }
    if (request.method === "POST" && request.url === "/api/debug/reset") {
      resetControlPlane(request, response);
      return;
    }
    if (request.method === "POST" && request.url === "/api/traces") {
      await ingestTrace(request, response);
      return;
    }
    if (request.method === "POST" && request.url === "/api/capabilities") {
      await publishCapability(request, response);
      return;
    }
    if (request.method === "GET" && request.url === "/api/capabilities") {
      send(response, 200, { publications: [...publications.values()] }, corsHeaders(request));
      return;
    }
    if (request.method === "DELETE" && request.url === "/api/capabilities") {
      const removed = publications.size;
      publications.clear();
      console.log(`unpublished ${removed} capabilities`);
      send(response, 200, { removed }, corsHeaders(request));
      return;
    }
    if (request.method === "GET" && request.url === "/api/traces") {
      send(response, 200, { traces: [...traces.values()].map(summarizeTrace).reverse() }, corsHeaders(request));
      return;
    }
    if (request.method === "PATCH" && request.url?.startsWith("/api/traces/") && request.url.endsWith("/recording")) {
      const sessionId = decodeURIComponent(request.url.slice("/api/traces/".length, -"/recording".length));
      const summary = updateTraceRecording(sessionId, await readJson(request, 20_000));
      if (!summary) send(response, 404, { error: "Unknown trace." }, corsHeaders(request));
      else send(response, 200, summary, corsHeaders(request));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/traces/")) {
      const entry = traces.get(decodeURIComponent(request.url.slice("/api/traces/".length)));
      if (!entry) send(response, 404, { error: "Unknown trace." }, corsHeaders(request));
      else send(response, 200, entry.trace, corsHeaders(request));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, { error: "Method not allowed" });
      return;
    }

    const requestedPath = request.url?.split("?")[0] ?? "/";
    const candidate = normalize(join(staticRoot, requestedPath === "/" ? "index.html" : requestedPath));
    const filePath = candidate.startsWith(staticRoot) && existsSync(candidate) ? candidate : join(staticRoot, "index.html");
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Permissions-Policy": "webmcp=(self)"
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : "Internal error" });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`AutoWebMCP server listening on http://127.0.0.1:${port}`);
});
