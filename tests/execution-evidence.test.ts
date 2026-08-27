import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_WINDOW_MS,
  CAUSAL_WINDOW_MS,
  correlateExecutionEvidence
} from "../src/capture/execution";
import { normalizeCapture, normalizeEndpoint } from "../src/capture/normalize";
import { CaptureSession } from "../src/capture/session";
import type { CaptureEvent, CaptureNetworkMetadata } from "../src/capture/types";

const page = { host: "app.example.com", path: "/opportunity/edit" };

function network(
  id: string,
  startedAt: number,
  overrides: Partial<CaptureNetworkMetadata> & Pick<CaptureNetworkMetadata, "method" | "endpoint">
): CaptureEvent {
  const status = overrides.status ?? 200;
  const durationMs = overrides.durationMs ?? 120;
  return {
    id: `net-${id}`,
    kind: "network",
    t: startedAt + durationMs,
    page,
    network: {
      requestId: id,
      origin: "https://app.example.com",
      resourceType: "xmlhttprequest",
      category: "mutation",
      status,
      ok: status >= 200 && status < 400,
      failed: overrides.failed ?? status === 0,
      startedAt,
      completedAt: startedAt + durationMs,
      durationMs,
      ...overrides
    }
  };
}

function click(id: string, t: number, label: string, overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return { id, kind: "click", t, page, actionLabel: label, ...overrides };
}

function toast(id: string, t: number, correlatesWith: string): CaptureEvent {
  return {
    id,
    kind: "reaction",
    t,
    page,
    correlatesWith,
    reaction: {
      domMutations: 6,
      urlChanged: false,
      validationShown: false,
      fieldsAppeared: false,
      dialogShown: false,
      toastShown: true,
      contentChanged: true
    }
  };
}

/** The Salesforce-shaped case: edit two fields, Save, one mutation, a toast. */
function saveWorkflow(): CaptureEvent[] {
  return [
    {
      id: "field-close",
      kind: "field_change",
      t: 1_000,
      page,
      field: { label: "Close Date", section: "Opportunity Details", control: "date" },
      value: { masked: false, from: "2026-08-31", to: "2026-09-30" }
    },
    {
      id: "field-desc",
      kind: "field_change",
      t: 1_800,
      page,
      field: { label: "Description", section: "Opportunity Details", control: "text" },
      value: { masked: false, from: "old", to: "new" }
    },
    click("click-save", 2_600, "Save"),
    toast("reaction-save", 2_910, "click-save"),
    network("save-1", 2_637, { method: "POST", endpoint: "/aura", status: 200, durationMs: 204 })
  ];
}

function evidenceFor(events: CaptureEvent[]) {
  return correlateExecutionEvidence(events, normalizeCapture(events));
}

describe("Correlating execution evidence", () => {
  it("attributes the Save request to the Save click, with the delay it observed", () => {
    const evidence = evidenceFor(saveWorkflow());
    expect(evidence).toHaveLength(1);

    const entry = evidence[0];
    expect(entry.actionLabel).toBe("Save");
    expect(entry.networkEffects).toHaveLength(1);
    expect(entry.networkEffects[0]).toMatchObject({
      method: "POST",
      pathPattern: "/aura",
      status: 200,
      ok: true,
      startedAfterMs: 37,
      durationMs: 204,
      confidence: "high"
    });
  });

  it("carries the application's own reaction alongside the request", () => {
    expect(evidenceFor(saveWorkflow())[0].applicationEffects).toContain("confirmation toast shown");
  });

  it("attributes a request to the most recent action, not the first", () => {
    const events = [
      click("click-edit", 0, "Edit"),
      click("click-save", 2_600, "Save"),
      network("save-1", 2_650, { method: "POST", endpoint: "/aura" })
    ];
    expect(evidenceFor(events)[0].actionLabel).toBe("Save");
  });

  it("keeps every nearby request rather than only the first", () => {
    const events = [
      click("click-save", 1_000, "Save"),
      network("a", 1_040, { method: "POST", endpoint: "/aura" }),
      network("b", 1_120, { method: "POST", endpoint: "/api/audit" }),
      network("c", 1_300, { method: "GET", endpoint: "/api/record", category: "read" })
    ];
    const effects = evidenceFor(events)[0].networkEffects;
    expect(effects.map((effect) => effect.pathPattern)).toEqual(["/aura", "/api/audit", "/api/record"]);
    expect(effects.find((effect) => effect.category === "read")?.confidence).toBe("low");
  });

  it("drops a request that began before any human action", () => {
    const events = [network("early", 100, { method: "POST", endpoint: "/aura" }), click("click-save", 1_000, "Save")];
    expect(evidenceFor(events)).toEqual([]);
  });

  it("drops a request too far after the action to attribute", () => {
    const events = [
      click("click-save", 1_000, "Save"),
      network("late", 1_000 + ATTRIBUTION_WINDOW_MS + 1, { method: "POST", endpoint: "/aura" })
    ];
    expect(evidenceFor(events)).toEqual([]);
  });

  it("downgrades a request that starts late but still inside the attribution window", () => {
    const events = [
      click("click-save", 1_000, "Save"),
      toast("reaction-save", 1_100, "click-save"),
      network("slow", 1_000 + CAUSAL_WINDOW_MS + 200, { method: "POST", endpoint: "/aura" })
    ];
    expect(evidenceFor(events)[0].networkEffects[0].confidence).toBe("medium");
  });

  it("records a failed request as evidence rather than discarding it", () => {
    const events = [
      click("click-save", 1_000, "Save"),
      network("fail", 1_050, { method: "POST", endpoint: "/aura", status: 0, failed: true })
    ];
    const effect = evidenceFor(events)[0].networkEffects[0];
    expect(effect.failed).toBe(true);
    expect(effect.ok).toBe(false);
    expect(effect.status).toBe(0);
  });

  it("reports no evidence for an application that does its work in-process", () => {
    const events = [click("click-filter", 1_000, "Apply filters"), toast("reaction", 1_100, "click-filter")];
    expect(evidenceFor(events)).toEqual([]);
  });
});

describe("Separating background noise from execution evidence", () => {
  const polling = (id: string, at: number) => network(id, at, { method: "POST", endpoint: "/telemetry" });

  it("marks repeating traffic that fires without any action as background", () => {
    const events = [
      polling("p1", 200),
      polling("p2", 5_200),
      click("click-save", 10_000, "Save"),
      polling("p3", 10_100),
      network("save", 10_040, { method: "POST", endpoint: "/aura" })
    ];

    const effects = evidenceFor(events)[0].networkEffects;
    const save = effects.find((effect) => effect.pathPattern === "/aura");
    const noise = effects.find((effect) => effect.pathPattern === "/telemetry");

    expect(save).toMatchObject({ backgroundLikely: false, confidence: "high" });
    expect(noise).toMatchObject({ backgroundLikely: true, confidence: "low" });
  });

  it("does not call a one-off mutation background traffic just because it repeats once", () => {
    const events = [
      click("click-save", 1_000, "Save"),
      network("a", 1_040, { method: "POST", endpoint: "/aura" }),
      click("click-save-2", 5_000, "Save"),
      network("b", 5_040, { method: "POST", endpoint: "/aura" })
    ];
    for (const entry of evidenceFor(events)) {
      expect(entry.networkEffects[0].backgroundLikely).toBe(false);
    }
  });

  it("treats a document load as weak evidence, never as the executing call", () => {
    const events = [
      click("click-save", 1_000, "Save"),
      network("doc", 1_050, { method: "GET", endpoint: "/page", resourceType: "main_frame", category: "document" })
    ];
    expect(evidenceFor(events)[0].networkEffects[0].confidence).toBe("low");
  });
});

describe("What execution evidence refuses to carry", () => {
  it("keeps no credential, header, body, or query value anywhere in the trace", () => {
    const session = new CaptureSession("sess-1", 0, { host: "app.example.com", platform: "generic" });
    session.addMany([
      click("click-save", 1_000, "Save"),
      network("save", 1_040, {
        method: "POST",
        endpoint: normalizeEndpoint(
          "https://app.example.com/services/data/v62.0/sobjects/Opportunity/0065g00000ABCDEAA1?sid=SECRET&token=abc"
        )
      })
    ]);
    session.stop(2_000);

    const serialized = JSON.stringify(session.toTrace());
    for (const secret of ["SECRET", "token=abc", "sid=", "0065g00000ABCDEAA1", "Authorization", "Cookie"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("/services/data/:v/sobjects/Opportunity/:id");
  });

  it("carries evidence on the trace as a sibling of the observations, not inside them", () => {
    const session = new CaptureSession("sess-2", 0, { host: "app.example.com", platform: "generic" });
    session.addMany(saveWorkflow());
    session.stop(4_000);

    const trace = session.toTrace();
    expect(Array.isArray(trace.executionEvidence)).toBe(true);
    expect(trace.executionEvidence[0].networkEffects[0].pathPattern).toBe("/aura");
    expect(trace.observations.every((observation) => !("networkEffects" in observation))).toBe(true);
  });

  it("produces nothing executable: no URL, selector, header, or body to replay", () => {
    const [entry] = evidenceFor(saveWorkflow());
    const keys = Object.keys(entry.networkEffects[0]);
    for (const forbidden of ["url", "headers", "body", "requestBody", "responseBody", "cookies", "selector"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
