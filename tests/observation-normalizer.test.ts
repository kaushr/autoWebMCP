import { describe, expect, it } from "vitest";
import { categorizeRequest, collectLabels, normalizeCapture, normalizeEndpoint } from "../src/capture/normalize";
import type { CaptureEvent } from "../src/capture/types";

const page = { host: "app.example.com", path: "/opportunity" };

function base(id: string, t: number, overrides: Partial<CaptureEvent>): CaptureEvent {
  return { id, kind: "click", t, page, ...overrides };
}

describe("normalizeEndpoint", () => {
  it("keeps the shape of an endpoint without identifiers or query values", () => {
    expect(
      normalizeEndpoint("https://acme.my.salesforce.com/services/data/v62.0/sobjects/Opportunity/0065g00000ABCDEAA1")
    ).toBe("/services/data/:v/sobjects/Opportunity/:id");
    expect(normalizeEndpoint("https://api.example.com/orders/48213?token=abc&status=open")).toBe(
      "/orders/:n?status,token"
    );
    expect(normalizeEndpoint("not a url")).toBe("/");
  });

  it("categorizes requests by intent", () => {
    expect(categorizeRequest("POST", "xmlhttprequest")).toBe("mutation");
    expect(categorizeRequest("GET", "xmlhttprequest")).toBe("read");
    expect(categorizeRequest("GET", "main_frame")).toBe("document");
  });
});

describe("normalizeCapture", () => {
  it("produces field transitions with label and section context", () => {
    const observations = normalizeCapture([
      base("nav", 0, { kind: "navigate" }),
      base("field", 100, {
        kind: "field_change",
        field: { label: "Close Date", section: "Opportunity Details", control: "date" },
        value: { masked: false, from: "2026-09-15", to: "2026-09-30" }
      })
    ]);

    expect(observations[1]).toMatchObject({
      action: "field_change",
      field: { label: "Close Date", context: "Opportunity Details", control: "date" },
      oldValue: "2026-09-15",
      newValue: "2026-09-30",
      provenance: "OBSERVED"
    });
  });

  it("classifies a save action and folds its application reaction into effects", () => {
    const observations = normalizeCapture([
      base("save", 1_000, { actionLabel: "Save" }),
      base("reaction", 1_200, {
        kind: "reaction",
        correlatesWith: "save",
        reaction: {
          domMutations: 12,
          urlChanged: false,
          validationShown: false,
          fieldsAppeared: false,
          dialogShown: false,
          toastShown: true,
          contentChanged: true
        }
      }),
      base("net", 1_300, {
        kind: "network",
        network: {
          method: "PATCH",
          endpoint: "/services/data/:v/sobjects/Opportunity/:id",
          status: 204,
          durationMs: 180,
          category: "mutation"
        }
      })
    ]);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      action: "save",
      target: "Save",
      provenance: "INFERRED",
      network: { method: "PATCH", status: 204 }
    });
    expect(observations[0].effects).toEqual([
      "confirmation toast shown",
      "network mutation observed",
      "record became persisted"
    ]);
    expect(observations[0].sourceEventIds).toEqual(["save", "reaction", "net"]);
  });

  it("is evidence, not a replay script", () => {
    const observations = normalizeCapture([
      base("field", 10, {
        kind: "field_change",
        field: { label: "Password", control: "masked" },
        value: { masked: true }
      })
    ]);

    const serialized = JSON.stringify(observations);
    expect(serialized).not.toMatch(/selector|xpath|coordinate|clientX/i);
    expect(observations[0].oldValue).toBeUndefined();
    expect(observations[0].newValue).toBeUndefined();
    expect(observations[0].effects).toEqual(["value masked by capture policy"]);
  });

  it("drops browser noise: unlabelled inert clicks, repeat navigation, and no-op edits", () => {
    const observations = normalizeCapture([
      base("nav-1", 0, { kind: "navigate" }),
      base("nav-2", 10, { kind: "navigate" }),
      base("noise", 20, {}),
      base("noop", 30, {
        kind: "field_change",
        field: { label: "Stage", control: "select" },
        value: { masked: false, from: "Proposal", to: "Proposal" }
      }),
      base("real", 40, { actionLabel: "Apply filters" })
    ]);

    expect(observations.map((observation) => observation.id)).toEqual(["nav-1", "real"]);
  });

  it("keeps an unlabelled click when the application visibly reacted", () => {
    const observations = normalizeCapture([
      base("card", 0, {}),
      base("reaction", 200, {
        kind: "reaction",
        correlatesWith: "card",
        reaction: {
          domMutations: 20,
          urlChanged: true,
          validationShown: false,
          fieldsAppeared: false,
          dialogShown: false,
          toastShown: false,
          contentChanged: false
        }
      })
    ]);

    expect(observations).toHaveLength(1);
    expect(observations[0].effects).toEqual(["navigation occurred"]);
  });

  it("ignores read traffic and mutations that no action can explain", () => {
    const observations = normalizeCapture([
      base("click", 0, { actionLabel: "Search" }),
      base("read", 100, {
        kind: "network",
        network: { method: "GET", endpoint: "/api/companies", status: 200, durationMs: 20, category: "read" }
      }),
      base("orphan", 60_000, {
        kind: "network",
        network: { method: "POST", endpoint: "/api/telemetry", status: 200, durationMs: 20, category: "mutation" }
      })
    ]);

    expect(observations[0].effects).toBeUndefined();
    expect(observations[0].network).toBeUndefined();
  });

  it("folds a submit into the click that caused it", () => {
    const observations = normalizeCapture([
      base("click", 1_000, { actionLabel: "Apply filters" }),
      base("submit", 1_001, { kind: "submit" }),
      base("reaction", 1_400, {
        kind: "reaction",
        correlatesWith: "submit",
        reaction: {
          domMutations: 1,
          urlChanged: false,
          validationShown: false,
          fieldsAppeared: false,
          dialogShown: false,
          toastShown: false,
          contentChanged: true
        }
      })
    ]);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ action: "click", target: "Apply filters" });
    expect(observations[0].effects).toEqual(["page content updated"]);
    expect(observations[0].sourceEventIds).toEqual(["click", "submit", "reaction"]);
  });

  it("keeps a submit that stands on its own", () => {
    const observations = normalizeCapture([
      base("click", 0, { actionLabel: "Close Date" }),
      base("submit", 9_000, { kind: "submit", actionLabel: "Update opportunity" })
    ]);

    expect(observations.map((observation) => observation.action)).toEqual(["click", "submit"]);
  });

  it("collects the distinct labels the semanticizer should be grounded in", () => {
    const labels = collectLabels([
      {
        id: "one",
        action: "field_change",
        t: 0,
        field: { label: "Function", context: "Contact Filters", control: "select" },
        provenance: "OBSERVED",
        sourceEventIds: ["one"]
      },
      {
        id: "two",
        action: "click",
        t: 1,
        target: "Apply filters",
        provenance: "OBSERVED",
        sourceEventIds: ["two"]
      }
    ]);

    expect(labels).toEqual(["Function", "Contact Filters", "Apply filters"]);
  });
});
