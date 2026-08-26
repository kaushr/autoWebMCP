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

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100_000) throw new Error("Request too large");
  }
  return JSON.parse(body);
}

async function semanticize(request, response) {
  if (!openai) {
    send(response, 503, { error: "OPENAI_API_KEY is not configured on this server." });
    return;
  }

  const input = await readJson(request);
  if (input?.application !== "prospect-intelligence" || !Array.isArray(input?.trace)) {
    send(response, 400, { error: "A Prospect Intelligence observation trace is required." });
    return;
  }

  const modelResponse = await openai.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5.4",
    store: false,
    instructions: [
      "Infer only a lightweight candidate business capability from observed evidence.",
      "Do not invent application truth, selectors, APIs, workflows, or validation rules.",
      "Choose an action from the supplied allowlist only when it is directly supported by the trace.",
      "For find_contacts, use company_id as the required company reference; optional inputs are function, seniority, and title_keywords.",
      "Return an inferred, unconfirmed candidate; a human confirms it separately."
    ].join(" "),
    input: JSON.stringify({ trace: input.trace, uiLabels: input.uiLabels ?? [] }),
    text: { format: { type: "json_schema", name: "semantic_capability", strict: true, schema: capabilitySchema } }
  });

  send(response, 200, JSON.parse(modelResponse.output_text));
}

const mimeTypes = { ".css": "text/css", ".html": "text/html", ".js": "application/javascript", ".svg": "image/svg+xml" };

createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/api/semanticize") {
      await semanticize(request, response);
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
