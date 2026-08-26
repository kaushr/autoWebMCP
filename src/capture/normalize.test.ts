import { describe, expect, it } from "vitest";
import { normalizeInteractions } from "./normalize";

describe("normalizeInteractions", () => {
  it("keeps only meaningful action evidence and never includes typed values", () => {
    const observations = normalizeInteractions([
      { id: "one", kind: "focus", timestamp: 1 },
      { id: "two", kind: "field_change", timestamp: 2, element: { tag: "input", label: "Close Date" } },
      { id: "three", kind: "click", timestamp: 3, element: { tag: "button", label: "Save" } }
    ]);

    expect(observations).toEqual([
      {
        kind: "field_change",
        timestamp: 2,
        field: { label: "Close Date", context: undefined },
        provenance: "OBSERVED",
        sourceInteractionIds: ["two"]
      },
      {
        kind: "save",
        timestamp: 3,
        provenance: "OBSERVED",
        sourceInteractionIds: ["three"]
      }
    ]);
    expect(JSON.stringify(observations)).not.toContain("value");
  });
});
