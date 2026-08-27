import { describe, expect, it } from "vitest";
import { AMBIGUITY_WINDOW_MS, correlateExecutionEvidence } from "../src/capture/execution";
import { normalizeCapture } from "../src/capture/normalize";
import type { CaptureEvent, CaptureNetworkMetadata } from "../src/capture/types";

const page = { host: "app.example.com", path: "/record/edit" };

function req(
  id: string,
  startedAt: number,
  method: string,
  endpoint: string,
  overrides: Partial<CaptureNetworkMetadata> = {}
): CaptureEvent {
  const durationMs = overrides.durationMs ?? 120;
  const status = overrides.status ?? 200;
  return {
    id: `net-${id}`,
    kind: "network",
    t: startedAt + durationMs,
    page,
    network: {
      requestId: id,
      method,
      origin: "https://app.example.com",
      endpoint,
      resourceType: "xmlhttprequest",
      category: /^(POST|PUT|PATCH|DELETE)$/.test(method) ? "mutation" : "read",
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

const click = (id: string, t: number, label: string): CaptureEvent => ({
  id,
  kind: "click",
  t,
  page,
  actionLabel: label
});

const change = (id: string, t: number, label: string, from: string, to: string): CaptureEvent => ({
  id,
  kind: "field_change",
  t,
  page,
  field: { label, section: "Record Details", control: "text" },
  value: { masked: false, from, to }
});

const reaction = (id: string, t: number, correlatesWith: string, toastShown = true): CaptureEvent => ({
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
    toastShown,
    contentChanged: true
  }
});

function evidence(events: CaptureEvent[]) {
  return correlateExecutionEvidence(events, normalizeCapture(events));
}

/** Which requests landed on which action, as a readable shape. */
function shape(events: CaptureEvent[]): Record<string, string[]> {
  return Object.fromEntries(
    evidence(events).map((entry) => [
      entry.actionLabel ?? entry.action,
      entry.networkEffects.map((effect) => `${effect.method} ${effect.pathPattern} ${effect.confidence}`)
    ])
  );
}

describe("CASE 1 — dropdown selection, async refresh, then Save", () => {
  const events = [
    change("pick-stage", 1_000, "Stage", "Prospecting", "Negotiation"),
    req("stage-load", 1_060, "GET", "/ui/picklist"),
    reaction("stage-reaction", 1_500, "pick-stage", false),
    click("save", 3_000, "Save"),
    req("save-1", 3_241, "POST", "/aura"),
    reaction("save-reaction", 3_410, "save")
  ];

  it("keeps the dropdown's own request on the dropdown, not on Save", () => {
    expect(shape(events)).toEqual({
      Stage: ["GET /ui/picklist low"],
      Save: ["POST /aura high"]
    });
  });

  it("produces action-scoped groups rather than one flat list", () => {
    expect(evidence(events).map((entry) => entry.action)).toEqual(["field_change", "save"]);
  });
});

describe("CASE 2 — field change, validation, Save, post-save refresh", () => {
  const events = [
    change("edit-desc", 1_000, "Description", "old", "new"),
    req("validate", 1_120, "POST", "/validate"),
    reaction("validate-reaction", 1_400, "edit-desc", false),
    click("save", 4_000, "Save"),
    req("save-1", 4_241, "POST", "/aura"),
    req("refresh", 4_600, "GET", "/aura/refresh"),
    reaction("save-reaction", 4_800, "save")
  ];

  it("attributes validation to the field and both save-time requests to Save", () => {
    expect(shape(events)).toEqual({
      // Strong evidence, and attributed to the field rather than to Save.
      Description: ["POST /validate high"],
      Save: ["POST /aura high", "GET /aura/refresh low"]
    });
  });

  it("ranks the mutation above the refresh that followed it", () => {
    const save = evidence(events).find((entry) => entry.actionLabel === "Save")!;
    expect(save.networkEffects[0].confidence).toBe("high");
    expect(save.networkEffects[1].category).toBe("read");
    expect(save.confidence).toBe("high");
  });
});

describe("CASE 3 — background polling before, during, and after Save", () => {
  const events = [
    click("open", 500, "Edit"),
    req("poll-1", 600, "POST", "/telemetry"),
    click("focus", 3_000, "Description"),
    req("poll-2", 3_100, "POST", "/telemetry"),
    click("save", 6_000, "Save"),
    req("save-1", 6_241, "POST", "/aura"),
    req("poll-3", 6_400, "POST", "/telemetry"),
    reaction("save-reaction", 6_600, "save")
  ];

  it("marks the polling background and leaves the save mutation alone", () => {
    const save = evidence(events).find((entry) => entry.actionLabel === "Save")!;
    const aura = save.networkEffects.find((effect) => effect.pathPattern === "/aura")!;
    const poll = save.networkEffects.find((effect) => effect.pathPattern === "/telemetry")!;

    expect(aura).toMatchObject({ backgroundLikely: false, confidence: "high" });
    expect(poll).toMatchObject({ backgroundLikely: true, confidence: "low" });
    expect(poll.reasons).toContain("− repeats independently of user actions");
  });
});

describe("CASE 4 — competing actions inside the attribution window", () => {
  const events = [
    click("first", 1_000, "Apply"),
    req("from-first", 1_100, "POST", "/apply"),
    click("second", 1_200, "Save"),
    req("from-second", 1_300, "POST", "/aura"),
    reaction("save-reaction", 1_600, "second")
  ];

  it("does not attach the earlier action's request to the later action", () => {
    expect(shape(events)).toEqual({
      Apply: ["POST /apply medium"],
      Save: ["POST /aura medium"]
    });
  });

  it("flags the attribution as ambiguous and says so in the reasons", () => {
    const save = evidence(events).find((entry) => entry.actionLabel === "Save")!;
    const effect = save.networkEffects[0];
    expect(events[2].t - events[0].t).toBeLessThanOrEqual(AMBIGUITY_WINDOW_MS);
    expect(effect.ambiguousAttribution).toBe(true);
    expect(effect.reasons).toContain("− another action occurred just before this one");
    // Ambiguity is what stops this from scoring high despite otherwise ideal signals.
    expect(effect.confidence).toBe("medium");
  });
});

describe("CASE 5 — application reaction arrives after the request completes", () => {
  it("counts a reaction that lands after completion as supporting evidence", () => {
    const events = [
      click("save", 1_000, "Save"),
      req("save-1", 1_241, "POST", "/aura", { durationMs: 204 }),
      reaction("save-reaction", 1_514, "save")
    ];
    const effect = evidence(events)[0].networkEffects[0];
    expect(effect.reasons).toContain("+ application reacted after it completed");
    expect(effect.confidence).toBe("high");
  });

  it("does not count a reaction that already happened before the request started", () => {
    const events = [
      click("save", 1_000, "Save"),
      reaction("early", 1_050, "save"),
      req("save-1", 1_400, "POST", "/aura")
    ];
    const effect = evidence(events)[0].networkEffects[0];
    expect(effect.reasons).toContain("− no application reaction followed it");
    expect(effect.confidence).toBe("medium");
  });
});

describe("Explaining a score", () => {
  it("reads like the real Salesforce Save it was modelled on", () => {
    const events = [
      change("close-date", 1_000, "Close Date", "2026-08-31", "2026-09-30"),
      click("save", 3_000, "Save"),
      req("save-1", 3_241, "POST", "/aura?other.RecordUi.saveRecord,r", { durationMs: 204 }),
      reaction("save-reaction", 3_510, "save")
    ];
    const effect = evidence(events).find((entry) => entry.actionLabel === "Save")!.networkEffects[0];

    expect(effect.confidence).toBe("high");
    expect(effect.reasons).toEqual([
      "+ mutation request (POST)",
      "+ started 241ms after the action",
      "+ HTTP 200",
      "+ application reacted after it completed"
    ]);
    // Strong correlation says nothing about whether the transport may be called.
    expect(effect.bindingEligibility).toBe("unresolved");
  });

  it("explains a failure rather than discarding it", () => {
    const events = [
      click("save", 1_000, "Save"),
      req("save-1", 1_100, "POST", "/aura", { status: 0, failed: true }),
      reaction("save-reaction", 1_400, "save")
    ];
    const effect = evidence(events)[0].networkEffects[0];
    expect(effect.reasons).toContain("− request failed");
    expect(effect.confidence).toBe("medium");
  });
});
