import { describe, expect, it } from "vitest";
import {
  collectInvocationArguments,
  describeWebMcpSurface,
  harnessFieldsFor,
  normalizeInputSchema,
  readToolResult,
  verdictFor
} from "../src/webmcp/harness";
import { compileCapability } from "../src/webmcp/compiler";
import type { ModelContext } from "../src/webmcp/types";
import type { SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * The judge harness.
 *
 * Two things these exist to protect. First, that the form is built from a
 * published schema and nothing else — a harness that knew what a "stage"
 * was would prove nothing about whether an agent could drive the tool from
 * its contract alone. Second, that the UI never claims a WebMCP invocation
 * it did not make.
 * ------------------------------------------------------------------ */

const capability = (inputs: SemanticCapability["inputs"]): SemanticCapability => ({
  id: "book_room",
  name: "Book a room",
  description: "Reserve a meeting room.",
  inputs,
  outputs: [],
  provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true },
  safety: { readOnly: false, requiresConfirmation: true }
});

/* ---------------------- what the browser permits ---------------------- */

describe("the panel claims only what this browser actually offers", () => {
  it("reports nothing available with no modelContext", () => {
    expect(describeWebMcpSurface(undefined)).toEqual({ available: false, canDiscover: false, canInvoke: false });
  });

  it("separates registration from discovery and invocation", () => {
    // A browser may reasonably let a page register while reserving
    // discovery and invocation for the agent. That must not read as full
    // support.
    const registrationOnly = { registerTool: () => undefined } as unknown as ModelContext;
    expect(describeWebMcpSurface(registrationOnly)).toEqual({
      available: true,
      canDiscover: false,
      canInvoke: false
    });
  });

  it("reports full support only when all three are present", () => {
    const full = {
      registerTool: () => undefined,
      getTools: async () => [],
      executeTool: async () => ({ content: [] })
    } as unknown as ModelContext;
    expect(describeWebMcpSurface(full)).toEqual({ available: true, canDiscover: true, canInvoke: true });
  });
});

/* -------------------- the form comes from the schema -------------------- */

describe("the form is generated from the published schema", () => {
  it("renders each primitive from its declared type, for a tool with no Salesforce in it", () => {
    // Deliberately nothing to do with opportunities. If the harness had
    // special knowledge of `stage` or `close_date`, this would not work.
    const tool = compileCapability(
      capability([
        { name: "room", description: "Which room", type: "string", required: true },
        { name: "guests", description: "How many people", type: "number", required: true },
        { name: "smoking", description: "Smoking permitted", type: "boolean", required: false },
        { name: "arrival", description: "Day of arrival", type: "date", required: true }
      ]),
      () => ({})
    );

    const fields = harnessFieldsFor(tool.inputSchema);
    expect(fields.map((field) => [field.name, field.control])).toEqual([
      ["room", "text"],
      ["guests", "number"],
      ["smoking", "boolean"],
      ["arrival", "date"]
    ]);
    expect(fields.find((field) => field.name === "room")?.required).toBe(true);
    expect(fields.find((field) => field.name === "smoking")?.required).toBe(false);
  });

  it("renders a published value domain as a constrained choice", () => {
    const tool = compileCapability(
      capability([
        { name: "room", description: "Which room", type: "string", required: true, enum: ["Oak", "Elm", "Ash"] }
      ]),
      () => ({})
    );
    const [field] = harnessFieldsFor(tool.inputSchema);
    expect(field.control).toBe("enum");
    expect(field.options).toEqual(["Oak", "Elm", "Ash"]);
  });

  it("takes the date from the schema's own format, not from its prose", () => {
    // The description mentioning a date is not a contract; `format` is.
    const described = harnessFieldsFor({
      type: "object",
      properties: { when: { type: "string", description: "the date of the thing (date, YYYY-MM-DD)" } },
      additionalProperties: false
    });
    expect(described[0].control).toBe("text");

    const declared = harnessFieldsFor({
      type: "object",
      properties: { when: { type: "string", description: "the date", format: "date" } },
      additionalProperties: false
    });
    expect(declared[0].control).toBe("date");
  });

  it("shows a schema it cannot render rather than guessing at a control", () => {
    const fields = harnessFieldsFor({
      type: "object",
      properties: { attendees: { type: "array", description: "who is coming" } as never },
      additionalProperties: false
    });
    expect(fields[0].control).toBe("unsupported");
    expect(fields[0].rawSchema).toContain("array");
  });

  it("returns nothing for an absent schema instead of failing", () => {
    expect(harnessFieldsFor(undefined)).toEqual([]);
  });
});

/* ------------------------- arguments ------------------------- */

describe("arguments match the published schema, or the call is refused", () => {
  const fields = harnessFieldsFor(
    compileCapability(
      capability([
        { name: "room", description: "Which room", type: "string", required: true, enum: ["Oak", "Elm"] },
        { name: "guests", description: "How many", type: "number", required: true },
        { name: "smoking", description: "Smoking", type: "boolean", required: false },
        { name: "note", description: "Anything else", type: "string", required: false }
      ]),
      () => ({})
    ).inputSchema
  );

  it("produces exactly the arguments the schema declares, correctly typed", () => {
    const collected = collectInvocationArguments(fields, { room: "Oak", guests: "4", smoking: "true", note: "quiet" });
    expect(collected.ok).toBe(true);
    // `guests` is a number, not the string the form held.
    expect(collected.args).toEqual({ room: "Oak", guests: 4, smoking: true, note: "quiet" });
  });

  it("omits an unsupplied optional rather than sending it empty", () => {
    // "not supplied" and "supplied as blank" are different instructions,
    // and the execution engine already treats them differently.
    const collected = collectInvocationArguments(fields, { room: "Elm", guests: "2" });
    expect(collected.ok).toBe(true);
    expect(collected.args).toEqual({ room: "Elm", guests: 2, smoking: false });
    expect("note" in collected.args).toBe(false);
  });

  it("refuses a missing required input", () => {
    const collected = collectInvocationArguments(fields, { guests: "2" });
    expect(collected.ok).toBe(false);
    expect(collected.errors.join(" ")).toMatch(/"room" is required/);
  });

  it("refuses a value outside the published domain", () => {
    const collected = collectInvocationArguments(fields, { room: "Birch", guests: "2" });
    expect(collected.ok).toBe(false);
    expect(collected.errors.join(" ")).toMatch(/not one of the values/);
  });

  it("refuses a non-number where the schema declares one", () => {
    const collected = collectInvocationArguments(fields, { room: "Oak", guests: "several" });
    expect(collected.ok).toBe(false);
    expect(collected.errors.join(" ")).toMatch(/must be a number/);
  });

  it("refuses a fractional value where the schema declares an integer", () => {
    const integerField = harnessFieldsFor({
      type: "object",
      properties: { count: { type: "integer", description: "how many" } },
      required: ["count"],
      additionalProperties: false
    });
    expect(collectInvocationArguments(integerField, { count: "2.5" }).ok).toBe(false);
    expect(collectInvocationArguments(integerField, { count: "2" }).args).toEqual({ count: 2 });
  });
});

/* ------------------------- the result ------------------------- */

describe("results are read faithfully", () => {
  const executionResult = {
    status: "partially_verified",
    checks: [{ name: "value_set", status: "pass", detail: "written" }],
    transactions: [
      { name: "arrival", requestedValue: "2027-03-01", verified: "unreadable", detail: "written" },
      { name: "room", requestedValue: "Oak", afterSaveValue: "Oak", verified: "yes", detail: "ok" }
    ],
    evidence: [],
    warnings: [],
    executedAt: "2026-09-02T00:00:00.000Z"
  };

  it("decodes an execution result and records the route it came by", () => {
    const outcome = readToolResult({ content: [{ type: "text", text: JSON.stringify(executionResult) }] }, "webmcp");
    expect(outcome.route).toBe("webmcp");
    expect(outcome.execution?.status).toBe("partially_verified");
    expect(outcome.unparsed).toBeUndefined();
  });

  it("keeps a response it cannot decode rather than discarding it", () => {
    const outcome = readToolResult({ content: [{ type: "text", text: "not json at all" }] }, "webmcp");
    expect(outcome.execution).toBeUndefined();
    expect(outcome.unparsed).toMatch(/not JSON/i);
    expect(outcome.text).toBe("not json at all");
  });

  it("never renders an unverifiable value as verified", () => {
    // The date rule's guarantee, carried through to what a judge reads: an
    // ordering the org never established must not present as a tick.
    expect(verdictFor({ verified: "unreadable" })).toBe("unverifiable");
    expect(verdictFor({ verified: "no" })).toBe("mismatch");
    expect(verdictFor({ verified: "yes" })).toBe("verified");
  });
});

/* ------------------------------------------------------------------ *
 * The shape the browser actually returns.
 *
 * A live run found this: Chrome's WebMCP prototype hands `inputSchema`
 * back from `getTools()` as a JSON STRING, while `registerTool` takes an
 * object. Assuming the object form produced a form with NO fields, so the
 * judge invoked with no arguments — and the page blamed the tool's
 * response rather than the caller's request.
 * ------------------------------------------------------------------ */

describe("the schema is read in whatever shape the browser returns it", () => {
  const schema = {
    type: "object" as const,
    properties: {
      opportunity_id: { type: "string" as const, description: "Which Opportunity" },
      stage: { type: "string" as const, description: "The stage", enum: ["Engage", "Confirm"] }
    },
    required: ["opportunity_id"],
    additionalProperties: false as const
  };

  it("builds the same form from an object and from its JSON string", () => {
    const fromObject = harnessFieldsFor(schema);
    const fromString = harnessFieldsFor(JSON.stringify(schema));
    expect(fromString).toEqual(fromObject);
    expect(fromString.map((field) => [field.name, field.control, field.required])).toEqual([
      ["opportunity_id", "text", true],
      ["stage", "enum", false]
    ]);
  });

  it("returns nothing for a string that is not a schema, rather than throwing", () => {
    expect(harnessFieldsFor("not json at all")).toEqual([]);
    expect(harnessFieldsFor(JSON.stringify({ notASchema: true }))).toEqual([]);
    expect(normalizeInputSchema(undefined)).toBeUndefined();
  });

  it("normalizes a string schema back to the object it encodes", () => {
    expect(normalizeInputSchema(JSON.stringify(schema))).toEqual(schema);
    expect(normalizeInputSchema(schema)).toEqual(schema);
  });
});

describe("an unreadable tool response is reported as such", () => {
  it("distinguishes empty content from unparseable content", () => {
    // "returned nothing" and "returned something that is not a result" are
    // different failures and need different debugging.
    expect(readToolResult({ content: [] }, "webmcp").unparsed).toMatch(/no readable content/i);
    expect(readToolResult({ content: [{ type: "text", text: "nope" }] }, "webmcp").unparsed).toMatch(/not JSON/i);
  });

  it("reads text from a content entry that omits its type", () => {
    // The envelope is the browser's; discarding text that is plainly there
    // because a field is missing would report a caller error as a tool error.
    const payload = JSON.stringify({ status: "blocked", checks: [], evidence: [], warnings: [], executedAt: "t" });
    const outcome = readToolResult({ content: [{ text: payload } as never] }, "webmcp");
    expect(outcome.execution?.status).toBe("blocked");
  });
});

/* ------------------------------------------------------------------ *
 * The envelope a live invocation actually arrives in.
 *
 * Chrome's executeTool resolves with the WHOLE result envelope serialized
 * as a string. So the payload is a JSON string, containing an envelope,
 * whose content entry holds another JSON string, which is the execution
 * result. Unwrapping one layer finds valid JSON that is not a result — and
 * the panel blamed the tool for a shape it had failed to open.
 * ------------------------------------------------------------------ */

describe("a result is found through however many envelopes it arrives in", () => {
  const execution = {
    status: "partially_verified",
    checks: [{ name: "value_set", status: "pass", detail: "written" }],
    transactions: [{ name: "stage", requestedValue: "Confirm", verified: "yes", detail: "ok" }],
    evidence: [],
    warnings: [],
    executedAt: "2026-09-03T00:00:00.000Z"
  };

  it("reads the shape a live Chrome invocation returned", () => {
    // Exactly what came back from the org: the envelope, stringified.
    const live = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(execution) }] });
    const outcome = readToolResult(live, "webmcp");
    expect(outcome.execution?.status).toBe("partially_verified");
    expect(outcome.unparsed).toBeUndefined();
  });

  it("still reads the plain envelope, which is what the API's own type promises", () => {
    const outcome = readToolResult({ content: [{ type: "text", text: JSON.stringify(execution) }] }, "webmcp");
    expect(outcome.execution?.status).toBe("partially_verified");
  });

  it("does not mistake an arbitrary JSON object for a result", () => {
    // Unwrapping must not become "keep going until something parses".
    const outcome = readToolResult(JSON.stringify({ ok: true, note: "not a result" }), "webmcp");
    expect(outcome.execution).toBeUndefined();
    expect(outcome.unparsed).toMatch(/not an execution result/i);
  });

  it("gives up rather than looping on a payload that never resolves", () => {
    const outcome = readToolResult(JSON.stringify({ content: [{ type: "text", text: "still not json" }] }), "webmcp");
    expect(outcome.execution).toBeUndefined();
    expect(outcome.text).toContain("still not json");
  });

  it("requires both a status and checks before calling something a result", () => {
    expect(readToolResult(JSON.stringify({ checks: [] }), "webmcp").execution).toBeUndefined();
    expect(readToolResult(JSON.stringify({ status: "succeeded" }), "webmcp").execution).toBeUndefined();
  });
});
