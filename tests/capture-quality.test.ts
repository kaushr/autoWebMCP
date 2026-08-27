import { describe, expect, it } from "vitest";
import { CAUSAL_IMMEDIACY_MS, correlateExecutionEvidence } from "../src/capture/execution";
import { normalizeCapture } from "../src/capture/normalize";
import type { CaptureEvent, CaptureNetworkMetadata } from "../src/capture/types";

/**
 * Every case here comes from one real Salesforce Close Date recording. The
 * synthetic suites passed while this session produced widget text as a value,
 * one edit three times, phantom toasts, and thirty equally-weighted requests.
 */
const page = { host: "acme.lightning.force.com", path: "/lightning/r/Opportunity/006/view" };

function change(id: string, t: number, label: string, from: string | undefined, to: string | undefined): CaptureEvent {
  return {
    id,
    kind: "field_change",
    t,
    page,
    field: { label, section: "Opportunity Details", control: "other" },
    value: { masked: false, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }
  };
}

function request(
  id: string,
  startedAt: number,
  method: string,
  endpoint: string,
  overrides: Partial<CaptureNetworkMetadata> = {}
): CaptureEvent {
  const durationMs = overrides.durationMs ?? 200;
  const status = overrides.status ?? 200;
  return {
    id: `net-${id}`,
    kind: "network",
    t: startedAt + durationMs,
    page,
    network: {
      requestId: id,
      method,
      origin: "https://acme.lightning.force.com",
      endpoint,
      resourceType: "xmlhttprequest",
      // Aura tunnels reads and writes alike through POST /aura, so the HTTP
      // method carries no read/write information on this platform.
      category: "mutation",
      status,
      ok: status >= 200 && status < 400,
      failed: status === 0,
      startedAt,
      completedAt: startedAt + durationMs,
      durationMs,
      ...overrides
    }
  };
}

describe("Compound controls report a value, or none", () => {
  it("keeps a real date rather than the datepicker's own description", () => {
    const events = [change("edit", 1_000, "*Close Date", "2026-08-31", "2026-09-30")];
    const [observation] = normalizeCapture(events);

    expect(observation.newValue).toBe("2026-09-30");
    expect(observation.newValue).not.toMatch(/Select a date|Previous Month/);
  });

  it("records the interaction with no value when the control exposes none", () => {
    // The sensor now declines to invent a value; the edit is still observed.
    const events = [change("edit", 1_000, "*Close Date", undefined, undefined)];
    const [observation] = normalizeCapture(events);

    expect(observation.action).toBe("field_change");
    expect(observation.field?.label).toBe("*Close Date");
    expect(observation.newValue).toBeUndefined();
  });
});

describe("One edit inside nested components is one observation", () => {
  it("collapses the repeats each shadow host produced", () => {
    const events = [
      change("host-datepicker", 40_559, "*Close Date", "2026-08-31", "2026-09-30"),
      change("host-input", 40_560, "*Close Date", "2026-08-31", "2026-09-30")
    ];
    const observations = normalizeCapture(events);

    expect(observations).toHaveLength(1);
    // Both raw events remain reachable from the surviving observation.
    expect(observations[0].sourceEventIds).toEqual(["host-datepicker", "host-input"]);
  });

  it("does not collapse two genuinely different edits to the same field", () => {
    const events = [
      change("first", 1_000, "*Close Date", "2026-08-31", "2026-09-30"),
      change("second", 1_100, "*Close Date", "2026-09-30", "2026-10-31")
    ];
    expect(normalizeCapture(events)).toHaveLength(2);
  });

  it("does not collapse edits far enough apart to be separate intents", () => {
    const events = [
      change("first", 1_000, "*Close Date", "2026-08-31", "2026-09-30"),
      change("second", 9_000, "*Close Date", "2026-08-31", "2026-09-30")
    ];
    expect(normalizeCapture(events)).toHaveLength(2);
  });
});

describe("Causal candidates versus nearby activity", () => {
  /** The real Save: the mutation, then eight consequences of it. */
  const saveWorkflow: CaptureEvent[] = [
    { id: "click-save", kind: "click", t: 42_600, page, actionLabel: "Save" },
    request("update", 42_612, "POST", "/aura?aura.RecordUi.updateRecord,r", { durationMs: 466 }),
    request("refetch", 43_083, "POST", "/aura?aura.RecordUi.getRecordWithFields,r"),
    request("actions", 43_873, "POST", "/aura?aura.Actions.getRecordActions,r"),
    request("related", 43_874, "POST", "/aura?aura.RelatedListUi.postRelatedListRecords,r"),
    request("chart", 44_468, "POST", "/aura?r,ui-analytics-platform-embeddedChart.EmbeddedReportChart.loadChart")
  ];

  const evidence = () => correlateExecutionEvidence(saveWorkflow, normalizeCapture(saveWorkflow));

  it("shortlists only the request that started with the action", () => {
    const [save] = evidence();
    expect(save.causalCandidates).toEqual(["update"]);
  });

  it("still retains every nearby request in full", () => {
    const [save] = evidence();
    expect(save.networkEffects).toHaveLength(5);
    expect(save.networkEffects.map((effect) => effect.requestId)).toEqual([
      "update",
      "refetch",
      "actions",
      "related",
      "chart"
    ]);
    expect(save.networkEffects.filter((effect) => effect.role === "nearby")).toHaveLength(4);
  });

  it("demotes a successful mutation that merely followed a few hundred ms later", () => {
    const [save] = evidence();
    const refetch = save.networkEffects.find((effect) => effect.requestId === "refetch")!;

    expect(refetch.ok).toBe(true);
    expect(refetch.category).toBe("mutation");
    expect(refetch.startedAfterMs).toBeGreaterThan(CAUSAL_IMMEDIACY_MS);
    expect(refetch.role).toBe("nearby");
  });

  it("does not shortlist activity seconds after the action", () => {
    const [save] = evidence();
    const late = save.networkEffects.find((effect) => effect.requestId === "chart")!;
    expect(late.startedAfterMs).toBeGreaterThan(1_500);
    expect(late.role).toBe("nearby");
  });

  it("never shortlists background traffic, however immediate", () => {
    const events: CaptureEvent[] = [
      { id: "a", kind: "click", t: 1_000, page, actionLabel: "One" },
      request("b1", 1_010, "POST", "/aura?beacon"),
      { id: "c", kind: "click", t: 3_000, page, actionLabel: "Two" },
      request("b2", 3_010, "POST", "/aura?beacon"),
      { id: "d", kind: "click", t: 5_000, page, actionLabel: "Three" },
      request("b3", 5_010, "POST", "/aura?beacon")
    ];
    const groups = correlateExecutionEvidence(events, normalizeCapture(events));

    for (const group of groups) {
      expect(group.causalCandidates).toEqual([]);
      expect(group.networkEffects[0].backgroundLikely).toBe(true);
    }
  });

  it("keeps a failed mutation as evidence but off the shortlist", () => {
    const events: CaptureEvent[] = [
      { id: "click-save", kind: "click", t: 1_000, page, actionLabel: "Save" },
      request("failed", 1_010, "POST", "/aura?aura.RecordUi.updateRecord,r", { status: 0, failed: true })
    ];
    const [save] = correlateExecutionEvidence(events, normalizeCapture(events));

    expect(save.networkEffects).toHaveLength(1);
    expect(save.causalCandidates).toEqual([]);
  });
});

describe("Nothing is destroyed to reduce noise", () => {
  it("keeps every correlated request even when only one is shortlisted", () => {
    const events: CaptureEvent[] = [
      { id: "click-save", kind: "click", t: 1_000, page, actionLabel: "Save" },
      ...Array.from({ length: 12 }, (_, index) =>
        request(`r${index}`, 1_010 + index * 300, "POST", `/aura?call${index}`)
      )
    ];
    const [save] = correlateExecutionEvidence(events, normalizeCapture(events));

    expect(save.networkEffects).toHaveLength(12);
    expect(save.causalCandidates).toEqual(["r0"]);
  });
});
