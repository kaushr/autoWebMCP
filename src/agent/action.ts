import type { AgentAction, AgentToolArguments, AgentToolDefinition } from "./model";
import type { JsonObjectSchema } from "../webmcp/types";

/* ------------------------------------------------------------------ *
 * Turning what the model said into something that may be executed —
 * or refusing to.
 *
 * The gate, not a formality. The model is choosing from a live tool set it
 * was shown, and the only two ways it can be wrong that matter here are
 * naming a tool that is not on the surface, and supplying arguments the
 * published schema does not accept. Both are refused before anything is
 * invoked, because the alternative is an application discovering the
 * problem, which for a mutation means discovering it by performing one.
 *
 * Refusal is terminal, deliberately. Re-asking with the error attached
 * would be a retry loop, and this shell has no retries: an action that did
 * not validate stops the run and is shown as what it was.
 * ------------------------------------------------------------------ */

export type ActionDecision =
  | { ok: true; action: AgentAction }
  | { ok: false; reason: string };

/**
 * The structured response shape the control plane asks the model for.
 *
 * Flat with sentinel fields rather than a union, because strict JSON-schema
 * structured outputs require every property to be present: `tool` and
 * `arguments_json` are empty when finishing, `summary` is empty when
 * calling. Arguments travel as a JSON STRING for the same reason — a
 * free-form object cannot be expressed under `additionalProperties: false`
 * — and are parsed and validated here, never evaluated.
 */
export interface RawAgentAction {
  action?: unknown;
  tool?: unknown;
  arguments_json?: unknown;
  summary?: unknown;
}

/**
 * Decides whether the model's answer is something the loop may perform.
 *
 * `tools` is the LIVE list, read from the browser on this step. A tool that
 * was published a minute ago and is not there now is not callable now, and
 * checking against anything else — a registry, a cached list, the set the
 * run started with — would be checking against a claim rather than a fact.
 */
export function decideAction(raw: unknown, tools: readonly AgentToolDefinition[]): ActionDecision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "The model did not return an action object." };
  }
  const value = raw as RawAgentAction;

  if (value.action === "finish") {
    const summary = typeof value.summary === "string" ? value.summary.trim() : "";
    if (!summary) return { ok: false, reason: "The model finished without saying what it had established." };
    return { ok: true, action: { action: "finish", summary } };
  }

  if (value.action !== "call_tool") {
    return { ok: false, reason: `"${String(value.action)}" is not an action this loop performs.` };
  }

  const name = typeof value.tool === "string" ? value.tool.trim() : "";
  if (!name) return { ok: false, reason: "The model chose to call a tool without naming one." };

  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    return {
      ok: false,
      reason:
        `"${name}" is not registered on this document. The tools the browser currently reports are: ` +
        `${tools.map((entry) => entry.name).join(", ") || "none"}.`
    };
  }

  const parsed = parseArgumentsJson(value.arguments_json);
  if (!parsed.ok) return { ok: false, reason: `${name}: ${parsed.reason}` };

  const validated = validateToolArguments(tool.inputSchema, parsed.value);
  if (!validated.ok) return { ok: false, reason: `${name}: ${validated.errors.join(" ")}` };

  return { ok: true, action: { action: "call_tool", tool: name, arguments: validated.args } };
}

function parseArgumentsJson(value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: {} };
  if (typeof value !== "string") return { ok: false, reason: "arguments must arrive as a JSON string." };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, reason: "the arguments were not valid JSON." };
  }
}

export interface ArgumentValidation {
  ok: boolean;
  args: AgentToolArguments;
  errors: string[];
}

/**
 * Checks arguments against the tool's own published schema.
 *
 * This is also the entire answer to "how do we know the model cannot send
 * a selector, an XPath, or a script?". It cannot, structurally: the only
 * keys that survive are properties the schema declares, and the only
 * values that survive are the primitives it declares them to hold. There
 * is no free-form key, no nested object, and no array — so there is
 * nowhere for an instruction to the browser to sit, and the strings that
 * do pass are field values the execution runtime writes into controls it
 * resolved itself.
 *
 * A tool whose schema the browser did not publish accepts NO arguments,
 * rather than everything: an unpublished contract is an unknown one, and
 * an unknown contract is not a licence.
 */
export function validateToolArguments(schema: JsonObjectSchema | undefined, value: unknown): ArgumentValidation {
  const errors: string[] = [];
  const args: AgentToolArguments = {};

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, args, errors: ["arguments must be a JSON object."] };
  }
  const supplied = value as Record<string, unknown>;

  if (!schema) {
    const extra = Object.keys(supplied);
    if (extra.length > 0) {
      return {
        ok: false,
        args,
        errors: [`this browser publishes no input schema for it, so no argument can be checked (${extra.join(", ")}).`]
      };
    }
    return { ok: true, args, errors };
  }

  const declared = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(supplied)) {
    if (!declared.has(key)) errors.push(`"${key}" is not a parameter it declares.`);
  }

  for (const [name, property] of Object.entries(schema.properties)) {
    const raw = supplied[name];
    const required = (schema.required ?? []).includes(name);

    if (raw === undefined || raw === null) {
      if (required) errors.push(`"${name}" is required.`);
      continue;
    }
    if (typeof raw === "object") {
      // Covers arrays too. A declared primitive that arrives as a structure
      // is the one shape that could carry something other than a value.
      errors.push(`"${name}" must be a single ${property.type} value.`);
      continue;
    }
    if (Array.isArray(property.enum) && property.enum.length > 0 && !property.enum.includes(String(raw))) {
      errors.push(`"${String(raw)}" is not one of the values "${name}" accepts (${property.enum.join(", ")}).`);
      continue;
    }
    switch (property.type) {
      case "string":
        if (typeof raw !== "string") {
          errors.push(`"${name}" must be text.`);
          continue;
        }
        args[name] = raw;
        break;
      case "number":
      case "integer": {
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          errors.push(`"${name}" must be a number.`);
          continue;
        }
        if (property.type === "integer" && !Number.isInteger(raw)) {
          errors.push(`"${name}" must be a whole number.`);
          continue;
        }
        args[name] = raw;
        break;
      }
      case "boolean":
        if (typeof raw !== "boolean") {
          errors.push(`"${name}" must be true or false.`);
          continue;
        }
        args[name] = raw;
        break;
      default:
        errors.push(`"${name}" has a schema this loop does not send.`);
    }
  }

  return { ok: errors.length === 0, args, errors };
}
