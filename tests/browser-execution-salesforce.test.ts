// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSalesforceResolverAdapter } from "../src/binding/browserExecution/salesforceAdapter";
import type { ResolvedTarget } from "../src/binding/browserExecution/engine";
import type { SemanticTarget } from "../src/binding/browserExecution/model";
import { resolutionPolicyForPlatform, resolverAdapterForPlatform } from "../src/binding/browserExecution/adapters";

/** The real policy Salesforce declares in its pack — not a test-local invention. */
const SF = resolutionPolicyForPlatform("salesforce-lightning");
/** The production composition root, carrying the pack's page-state semantics. */
const salesforceAdapter = () => resolverAdapterForPlatform("salesforce-lightning")!;

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

describe("Salesforce adapter — resolving a field nested in shadow DOM", () => {
  it("finds a field host inside another component's shadow root, labelled by a shadow-scoped <label for>", () => {
    // The live-Salesforce shape: the field host is not in the light DOM at
    // all, and its <label for> lives in the same shadow root, referencing an
    // id scoped to that root — so both a plain traversal and a
    // document-scoped name lookup fail to find it.
    const root = mount(`<record-form></record-form>`);
    const form = root.querySelector("record-form") as HTMLElement;
    const shadow = form.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <label for="cd">*Close Date</label>
      <mock-lightning-datepicker id="cd" name="CloseDate"></mock-lightning-datepicker>
    `;

    const adapter = createSalesforceResolverAdapter();
    const resolved = adapter.resolveTarget!(
      root,
      { role: "field", label: "*Close Date", applicationIdentifier: "CloseDate" },
      SF
    );

    expect(resolved).toBeDefined();
    expect(resolved!.element.getAttribute("name")).toBe("CloseDate");
  });

  it("reads a shadow-nested field's value back through the same search", () => {
    const root = mount(`<record-form></record-form>`);
    const form = root.querySelector("record-form") as HTMLElement;
    const shadow = form.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <label for="cd">*Close Date</label>
      <mock-lightning-datepicker id="cd" name="CloseDate"></mock-lightning-datepicker>
    `;
    (shadow.querySelector("#cd") as MockLightningDatepicker).value = "2026-09-25";

    const adapter = createSalesforceResolverAdapter();
    expect(
      adapter.readFieldValue!(root, { role: "field", label: "*Close Date", applicationIdentifier: "CloseDate" }, SF)
    ).toBe("2026-09-25");
  });
});

describe("Salesforce adapter — date value writing", () => {
  it("writes through the component's mirrored value property when one exists", async () => {
    const root = mount(`<mock-lightning-datepicker name="CloseDate"></mock-lightning-datepicker>`);
    const host = root.querySelector("mock-lightning-datepicker") as MockLightningDatepicker;
    const adapter = createSalesforceResolverAdapter();
    const resolved: ResolvedTarget = { element: host, strategy: "test" };

    const outcome = await adapter.setFieldValue!(resolved, "2026-12-15", "date", SF);
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

    const outcome = await adapter.setFieldValue!(resolved, "2026-12-15", "date", SF);
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

    const outcome = await adapter.setFieldValue!(resolved, "2026-12-15", "date", SF);
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

    const outcome = await adapter.setFieldValue!(resolved, "2026-12-15", "date", SF);
    expect(outcome && outcome.ok).toBe(false);
  });

  it("declines non-date value kinds, leaving them to the generic engine", async () => {
    const root = mount(`<input />`);
    const input = root.querySelector("input") as HTMLInputElement;
    const adapter = createSalesforceResolverAdapter();
    const outcome = await adapter.setFieldValue!({ element: input, strategy: "test" }, "hello", "text", SF);
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
    expect(adapter.readFieldValue!(root, CLOSE_DATE, SF)).toBe("2026-12-15");
  });

  it("returns undefined — never a guessed value — when nothing matches", () => {
    const root = mount(`<div></div>`);
    const adapter = createSalesforceResolverAdapter();
    expect(adapter.readFieldValue!(root, CLOSE_DATE, SF)).toBeUndefined();
  });
});

describe("Salesforce adapter — validation and edit-state detection", () => {
  it("detects an SLDS validation error", () => {
    const root = mount(`<div class="slds-has-error">Required</div>`);
    const adapter = createSalesforceResolverAdapter();
    expect(adapter.hasValidationError!(root, SF)).toBe(true);
  });

  it("reports no validation error when none is visible", () => {
    const root = mount(`<div>fine</div>`);
    const adapter = createSalesforceResolverAdapter();
    expect(adapter.hasValidationError!(root, SF)).toBe(false);
  });

  it("reports the edit surface as still open while a genuine record-edit modal is present", () => {
    const root = mount(EDIT_SURFACE_HTML);
    const adapter = salesforceAdapter();
    expect(adapter.isEditStateClosed!(root, SF)).toBe(false);
  });

  it("reports the edit surface as closed once no record-edit surface remains — an unrelated leftover dialog does not count", () => {
    const root = mount(`<div role="dialog" aria-modal="true">a docked utility panel</div>`);
    const adapter = salesforceAdapter();
    expect(adapter.isEditStateClosed!(root, SF)).toBe(true);
  });
});

/**
 * A genuine record-edit surface under the pack's semantics: a modal holding
 * multiple editable record fields together with a Save commit action.
 */
const EDIT_SURFACE_HTML = `
  <div role="dialog" aria-modal="true" id="edit-dialog">
    <label for="cd">*Close Date</label><input id="cd" name="CloseDate" />
    <label for="am">Amount</label><input id="am" name="Amount" />
    <button>Save</button><button>Cancel</button>
  </div>
`;

function appendEditSurface(target: Element): void {
  const holder = document.createElement("div");
  holder.innerHTML = EDIT_SURFACE_HTML;
  target.appendChild(holder.firstElementChild!);
}

describe("Salesforce adapter — page-state model", () => {
  it("case 1: record view with a visible unrelated dialog stays record-view — the live false positive", async () => {
    // The exact live failure: a Lightning record page carrying a visible
    // dialog-role surface (docked utility bar, panel) while in plain view.
    const root = mount(`
      <div role="dialog" aria-modal="true">a docked utility panel with text only</div>
      <button>Edit</button>
    `);
    root.querySelector("button")!.addEventListener("click", () => appendEditSurface(root));

    const transition = await salesforceAdapter().ensureEditable!(root, SF)!;
    expect(transition.initialState).toBe("record-view");
    expect(transition.editActionInvoked).toBe(true);
    expect(transition.ok).toBe(true);
    expect(transition.finalState).toBe("record-edit");
  });

  it("case 2: a panel with one lone field and a Save button is not edit mode", async () => {
    const root = mount(`
      <div role="dialog" aria-modal="true">
        <label for="n">Note</label><input id="n" />
        <button>Save</button>
      </div>
    `);
    const transition = await salesforceAdapter().ensureEditable!(root, SF)!;
    expect(transition.initialState).not.toBe("record-edit");
    expect(transition.ok).toBe(false);
  });

  it("case 3a: a surface with multiple editable fields and Save qualifies structurally", async () => {
    const root = mount(EDIT_SURFACE_HTML);
    const transition = await salesforceAdapter().ensureEditable!(root, SF)!;
    expect(transition.ok).toBe(true);
    expect(transition.initialState).toBe("record-edit");
  });

  it("case 3b: Salesforce's record-edit component qualifies on its own identity", async () => {
    const root = mount(`<lightning-record-edit-form>loading…</lightning-record-edit-form>`);
    const transition = await salesforceAdapter().ensureEditable!(root, SF)!;
    expect(transition.ok).toBe(true);
    expect(transition.initialState).toBe("record-edit");
  });

  it("case 5: an Edit click whose surface never appears is a failed transition with diagnostics", async () => {
    const root = mount(`<button>Edit</button>`); // no listener — clicking does nothing
    const transition = await salesforceAdapter().ensureEditable!(root, SF)!;
    expect(transition.ok).toBe(false);
    expect(transition.editActionResolved).toBe(true);
    expect(transition.editActionInvoked).toBe(true);
    expect(transition.finalState).not.toBe("record-edit");
    expect(transition.diagnostics.join("\n")).toMatch(/Resulting Salesforce page state/);
  }, 10000);

  it("case 6: already in record-edit means no Edit click at all", async () => {
    const root = mount(EDIT_SURFACE_HTML + `<button id="outer-edit">Edit</button>`);
    const clicked = { count: 0 };
    root.querySelector("#outer-edit")!.addEventListener("click", () => clicked.count++);

    const transition = await salesforceAdapter().ensureEditable!(root, SF)!;
    expect(transition.ok).toBe(true);
    expect(transition.editActionInvoked).toBe(false);
    expect(clicked.count).toBe(0);
  });

  it("case 7: resolves an Edit control nested behind multiple shadow boundaries", async () => {
    const root = mount(`<record-action-bar></record-action-bar>`);
    const wrapper = root.querySelector("record-action-bar") as HTMLElement;
    const shadow = wrapper.attachShadow({ mode: "open" });
    shadow.innerHTML = `<lightning-button-shell></lightning-button-shell>`;
    const buttonShell = shadow.querySelector("lightning-button-shell") as HTMLElement;
    const innerShadow = buttonShell.attachShadow({ mode: "open" });
    innerShadow.innerHTML = `<button>Edit</button>`;
    innerShadow.querySelector("button")!.addEventListener("click", () => appendEditSurface(root));

    const transition = await salesforceAdapter().ensureEditable!(root, SF)!;
    expect(transition.ok).toBe(true);
  });

  it("case 8: a qualifying surface whose fields sit behind shadow boundaries is still record-edit", async () => {
    const root = mount(`<div role="dialog" aria-modal="true" id="edit-dialog"><button>Save</button></div>`);
    const dialog = root.querySelector("#edit-dialog")!;
    for (const name of ["CloseDate", "Amount"]) {
      const host = document.createElement("record-field-wrapper-" + name.toLowerCase());
      dialog.appendChild(host);
      const inner = host.attachShadow({ mode: "open" });
      inner.innerHTML = `<input name="${name}" />`;
    }

    const transition = await salesforceAdapter().ensureEditable!(root, SF)!;
    expect(transition.ok).toBe(true);
    expect(transition.initialState).toBe("record-edit");
  });

  it("case 9: Save and Cancel buttons elsewhere on the page do not by themselves prove edit mode", async () => {
    const root = mount(`
      <button>Save</button><button>Cancel</button>
      <label for="a">Something</label><input id="a" />
      <label for="b">Other</label><input id="b" />
      <div role="dialog" aria-modal="true">unrelated panel, no fields</div>
    `);
    const transition = await salesforceAdapter().ensureEditable!(root, SF)!;
    expect(transition.ok).toBe(false);
    expect(transition.initialState).not.toBe("record-edit");
  });

  it("reports failure, never a guess, when no accessible Edit control exists", async () => {
    const root = mount(`<div>nothing to click here</div>`);
    const transition = await salesforceAdapter().ensureEditable!(root, SF)!;
    expect(transition.ok).toBe(false);
    expect(transition.editActionResolved).toBe(false);
    expect(transition.diagnostics.join("\n")).toMatch(/Edit action resolved: no/);
  });
});
