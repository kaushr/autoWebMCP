import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import { parseObservationTrace, summarizeTrace } from "../src/training/traces";
import { parseSemanticizationResponse } from "../src/training/semanticizer";
import type { CaptureEvent } from "../src/capture/types";

function teachSession(): CaptureSession {
  const session = new CaptureSession("sess-demo", 0, {
    host: "127.0.0.1",
    platform: "prospect-intelligence",
    title: "Prospect Intelligence"
  });

  const events: CaptureEvent[] = [
    { id: "nav", kind: "navigate", t: 0, page: { host: "127.0.0.1", path: "/" } },
    {
      id: "search",
      kind: "field_change",
      t: 500,
      page: { host: "127.0.0.1", path: "/" },
      field: { label: "Search companies", section: "Search accounts", control: "text" },
      value: { masked: false, to: "Acme" }
    },
    {
      id: "filter",
      kind: "field_change",
      t: 1_500,
      page: { host: "127.0.0.1", path: "/" },
      field: { label: "Function", section: "Contacts", control: "select" },
      value: { masked: false, from: "All functions", to: "Procurement" }
    },
    {
      id: "password",
      kind: "field_change",
      t: 1_800,
      page: { host: "127.0.0.1", path: "/" },
      field: { label: "Password", control: "masked" },
      value: { masked: true }
    },
    { id: "apply", kind: "click", t: 2_000, page: { host: "127.0.0.1", path: "/" }, actionLabel: "Apply filters" },
    {
      id: "reaction",
      kind: "reaction",
      t: 2_400,
      page: { host: "127.0.0.1", path: "/" },
      correlatesWith: "apply",
      reaction: {
        domMutations: 18,
        urlChanged: false,
        validationShown: false,
        fieldsAppeared: false,
        dialogShown: false,
        toastShown: false,
        contentChanged: false
      }
    }
  ];

  session.addMany(events);
  session.noteRrwebEvents(120);
  session.stop(3_000);
  return session;
}

describe("extension → Training Studio handoff", () => {
  it("produces a trace the Studio accepts and can summarize", () => {
    const trace = teachSession().toTrace();
    const roundTripped = parseObservationTrace(JSON.parse(JSON.stringify(trace)));

    expect(roundTripped.sessionId).toBe("sess-demo");
    expect(roundTripped.labels).toContain("Function");
    expect(roundTripped.labels).toContain("Apply filters");
    expect(summarizeTrace(roundTripped, "2026-08-26T00:00:00.000Z")).toMatchObject({
      sessionId: "sess-demo",
      application: "127.0.0.1",
      platform: "prospect-intelligence",
      observations: roundTripped.observations.length
    });
  });

  it("carries semantic evidence, never credentials or raw recording", () => {
    const trace = teachSession().toTrace();
    const serialized = JSON.stringify(trace);

    // rrweb events are counted, never carried.
    expect(trace.stats.rrwebEvents).toBe(120);
    expect(serialized).not.toMatch(/cookie|authorization|bearer|selector|xpath|"type":\s*\d/i);

    const password = trace.observations.find((observation) => observation.field?.label === "Password");
    expect(password?.newValue).toBeUndefined();
    expect(password?.effects).toEqual(["value masked by capture policy"]);
  });

  it("rejects a malformed handoff", () => {
    expect(() => parseObservationTrace(null)).toThrow(/trace object/i);
    expect(() => parseObservationTrace({ version: 2 })).toThrow(/version/i);
    expect(() => parseObservationTrace({ version: 1, sessionId: "" })).toThrow(/sessionId/i);
    expect(() =>
      parseObservationTrace({ version: 1, sessionId: "a", application: { host: "x" }, observations: {} })
    ).toThrow(/observations/i);
  });

  it("stays compatible with the existing semanticizer contract when no binding is proven", () => {
    const { candidate } = parseSemanticizationResponse({
      candidate: {
        id: "find_relevant_contacts",
        name: "Find Relevant Contacts",
        description: "Find contacts at a company by business function.",
        inputs: [
          { name: "company", description: "Company name.", type: "string", required: true },
          { name: "function", description: "Business function.", type: "string", required: false }
        ],
        outputs: [{ name: "contacts", description: "Matching contacts.", type: "array" }],
        binding: null,
        provenance: { source: "inferred", observationIds: ["search", "filter"], confirmedByHuman: false },
        safety: { readOnly: true, requiresConfirmation: false }
      },
      ambiguities: ["Seniority was never varied, so it is not an input."]
    });

    expect(candidate.binding).toBeUndefined();
    expect("binding" in candidate).toBe(false);
    expect(candidate.id).toBe("find_relevant_contacts");
  });
});
