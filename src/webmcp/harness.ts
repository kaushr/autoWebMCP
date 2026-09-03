import type { ExecutionResult } from "../binding/browserExecution/result";
import type { JsonObjectSchema, ModelContext, WebMcpToolResult } from "./types";

/* ------------------------------------------------------------------ *
 * The judge-facing WebMCP test harness.
 *
 * One job: let a person exercise a published capability through the SAME
 * surface an agent uses, and say truthfully which surface that was.
 *
 * The temptation this module exists to resist is calling the capability's
 * own execute callback and labelling the result "WebMCP". That would prove
 * nothing an agent cares about — the whole question is whether the tool is
 * discoverable and callable through `document.modelContext`, not whether
 * our own code can call our own code.
 *
 * So the browser's actual API is FEATURE-DETECTED rather than assumed.
 * Registration, discovery, and invocation are three separate permissions
 * here, because a browser may reasonably offer the first without the
 * others: registration is page-side by definition, while discovery and
 * invocation could legitimately be reserved for the agent. Whatever this
 * browser actually permits is what the UI is allowed to claim.
 * ------------------------------------------------------------------ */

/** What this browser's WebMCP implementation actually lets a page do. */
export interface WebMcpSurface {
  /** `document.modelContext` exists at all. */
  available: boolean;
  /** A page may enumerate the tools an agent would see. */
  canDiscover: boolean;
  /** A page may invoke a registered tool through WebMCP itself. */
  canInvoke: boolean;
}

export function describeWebMcpSurface(modelContext: ModelContext | undefined): WebMcpSurface {
  if (!modelContext) return { available: false, canDiscover: false, canInvoke: false };
  return {
    available: typeof modelContext.registerTool === "function",
    canDiscover: typeof modelContext.getTools === "function",
    canInvoke: typeof modelContext.executeTool === "function"
  };
}

/**
 * Where a displayed tool list came from — which decides what the UI may
 * call it.
 *
 * `discovered` means the browser answered. `registered` means this
 * document is reporting what it itself passed to `registerTool`, which is
 * evidence of registration and NOT evidence of agent-side discovery. The
 * distinction is the entire point: an internal registry rendered under the
 * heading "tools an agent can see" would be a claim we have not checked.
 */
export type ToolListingSource = "discovered" | "registered";

/**
 * How a judge's invocation actually reached the capability.
 *
 * `webmcp` is only ever set after `executeTool` returned; anything else is
 * `direct`, and the UI must label it as bypassing WebMCP.
 */
export type InvocationRoute = "webmcp" | "direct";

/* ----------------------------- the form ----------------------------- */

export type HarnessControl = "text" | "number" | "integer" | "boolean" | "enum" | "date" | "unsupported";

/** One control, derived entirely from the published schema. */
export interface HarnessField {
  name: string;
  description: string;
  required: boolean;
  control: HarnessControl;
  /** Present for `enum`: the legal values, exactly as published. */
  options?: string[];
  /** Present for `unsupported`: the schema fragment, shown rather than guessed at. */
  rawSchema?: string;
}

/**
 * The tool's input schema, whatever shape the browser hands it back in.
 *
 * Chrome's WebMCP prototype returns `inputSchema` as a JSON STRING from
 * `getTools()`, while `registerTool` takes an object. Assuming the object
 * form produced a form with no fields at all — and an invocation with no
 * arguments, which the page reported as a tool that answered badly rather
 * than as a caller that asked badly.
 *
 * Both shapes are accepted because both are real: the object is what this
 * page registered, and the string is what the browser gives back.
 */
export function normalizeInputSchema(schema: unknown): JsonObjectSchema | undefined {
  if (typeof schema === "string") {
    try {
      return normalizeInputSchema(JSON.parse(schema));
    } catch {
      return undefined;
    }
  }
  if (!schema || typeof schema !== "object") return undefined;
  const candidate = schema as JsonObjectSchema;
  return candidate.type === "object" && candidate.properties ? candidate : undefined;
}

/**
 * Builds the judge's form from the tool's own input schema.
 *
 * Nothing here knows what a Stage or a Close Date is, and it must stay that
 * way: the harness demonstrates that an agent could drive this capability
 * from its published contract alone, which is only true if the form is
 * built from that contract alone. A property whose shape this does not
 * handle becomes `unsupported` and is shown as raw schema — an honest
 * "I don't render this" beats a control that silently sends the wrong type.
 */
export function harnessFieldsFor(schema: JsonObjectSchema | string | undefined): HarnessField[] {
  const parsed = normalizeInputSchema(schema);
  if (!parsed) return [];
  const required = new Set(parsed.required ?? []);

  return Object.entries(parsed.properties).map(([name, property]) => {
    const base = {
      name,
      description: property?.description ?? "",
      required: required.has(name)
    };
    if (!property || typeof property !== "object") {
      return { ...base, control: "unsupported" as const, rawSchema: JSON.stringify(property) };
    }
    // An enum is a closed domain whatever its base type, so it outranks the
    // type when choosing a control: the legal values are more useful to a
    // caller than the fact that they happen to be strings.
    if (Array.isArray(property.enum) && property.enum.length > 0) {
      return { ...base, control: "enum" as const, options: [...property.enum] };
    }
    switch (property.type) {
      case "string":
        // `format` is the schema saying so. A description mentioning dates
        // is prose, and prose is not a contract.
        return { ...base, control: property.format === "date" ? ("date" as const) : ("text" as const) };
      case "number":
        return { ...base, control: "number" as const };
      case "integer":
        return { ...base, control: "integer" as const };
      case "boolean":
        return { ...base, control: "boolean" as const };
      default:
        return { ...base, control: "unsupported" as const, rawSchema: JSON.stringify(property) };
    }
  });
}

export type InvocationArguments = Record<string, string | number | boolean>;

export interface ArgumentCollection {
  ok: boolean;
  /** Typed per the schema — a number property never leaves here as a string. */
  args: InvocationArguments;
  /** Why the invocation must not be attempted, in words a judge can act on. */
  errors: string[];
}

/**
 * Turns what the judge typed into the arguments the published schema
 * declares, refusing rather than coercing when they do not fit.
 *
 * An omitted OPTIONAL field is left out of the arguments entirely rather
 * than sent as an empty string: "not supplied" and "supplied as blank" are
 * different instructions to the executor, and the execution engine already
 * treats them differently.
 */
export function collectInvocationArguments(
  fields: readonly HarnessField[],
  raw: Readonly<Record<string, string>>
): ArgumentCollection {
  const args: InvocationArguments = {};
  const errors: string[] = [];

  for (const field of fields) {
    const value = raw[field.name]?.trim() ?? "";

    if (field.control === "unsupported") {
      if (field.required) {
        errors.push(`"${field.name}" has a schema this test form cannot render, so it cannot be supplied here.`);
      }
      continue;
    }

    if (field.control === "boolean") {
      // A checkbox always has an answer; absence is false, not omission.
      args[field.name] = raw[field.name] === "true";
      continue;
    }

    if (!value) {
      if (field.required) errors.push(`"${field.name}" is required.`);
      continue;
    }

    switch (field.control) {
      case "enum":
        if (!field.options?.includes(value)) {
          errors.push(
            `"${value}" is not one of the values "${field.name}" accepts (${field.options?.join(", ") ?? "none published"}).`
          );
          continue;
        }
        args[field.name] = value;
        break;
      case "number":
      case "integer": {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || (field.control === "integer" && !Number.isInteger(parsed))) {
          errors.push(`"${field.name}" must be ${field.control === "integer" ? "a whole number" : "a number"}.`);
          continue;
        }
        args[field.name] = parsed;
        break;
      }
      default:
        args[field.name] = value;
    }
  }

  return { ok: errors.length === 0, args, errors };
}

/* --------------------------- the result --------------------------- */

/**
 * What came back from a tool call.
 *
 * A WebMCP result is a list of text blocks, and this capability's blocks
 * carry a JSON-encoded `ExecutionResult`. Parsing is attempted and its
 * failure is reported as itself: a tool that answered with something else
 * is a fact worth showing, not an error to swallow.
 */
export interface HarnessInvocationOutcome {
  route: InvocationRoute;
  /** The decoded execution result, when the tool returned one. */
  execution?: ExecutionResult;
  /** The raw text the tool returned, always kept. */
  text: string;
  /** Set when the text was not a result this panel understands. */
  unparsed?: string;
}

/** Text carried by a WebMCP content envelope, in whatever shape it arrives. */
function textFromEnvelope(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const content = (value as WebMcpToolResult).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  // Any entry carrying text counts. The envelope is the browser's, and
  // discarding text that is plainly there because a `type` field is absent
  // would report a caller's problem as the tool's.
  const text = content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

/** How deep to keep unwrapping before concluding the payload is not ours. */
const MAX_ENVELOPE_DEPTH = 4;

/**
 * Reads what a tool returned, through however many envelopes it arrives in.
 *
 * A live invocation established that Chrome's `executeTool` resolves with
 * the ENTIRE result envelope serialized as a string — so the payload is a
 * JSON string, containing an envelope, whose content entry holds another
 * JSON string, which is the execution result. Unwrapping one layer found
 * valid JSON that was not a result, and the panel blamed the tool for a
 * shape it had itself failed to open.
 *
 * So layers are peeled until something answers to being an execution
 * result, bounded rather than unbounded: a payload that never becomes one
 * is reported as what it is, with the raw text kept for reading.
 */
export function readToolResult(result: WebMcpToolResult | string, route: InvocationRoute): HarnessInvocationOutcome {
  const text = textFromEnvelope(result);
  if (!text) return { route, text: "", unparsed: "The tool returned no readable content." };

  let payload = text;
  for (let depth = 0; depth < MAX_ENVELOPE_DEPTH; depth++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return {
        route,
        text,
        unparsed: depth === 0 ? "The tool's response was not JSON." : "The tool's response did not contain a result."
      };
    }

    if (isExecutionResult(parsed)) return { route, execution: parsed, text };

    // Not a result, but possibly another envelope around one.
    const inner = textFromEnvelope(parsed);
    if (!inner || inner === payload) {
      return { route, text, unparsed: "The tool returned JSON that is not an execution result." };
    }
    payload = inner;
  }

  return { route, text, unparsed: "The tool's response was nested more deeply than this panel unwraps." };
}

/** Whether a decoded payload is an execution result rather than something else shaped like JSON. */
function isExecutionResult(value: unknown): value is ExecutionResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as ExecutionResult;
  return Array.isArray(candidate.checks) && typeof candidate.status === "string";
}

/**
 * How a judge should read one input's outcome.
 *
 * `unverifiable` exists so that "we could not check" never renders as a
 * tick. An execution that wrote a date whose ordering the org never
 * established is exactly this case, and reporting it as verified would
 * undo the guarantee the date rule exists to provide.
 */
export type JudgeVerdict = "verified" | "mismatch" | "unverifiable";

export function verdictFor(transaction: { verified: "yes" | "no" | "unreadable" }): JudgeVerdict {
  if (transaction.verified === "yes") return "verified";
  if (transaction.verified === "no") return "mismatch";
  return "unverifiable";
}
