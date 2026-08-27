// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { setFieldValue, resolveSemanticTarget } from "../src/binding/browserExecution/engine";
import { resolutionPolicyForPlatform, resolverAdapterForPlatform } from "../src/binding/browserExecution/adapters";
import type { SemanticTarget } from "../src/binding/browserExecution/model";

/* ------------------------------------------------------------------ *
 * Semantic picklist execution.
 *
 * A Lightning picklist is a combobox trigger plus a listbox, rendered
 * across nested shadow roots, and the live capture proved it exposes no
 * `name` on any event. These cases mirror that shape: the option a human
 * would click is always at least two boundaries deep, and the only things
 * this strategy is allowed to use to find it are ARIA roles and the
 * option's own accessible name.
 * ------------------------------------------------------------------ */

const SF = resolutionPolicyForPlatform("salesforce-lightning");
const adapter = () => resolverAdapterForPlatform("salesforce-lightning");

const STAGE: SemanticTarget = { role: "field", label: "*Stage" };

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

function shadow(host: Element, html: string): ShadowRoot {
  const root = (host as HTMLElement).attachShadow({ mode: "open" });
  root.innerHTML = html;
  return root;
}

/**
 * The real shape: `lightning-combobox` → `lightning-base-combobox` →
 * trigger button, with the listbox rendered as a sibling inside the inner
 * root and only populated once the trigger is clicked.
 */
function mountPicklist(options: string[], opts: { selected?: string; portalled?: boolean } = {}): HTMLElement {
  const root = mount(`
    <records-record-edit>
      <label for="stage-field">*Stage</label>
      <lightning-combobox id="stage-field"></lightning-combobox>
    </records-record-edit>
    <div id="portal"></div>
  `);
  const combobox = root.querySelector("lightning-combobox")!;
  const outer = shadow(combobox, `<lightning-base-combobox></lightning-base-combobox>`);
  const inner = shadow(
    outer.querySelector("lightning-base-combobox")!,
    `<button role="combobox" aria-haspopup="listbox">${opts.selected ?? "Select an Option"}</button>
     <div class="dropdown" hidden></div>`
  );

  const trigger = inner.querySelector("button")!;
  const dropdown = inner.querySelector(".dropdown")!;
  const listboxHome = opts.portalled ? root.querySelector("#portal")! : dropdown;

  trigger.addEventListener("click", () => {
    dropdown.removeAttribute("hidden");
    listboxHome.innerHTML = `<div role="listbox">${options
      .map((option) => `<lightning-base-combobox-item role="option">${option}</lightning-base-combobox-item>`)
      .join("")}</div>`;
    for (const item of listboxHome.querySelectorAll('[role="option"]')) {
      item.addEventListener("click", () => {
        trigger.textContent = item.textContent ?? "";
        listboxHome.innerHTML = "";
        dropdown.setAttribute("hidden", "");
      });
    }
  });
  return root;
}

describe("13 — semantic picklist execution through nested shadow roots", () => {
  it("opens the combobox and selects the option by its visible name", async () => {
    const root = mountPicklist(["Prospecting", "Negotiation/Review", "Closed Won"]);
    const resolved = resolveSemanticTarget(root, STAGE, adapter());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const outcome = await setFieldValue(resolved.target, "Closed Won", "select", adapter());
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toMatch(/Closed Won/);
  });

  it("finds a listbox the component portalled outside the field's own subtree", async () => {
    const root = mountPicklist(["Prospecting", "Closed Won"], { portalled: true });
    const resolved = resolveSemanticTarget(root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);

    const outcome = await setFieldValue(resolved.target, "Closed Won", "select", adapter());
    expect(outcome.ok).toBe(true);
  });

  it("uses no selector, coordinate, or index contract — only the option's accessible name", async () => {
    // The same option at a different list position still resolves; nothing
    // here depends on where it sits.
    const root = mountPicklist(["Closed Won", "Prospecting", "Negotiation/Review"]);
    const resolved = resolveSemanticTarget(root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);
    expect((await setFieldValue(resolved.target, "Negotiation/Review", "select", adapter())).ok).toBe(true);
  });
});

describe("14 — the selected value is verified when it can be read", () => {
  it("reads the combobox back through the same field host that was written", async () => {
    const root = mountPicklist(["Prospecting", "Closed Won"]);
    const resolved = resolveSemanticTarget(root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);

    await setFieldValue(resolved.target, "Closed Won", "select", adapter());
    expect(adapter()?.readFieldValue?.(root, STAGE, SF)).toBe("Closed Won");
  });

  it("reports failure when the control did not take the value", async () => {
    const root = mountPicklist(["Prospecting", "Closed Won"]);
    // A component that opens and offers the option but ignores the click.
    const inner = root
      .querySelector("lightning-combobox")!
      .shadowRoot!.querySelector("lightning-base-combobox")!.shadowRoot!;
    const trigger = inner.querySelector("button")!;
    trigger.addEventListener("click", () => {
      for (const item of inner.querySelectorAll('[role="option"]')) {
        const clone = item.cloneNode(true);
        item.replaceWith(clone); // drops the selection listener
      }
    });

    const resolved = resolveSemanticTarget(root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);
    const outcome = await setFieldValue(resolved.target, "Closed Won", "select", adapter());
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/still shows/i);
  });
});

describe("the application stays the authority on what is legal", () => {
  it("refuses an option the live list does not offer, and says what was offered", async () => {
    const root = mountPicklist(["Prospecting", "Closed Won"]);
    const resolved = resolveSemanticTarget(root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);

    const outcome = await setFieldValue(resolved.target, "Closed Sideways", "select", adapter());
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/not currently offered/i);
    expect(outcome.detail).toMatch(/Prospecting, Closed Won/);
  });

  it("refuses rather than guessing when two options share a name", async () => {
    const root = mountPicklist(["Closed Won", "Closed Won"]);
    const resolved = resolveSemanticTarget(root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);
    const outcome = await setFieldValue(resolved.target, "Closed Won", "select", adapter());
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/unique choice could not be made/i);
  });

  it("reports honestly when the field has no combobox at all", async () => {
    const root = mount(
      `<records-record-edit><label for="stage-field">*Stage</label><lightning-input id="stage-field"></lightning-input></records-record-edit>`
    );
    shadow(root.querySelector("lightning-input")!, `<input type="text" />`);
    const resolved = resolveSemanticTarget(root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);
    const outcome = await setFieldValue(resolved.target, "Closed Won", "select", adapter());
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/No combobox control was found/i);
  });
});
