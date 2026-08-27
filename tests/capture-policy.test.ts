import { describe, expect, it } from "vitest";
import { controlKindFor, detectPlatform, isSensitiveField, safeValueChange } from "../src/capture/policy";

describe("capture privacy policy", () => {
  it("treats credential, contact, and payment controls as sensitive", () => {
    expect(isSensitiveField({ type: "password" })).toBe(true);
    expect(isSensitiveField({ type: "email" })).toBe(true);
    expect(isSensitiveField({ type: "text", autocomplete: "cc-number" })).toBe(true);
    expect(isSensitiveField({ type: "text", name: "api_key" })).toBe(true);
    expect(isSensitiveField({ type: "text", label: "Social Security Number" })).toBe(true);
    expect(isSensitiveField({ type: "text", id: "session-token" })).toBe(true);
  });

  it("treats ordinary business fields as capturable", () => {
    expect(isSensitiveField({ type: "date", label: "Close Date" })).toBe(false);
    expect(isSensitiveField({ type: "select", label: "Forecast Category" })).toBe(false);
  });

  it("never emits a sensitive value, not even a redacted one", () => {
    const change = safeValueChange({ type: "password", name: "password" }, "hunter2", "hunter3");
    expect(change).toEqual({ masked: true });
    expect(JSON.stringify(change)).not.toContain("hunter");
  });

  it("captures and truncates ordinary field transitions", () => {
    expect(safeValueChange({ type: "date", label: "Close Date" }, "2026-09-15", "2026-09-30")).toEqual({
      masked: false,
      from: "2026-09-15",
      to: "2026-09-30"
    });

    const long = safeValueChange({ type: "text", label: "Notes" }, undefined, "x".repeat(200));
    expect(long.to).toHaveLength(65);
    expect(long.to?.endsWith("…")).toBe(true);
  });

  it("maps controls to a small kind vocabulary and masks sensitive ones", () => {
    expect(controlKindFor({ type: "select-one" })).toBe("select");
    expect(controlKindFor({ type: "datetime-local" })).toBe("date");
    expect(controlKindFor({ type: "password" })).toBe("masked");
  });

  it("identifies platforms only to select an adapter", () => {
    expect(detectPlatform("acme.lightning.force.com", { lightning: false, prospect: false })).toBe(
      "salesforce-lightning"
    );
    expect(detectPlatform("localhost", { lightning: true, prospect: false })).toBe("salesforce-lightning");
    expect(detectPlatform("127.0.0.1", { lightning: false, prospect: true })).toBe("prospect-intelligence");
    expect(detectPlatform("example.com", { lightning: false, prospect: false })).toBe("generic");
  });
});
