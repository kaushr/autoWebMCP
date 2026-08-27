// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSalesforceResolverAdapter } from "../src/binding/browserExecution/salesforceAdapter";
import type { ResolvedTarget } from "../src/binding/browserExecution/engine";
import type { SemanticTarget } from "../src/binding/browserExecution/model";

function mount(html: string): HTMLElement {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

/** A minimal stand-in for an LWC-style component: a custom element that mirrors a `value` property. */
class MockLightningDatepicker extends HTMLElement {
  private _value = "";
  get value(): string {
    return this._value;
  }
  set value(next: string) {
    this._value = next;
  }
}
if (!customElements.get("mock-lightning-datepicker")) {
  customElements.define("mock-lightning-datepicker", MockLightningDatepicker);
}

const CLOSE_DATE: SemanticTarget = { role: "field", label: "Close Date", applicationIdentifier: "CloseDate" };

describe("Salesforce adapter — date value writing", () => {
  it("writes through the component's mirrored value property when one exists", async () => {
    const root = mount(`<mock-lightning-datepicker name="CloseDate"></mock-lightning-datepicker>`);
    const host = root.querySelector("mock-lightning-datepicker") as MockLightningDatepicker;
    const adapter = createSalesforceResolverAdapter();
    const resolved: ResolvedTarget = { element: host, strategy: "test" };

    const outcome = await adapter.setFieldValue!(resolved, "2026-12-15", "date");
    expect(outcome && outcome.ok).toBe(true);
    expect(host.value).toBe("2026-12-15");
  });

  it("falls back to a native date input reachable through the shadow root", async () => {
    const root = mount(`<div id="host"></div>`);
    const host = root.querySelector("#host") as HTMLElement;
    // Not a mirrored-value custom element — just a shadow host with a real date input inside.
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<input type="date" />`;
    const adapter = createSalesforceResolverAdapter();
    const resolved: ResolvedTarget = { element: host, strategy: "test" };

    const outcome = await adapter.setFieldValue!(resolved, "2026-12-15", "date");
    expect(outcome && outcome.ok).toBe(true);
    const native = shadow.querySelector("input") as HTMLInputElement;
    expect(native.value).toBe("2026-12-15");
  });

  it("falls back to the calendar popover, navigating by accessible month labels, when no native value path exists", async () => {
    const root = mount(`
      <div id="host">
        <button aria-label="Date picker"></button>
      </div>
      <div role="dialog">
        <h2 id="month-heading">November 2026</h2>
        <button aria-label="Next Month" id="next-month">&raquo;</button>
        <button aria-label="Previous Month">&laquo;</button>
        <table><tbody id="days">
          <tr><td><button aria-label="Sunday, November 15, 2026">15</button></td></tr>
        </tbody></table>
      </div>
    `);
    const host = root.querySelector("#host") as HTMLElement;
    // A real Lightning calendar re-renders its heading and day grid when
    // month-navigation is activated; simulate exactly that one transition.
    root.querySelector("#next-month")!.addEventListener("click", () => {
      root.querySelector("#month-heading")!.textContent = "December 2026";
      root.querySelector("#days")!.innerHTML =
        '<tr><td><button aria-label="Tuesday, December 15, 2026">15</button></td></tr>';
    });
    const adapter = createSalesforceResolverAdapter();
    const resolved: ResolvedTarget = { element: host, strategy: "test" };

    const outcome = await adapter.setFieldValue!(resolved, "2026-12-15", "date");
    expect(outcome && outcome.ok).toBe(true);
    expect(outcome && outcome.detail).toMatch(/labelled day/i);
  });

  it("reports failure rather than guessing when the target month is unreachable within the navigation bound", async () => {
    const root = mount(`
      <div id="host"><button aria-label="Date picker"></button></div>
      <div role="dialog"><h2>Not A Real Month 9999</h2></div>
    `);
    const host = root.querySelector("#host") as HTMLElement;
    const adapter = createSalesforceResolverAdapter();
    const resolved: ResolvedTarget = { element: host, strategy: "test" };

    const outcome = await adapter.setFieldValue!(resolved, "2026-12-15", "date");
    expect(outcome && outcome.ok).toBe(false);
  });

  it("declines non-date value kinds, leaving them to the generic engine", async () => {
    const root = mount(`<input />`);
    const input = root.querySelector("input") as HTMLInputElement;
    const adapter = createSalesforceResolverAdapter();
    const outcome = await adapter.setFieldValue!({ element: input, strategy: "test" }, "hello", "text");
    expect(outcome).toBeUndefined();
  });
});

describe("Salesforce adapter — reading a value back", () => {
  it("reads the mirrored value property back", () => {
    const root = mount(`<mock-lightning-datepicker></mock-lightning-datepicker>`);
    const host = root.querySelector("mock-lightning-datepicker") as MockLightningDatepicker;
    host.value = "2026-12-15";
    // The accessible name search needs an aria-label to find the custom element by its label.
    host.setAttribute("aria-label", "Close Date");
    const adapter = createSalesforceResolverAdapter();
    expect(adapter.readFieldValue!(root, CLOSE_DATE)).toBe("2026-12-15");
  });

  it("returns undefined — never a guessed value — when nothing matches", () => {
    const root = mount(`<div></div>`);
    const adapter = createSalesforceResolverAdapter();
    expect(adapter.readFieldValue!(root, CLOSE_DATE)).toBeUndefined();
  });
});

describe("Salesforce adapter — validation and edit-state detection", () => {
  it("detects an SLDS validation error", () => {
    const root = mount(`<div class="slds-has-error">Required</div>`);
    const adapter = createSalesforceResolverAdapter();
    expect(adapter.hasValidationError!(root)).toBe(true);
  });

  it("reports no validation error when none is visible", () => {
    const root = mount(`<div>fine</div>`);
    const adapter = createSalesforceResolverAdapter();
    expect(adapter.hasValidationError!(root)).toBe(false);
  });

  it("reports the edit surface as still open while a record-edit modal is present", () => {
    const root = mount(`<div role="dialog" aria-modal="true">editing…</div>`);
    const adapter = createSalesforceResolverAdapter();
    expect(adapter.isEditStateClosed!(root)).toBe(false);
  });

  it("reports the edit surface as closed once no edit modal remains", () => {
    const root = mount(`<div>record view</div>`);
    const adapter = createSalesforceResolverAdapter();
    expect(adapter.isEditStateClosed!(root)).toBe(true);
  });
});
