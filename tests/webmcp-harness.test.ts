import { describe, expect, it } from "vitest";
import {
  collectInvocationArguments,
  describeWebMcpSurface,
  harnessFieldsFor,
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
