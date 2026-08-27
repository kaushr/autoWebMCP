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
              type: { type: "string", enum: ["string", "number", "boolean"] },
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
          type: "object",
          additionalProperties: false,
          required: ["application", "action"],
          properties: {
            application: { type: "string", enum: ["prospect-intelligence"] },
            action: { type: "string", enum: ["search_companies", "find_contacts", "get_contact"] }
          }
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
 * Extension traces come from arbitrary applications, so no binding allowlist
 * applies: the model may return `binding: null` when the evidence does not
 * establish an execution path. Discovering a binding is a separate step.
 */
const extensionCapabilitySchema = structuredClone(capabilitySchema);
extensionCapabilitySchema.properties.candidate.properties.binding = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["application", "action"],
  properties: { application: { type: "string" }, action: { type: "string" } }
};

/** Ephemeral in-memory handoff buffer. Traces are never written to disk. */
const traces = new Map();
const MAX_TRACES = 20;

function corsHeaders(request) {
  const origin = request.headers.origin ?? "";
  const allowed = /^chrome-extension:\/\//.test(origin) || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  return allowed
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    startedAt: trace.startedAt,
    observations: trace.observations.length,
    receivedAt
  };
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

async function semanticize(request, response) {
  if (!openai) {
    send(response, 503, { error: "OPENAI_API_KEY is not configured on this server." });
    return;
  }

  const input = await readJson(request, 500_000);
  const fromExtension = input?.traceKind === "extension";
  if (!Array.isArray(input?.trace) || (!fromExtension && input?.application !== "prospect-intelligence")) {
    send(response, 400, { error: "An observation trace is required." });
    return;
  }

  const sharedInstructions = [
    "Infer only a lightweight candidate business capability from observed evidence.",
    "Do not invent application truth, selectors, APIs, workflows, or validation rules.",
    "Name the capability for the business outcome, never for the sequence of UI steps.",
    "The id must be lower snake case.",
    "Return an inferred, unconfirmed candidate; a human confirms it separately."
  ];

  const instructions = fromExtension
    ? [
        ...sharedInstructions,
        "The evidence was observed by a browser extension on a real application.",
        "Each observation carries an action, the field label and section it touched, the value transition, and how the application reacted.",
        "Derive inputs from the fields the human actually varied, using their visible labels.",
        "Set binding to null unless the evidence directly establishes a named existing application action."
      ]
    : [
        ...sharedInstructions,
        "Choose an action from the supplied allowlist only when it is directly supported by the trace.",
        "For find_contacts, use company_id as the required company reference; optional inputs are function, seniority, and title_keywords."
      ];

  const modelResponse = await openai.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5.4",
    store: false,
    instructions: instructions.join(" "),
    input: JSON.stringify({
      application: input.application,
      ...(fromExtension ? { platform: input.platform ?? "generic" } : {}),
      trace: input.trace,
      uiLabels: input.uiLabels ?? []
    }),
    text: {
      format: {
        type: "json_schema",
        name: "semantic_capability",
        strict: true,
        schema: fromExtension ? extensionCapabilitySchema : capabilitySchema
      }
    }
  });

  send(response, 200, JSON.parse(modelResponse.output_text));
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
    if (request.method === "POST" && request.url === "/api/traces") {
      await ingestTrace(request, response);
      return;
    }
    if (request.method === "GET" && request.url === "/api/traces") {
      send(response, 200, { traces: [...traces.values()].map(summarizeTrace).reverse() }, corsHeaders(request));
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
