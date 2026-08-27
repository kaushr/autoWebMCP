// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  invokeSemanticAction,
  resolveSemanticTarget,
  setFieldValue,
  verifyOutcome,
  waitForApplicationReaction,
  type PlatformResolverAdapter
} from "../src/binding/browserExecution/engine";
import type { SemanticTarget } from "../src/binding/browserExecution/model";

function mount(html: string): HTMLElement {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

const CLOSE_DATE: SemanticTarget = { role: "field", label: "Close Date", applicationIdentifier: "CloseDate" };
const SAVE: SemanticTarget = { role: "button", label: "Save" };

describe("resolveSemanticTarget — generic resolution", () => {
  it("resolves a field by its associated <label for>", () => {
    const root = mount(`<label for="cd">Close Date</label><input id="cd" name="CloseDate" />`);
    const outcome = resolveSemanticTarget(root, CLOSE_DATE);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.target.element.getAttribute("name")).toBe("CloseDate");
  });

  it("resolves a button by its own accessible text", () => {
    const root = mount(`<button>Save</button>`);
    const outcome = resolveSemanticTarget(root, SAVE);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.target.element.tagName).toBe("BUTTON");
  });

  it("matches a label that carries a leading required-field marker", () => {
    const root = mount(`<label for="cd">*Close Date</label><input id="cd" />`);
    const outcome = resolveSemanticTarget(root, CLOSE_DATE);
    expect(outcome.ok).toBe(true);
  });

  it("fails honestly when no element matches", () => {
    const root = mount(`<label for="x">Something Else</label><input id="x" />`);
    const outcome = resolveSemanticTarget(root, CLOSE_DATE);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/no element/i);
  });

  it("refuses to guess when a label matches more than one element", () => {
    const root = mount(`
      <label for="a">Close Date</label><input id="a" />
      <label for="b">Close Date</label><input id="b" />
    `);
    const outcome = resolveSemanticTarget(root, CLOSE_DATE);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/matched 2 elements/i);
  });

  it("disambiguates an ambiguous label match using the application identifier", () => {
    const root = mount(`
      <label for="a">Close Date</label><input id="a" name="OtherField" />
      <label for="b">Close Date</label><input id="b" name="CloseDate" />
    `);
    const outcome = resolveSemanticTarget(root, CLOSE_DATE);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.target.element.getAttribute("id")).toBe("b");
  });

  it("falls back to the application identifier when no label matches", () => {
    const root = mount(`<input name="CloseDate" />`);
    const outcome = resolveSemanticTarget(root, CLOSE_DATE);
    expect(outcome.ok).toBe(true);
  });

  it("pierces an open shadow root when the platform's policy calls for composed traversal", () => {
    const container = mount(`<div id="host"></div>`);
    const host = container.querySelector("#host") as HTMLElement;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<label for="cd">Close Date</label><input id="cd" name="CloseDate" />`;

    const composed: PlatformResolverAdapter = {
      id: "composed-platform",
      resolutionPolicy: {
        traversal: "composed-tree",
        shadowRoots: "recursive",
        eventRetargeting: true,
        identityPriority: ["applicationIdentifier", "accessibleName", "section"]
      }
    };
    const outcome = resolveSemanticTarget(container, CLOSE_DATE, composed);
    expect(outcome.ok).toBe(true);
  });

  it("does not pierce shadow roots for an ordinary page, which declares no such policy", () => {
    // Traversal depth is a platform decision, not a universal default: an
    // ordinary web page keeps flat-DOM resolution, and a component's
    // internals stay its own business.
    const container = mount(`<div id="host"></div>`);
    const host = container.querySelector("#host") as HTMLElement;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<label for="cd">Close Date</label><input id="cd" name="CloseDate" />`;
    const outcome = resolveSemanticTarget(container, CLOSE_DATE);
    expect(outcome.ok).toBe(false);
  });

  it("lets a platform adapter resolve a target before falling back to generic search", () => {
    const root = mount(`<div></div>`);
    const marker = document.createElement("input");
    const adapter: PlatformResolverAdapter = { id: "test", resolveTarget: () => ({ element: marker, strategy: "adapter" }) };
    const outcome = resolveSemanticTarget(root, CLOSE_DATE, adapter);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.target.element).toBe(marker);
  });
});

describe("setFieldValue", () => {
  it("writes a text input via the native property setter and dispatches events", async () => {
    const root = mount(`<input id="cd" />`);
    const input = root.querySelector("input") as HTMLInputElement;
    const changed = vi.fn();
    input.addEventListener("change", changed);
    const outcome = resolveSemanticTarget(root, { role: "field", label: "Close Date" });
    // No label present; resolve via identifier fallback for this test instead.
    const direct = { element: input, strategy: "test" };
    const result = await setFieldValue(direct, "2026-12-15", "text");
    expect(result.ok).toBe(true);
    expect(input.value).toBe("2026-12-15");
    expect(changed).toHaveBeenCalledOnce();
    expect(outcome.ok).toBe(false); // sanity: no label means generic resolve legitimately fails here
  });

  it("writes a select by matching option text", async () => {
    const root = mount(`<select><option value="us">United States</option><option value="ca">Canada</option></select>`);
    const select = root.querySelector("select") as HTMLSelectElement;
    const result = await setFieldValue({ element: select, strategy: "test" }, "Canada", "select");
    expect(result.ok).toBe(true);
    expect(select.value).toBe("ca");
  });

  it("reports failure rather than guessing when the select has no matching option", async () => {
    const root = mount(`<select><option value="us">United States</option></select>`);
    const select = root.querySelector("select") as HTMLSelectElement;
    const result = await setFieldValue({ element: select, strategy: "test" }, "Nowhere", "select");
    expect(result.ok).toBe(false);
  });

  it("lets a platform adapter's setFieldValue take priority", async () => {
    const root = mount(`<input />`);
    const input = root.querySelector("input") as HTMLInputElement;
    const adapter: PlatformResolverAdapter = { id: "test", setFieldValue: () => ({ ok: true, detail: "adapter wrote it" }) };
    const result = await setFieldValue({ element: input, strategy: "test" }, "x", "date", adapter);
    expect(result.detail).toBe("adapter wrote it");
    expect(input.value).toBe(""); // the generic writer never ran
  });
});

describe("invokeSemanticAction", () => {
  it("resolves and clicks the commit control", async () => {
    const root = mount(`<button>Save</button>`);
    const clicked = vi.fn();
    root.querySelector("button")!.addEventListener("click", clicked);
    const result = await invokeSemanticAction(root, SAVE);
    expect(result.ok).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("fails without clicking anything when the action cannot be resolved", async () => {
    const root = mount(`<div></div>`);
    const result = await invokeSemanticAction(root, SAVE);
    expect(result.ok).toBe(false);
  });
});

describe("waitForApplicationReaction", () => {
  it("resolves once the DOM stops mutating", async () => {
    const root = mount(`<div id="target"></div>`);
    const target = root.querySelector("#target") as HTMLElement;
    setTimeout(() => target.append(document.createTextNode("changed")), 10);
    const snapshot = await waitForApplicationReaction({ root, quietMs: 50, timeoutMs: 2000 });
    expect(snapshot.settled).toBe(true);
  });

  it("times out honestly when the page never settles", async () => {
    const root = mount(`<div id="target"></div>`);
    const target = root.querySelector("#target") as HTMLElement;
    const interval = setInterval(() => target.append(document.createTextNode(".")), 20);
    const snapshot = await waitForApplicationReaction({ root, quietMs: 50, timeoutMs: 150 });
    clearInterval(interval);
    expect(snapshot.settled).toBe(false);
  });
});

describe("verifyOutcome", () => {
  it("reports a visible validation error", () => {
    const root = mount(`<div role="alert">This field is required</div>`);
    const results = verifyOutcome({ root, checks: ["no-validation-error-visible"], inputs: [] });
    expect(results.find((check) => check.name === "validation_clear")?.status).toBe("fail");
  });

  it("reports validation clear when nothing alerts", () => {
    const root = mount(`<div>All good</div>`);
    const results = verifyOutcome({ root, checks: ["no-validation-error-visible"], inputs: [] });
    expect(results.find((check) => check.name === "validation_clear")?.status).toBe("pass");
  });

  it("verifies a field's value by reading it back", () => {
    const root = mount(`<label for="cd">Close Date</label><input id="cd" value="2026-12-15" />`);
    const results = verifyOutcome({
      root,
      checks: ["field-value-observable"],
      inputs: [{ target: CLOSE_DATE, expectedValue: "2026-12-15" }]
    });
    expect(results.find((check) => check.name === "value_verified")?.status).toBe("pass");
  });

  it("reports a mismatched value as failed, not skipped", () => {
    const root = mount(`<label for="cd">Close Date</label><input id="cd" value="2020-01-01" />`);
    const results = verifyOutcome({
      root,
      checks: ["field-value-observable"],
      inputs: [{ target: CLOSE_DATE, expectedValue: "2026-12-15" }]
    });
    expect(results.find((check) => check.name === "value_verified")?.status).toBe("fail");
  });

  it("reports read-back as skipped, never as a false pass, when the field cannot be re-resolved", () => {
    const root = mount(`<div>no field here</div>`);
    const results = verifyOutcome({
      root,
      checks: ["field-value-observable"],
      inputs: [{ target: CLOSE_DATE, expectedValue: "2026-12-15" }]
    });
    expect(results.find((check) => check.name === "value_verified")?.status).toBe("skipped");
  });
});
