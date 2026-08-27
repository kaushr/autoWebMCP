// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { inspectValueDomains } from "../src/binding/browserExecution/execute";
import { readSemanticOptions, setFieldValue, resolveSemanticTarget } from "../src/binding/browserExecution/engine";
import { resolverAdapterForPlatform } from "../src/binding/browserExecution/adapters";
import { buildTestFormFields, validateTestInputs } from "../src/training/executionTestForm";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserExecutionBinding, SemanticTarget } from "../src/binding/browserExecution/model";
import type { SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * The value domain is a third thing.
 *
 * A live two-field run made the distinction concrete: Stage was correctly
 * grounded to Opportunity.StageName and correctly typed as a picklist, but
 * because no tenant metadata listed its values the form degraded to a text
 * box, accepted "asdfdwsfsdfsdfsdfsd", and handed that to a runtime with
 * nothing sensible to do with it.
 *
 *   identity  Opportunity.StageName     stable
 *   type      picklist                  changes when an admin redefines it
 *   domain    whatever it offers NOW    varies by record type, dependent
 *                                       picklists, and permissions
 *
 * An unknown domain means "not established yet", never "unconstrained".
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";
const adapter = () => resolverAdapterForPlatform(PLATFORM);
const SALESFORCE = sourceApplicationFor(PLATFORM, "example.lightning.force.com");
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
 * A Lightning picklist as the live page renders it: the control is a bare
 * `<button role="combobox">` two shadow boundaries down, and the listbox is
 * only populated once it is opened.
 */
function mountPicklist(options: string[], opts: { selected?: string; alreadyEditing?: boolean } = {}): {
  root: HTMLElement;
  saves: number;
  selections: string[];
} {
  const state = { saves: 0, selections: [] as string[] };
  const root = mount(`
    <records-record-edit>
      <label for="stage-field">*Stage</label>
      <lightning-combobox id="stage-field"></lightning-combobox>
      <input id="amount" name="Amount" aria-label="Amount" />
      <input id="name" name="Name" aria-label="Opportunity Name" />
      <input id="close" name="CloseDate" type="date" aria-label="Close Date" />
      <button id="save">Save</button>
      <button id="cancel">Cancel</button>
    </records-record-edit>
  `);
  root.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", () => {
    state.saves++;
  });

  const outer = shadow(root.querySelector("lightning-combobox")!, `<lightning-base-combobox></lightning-base-combobox>`);
  const inner = shadow(
    outer.querySelector("lightning-base-combobox")!,
    `<button role="combobox" aria-expanded="false">${opts.selected ?? "Select an Option"}</button>
     <div class="dropdown"></div>`
  );
  const trigger = inner.querySelector("button")!;
  const dropdown = inner.querySelector(".dropdown")!;

  const close = (): void => {
    dropdown.innerHTML = "";
    trigger.setAttribute("aria-expanded", "false");
  };
  trigger.addEventListener("click", () => {
    if (trigger.getAttribute("aria-expanded") === "true") return close();
    trigger.setAttribute("aria-expanded", "true");
    dropdown.innerHTML = `<div role="listbox">${options
      .map((option) => `<lightning-base-combobox-item role="option">${option}</lightning-base-combobox-item>`)
      .join("")}</div>`;
    for (const item of dropdown.querySelectorAll('[role="option"]')) {
      item.addEventListener("click", () => {
        trigger.textContent = item.textContent ?? "";
        state.selections.push(item.textContent ?? "");
        close();
      });
    }
  });
  trigger.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape") close();
  });

  return {
    root,
    get saves() {
      return state.saves;
    },
    get selections() {
      return state.selections;
    }
  };
}

function bindingFor(options?: string[]): BrowserExecutionBinding {
  return {
    id: "browser-update_opportunity",
    capabilityId: "update_opportunity",
    sourceApplication: SALESFORCE,
    platform: PLATFORM,
    context: { recordType: "Opportunity", pageMode: "edit-or-record" },
    inputs: [
      {
        semanticInput: "stage",
        semanticTarget: STAGE,
        valueKind: "select",
        applicationField: {
          objectApiName: "Opportunity",
          apiName: "StageName",
          type: "picklist",
          knowledge: "standard",
          release: "summer-26",
          ...(options ? { options, optionsSource: "tenant" as const, domain: "known-tenant" as const } : { domain: "discoverable-live" as const })
        }
      }
    ],
    commit: { semanticAction: { role: "button", label: "Save" } },
    verification: ["no-validation-error-visible"],
    safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
    evidence: []
  };
}

const capability: SemanticCapability = {
  id: "update_opportunity",
  name: "Update opportunity",
  description: "Change an opportunity's stage and save.",
  inputs: [{ name: "stage", description: "stage", type: "string", required: true }],
  outputs: [],
  provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
  safety: { readOnly: false, requiresConfirmation: true }
};

/* --------------------------- the form contract --------------------------- */

describe("A — tenant options render a dropdown", () => {
  it("uses the org's own values with no live inspection needed", () => {
    const fields = buildTestFormFields(capability, bindingFor(["Prospecting", "Closed Won"]));
    expect(fields[0]).toMatchObject({ control: "select", options: ["Prospecting", "Closed Won"] });
    expect(fields[0].domainUnknown).toBeUndefined();
  });
});

describe("B — live options become the domain when metadata has none", () => {
  it("renders a dropdown from what the application currently offers", () => {
    const fields = buildTestFormFields(capability, bindingFor(), { stage: ["Qualify", "Closed Won"] });
    expect(fields[0]).toMatchObject({ control: "select", options: ["Qualify", "Closed Won"] });
    expect(fields[0].domainUnknown).toBeUndefined();
  });

  it("I — live values outrank a stale stored domain, because a record type can narrow them", () => {
    const fields = buildTestFormFields(capability, bindingFor(["Prospecting", "Closed Won", "Closed Lost"]), {
      stage: ["Closed Won"]
    });
    expect(fields[0].options).toEqual(["Closed Won"]);
  });
});

describe("C — neither source: constrained, and honest about it", () => {
  const fields = buildTestFormFields(capability, bindingFor());

  it("stays a fixed set of choices rather than degrading to free text", () => {
    expect(fields[0].control).toBe("select");
    expect(fields[0].domainUnknown).toBe(true);
    expect(fields[0].options).toBeUndefined();
  });

  it("D — refuses any supplied value, so nothing reaches the application", () => {
    const result = validateTestInputs(fields, { stage: "asdfdwsfsdfsdfsdfsd" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/valid values are not known yet/i);
  });

  it("D — and refuses an empty one with the same explanation, not a bare 'required'", () => {
    const result = validateTestInputs(fields, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/not known yet/i);
  });
});

/* ------------------------- live introspection ------------------------- */

describe("F & H — reading the live domain through nested shadow roots", () => {
  it("F — reads the offered values across two shadow boundaries", () => {
    const page = mountPicklist(["Prospecting", "Negotiation/Review", "Closed Won"]);
    expect(readSemanticOptions(page.root, STAGE, adapter())).toEqual([
      "Prospecting",
      "Negotiation/Review",
      "Closed Won"
    ]);
  });

  it("H — changes nothing: no option selected, no save invoked, popup left closed", () => {
    const page = mountPicklist(["Prospecting", "Closed Won"]);
    readSemanticOptions(page.root, STAGE, adapter());

    expect(page.selections).toEqual([]);
    expect(page.saves).toBe(0);
    const trigger = page.root
      .querySelector("lightning-combobox")!
      .shadowRoot!.querySelector("lightning-base-combobox")!
      .shadowRoot!.querySelector("button")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toBe("Select an Option");
  });

  it("G — duplicate option labels collapse rather than producing a repeated choice", () => {
    const page = mountPicklist(["Closed Won", "Closed Won", "Prospecting"]);
    expect(readSemanticOptions(page.root, STAGE, adapter())).toEqual(["Closed Won", "Prospecting"]);
  });

  it("reports nothing rather than an empty domain when the control cannot be read", () => {
    const root = mount(`<records-record-edit><label for="s">*Stage</label><input id="s" /></records-record-edit>`);
    expect(readSemanticOptions(root, STAGE, adapter())).toBeUndefined();
  });
});

describe("the whole-binding inspection", () => {
  it("collects domains for closed-domain inputs and commits nothing", async () => {
    const page = mountPicklist(["Prospecting", "Closed Won"]);
    const inspection = await inspectValueDomains({
      root: page.root,
      binding: bindingFor(),
      adapter: adapter(),
      reaction: { quietMs: 10, timeoutMs: 200 }
    });
    expect(inspection.options).toEqual({ stage: ["Prospecting", "Closed Won"] });
    expect(inspection.unresolved).toEqual({});
    expect(page.saves).toBe(0);
    expect(page.selections).toEqual([]);
  });

  it("says which inputs it could not read, rather than reporting an empty domain", async () => {
    mount(`<records-record-edit>
      <label for="s">*Stage</label><input id="s" aria-label="*Stage" />
      <input id="a" aria-label="Amount" /><input id="b" aria-label="Name" />
      <button>Save</button><button>Cancel</button>
    </records-record-edit>`);
    const inspection = await inspectValueDomains({
      root: document.body,
      binding: bindingFor(),
      adapter: adapter(),
      reaction: { quietMs: 10, timeoutMs: 200 }
    });
    expect(inspection.options).toEqual({});
    expect(inspection.unresolved.stage).toMatch(/could not be inspected/i);
  });
});

/* --------------------------- runtime defence --------------------------- */

describe("D & E — the live list is the authority at execution time", () => {
  it("E — selects an offered value through the semantic combobox path", async () => {
    const page = mountPicklist(["Prospecting", "Closed Won"]);
    const resolved = resolveSemanticTarget(page.root, STAGE, adapter());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const outcome = await setFieldValue(resolved.target, "Closed Won", "select", adapter());
    expect(outcome.ok).toBe(true);
    expect(page.selections).toEqual(["Closed Won"]);
    expect(page.saves).toBe(0);
  });

  it("D — refuses a value the application does not currently offer, and names what it does", async () => {
    const page = mountPicklist(["Prospecting", "Closed Won"]);
    const resolved = resolveSemanticTarget(page.root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);

    const outcome = await setFieldValue(resolved.target, "asdfdwsfsdfsdfsdfsd", "select", adapter());
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/not currently offered/i);
    expect(outcome.detail).toMatch(/Prospecting, Closed Won/);
    expect(page.saves).toBe(0);
  });

  it("does not coerce a near miss onto a real value", async () => {
    const page = mountPicklist(["Closed Won", "Closed Lost"]);
    const resolved = resolveSemanticTarget(page.root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);
    const outcome = await setFieldValue(resolved.target, "closed", "select", adapter());
    expect(outcome.ok).toBe(false);
    expect(page.selections).toEqual([]);
  });
});

describe("7 — the DOM element's tag never overrides the field's semantic type", () => {
  it("routes a picklist through the combobox strategy even when the control is a bare <button>", async () => {
    // The live failure: the field resolved to a <button>, fell through to
    // the generic value writer, and reported "<button> has no generic way
    // to receive a value". The application field's type decides the
    // strategy; the DOM tag does not.
    const root = mount(`
      <records-record-edit>
        <label for="stage-field">*Stage</label>
        <button id="stage-field" role="combobox" aria-expanded="false">Select an Option</button>
        <div id="popup"></div>
      </records-record-edit>
    `);
    const trigger = root.querySelector<HTMLButtonElement>("#stage-field")!;
    const popup = root.querySelector("#popup")!;
    trigger.addEventListener("click", () => {
      trigger.setAttribute("aria-expanded", "true");
      popup.innerHTML = `<div role="listbox"><div role="option">Closed Won</div></div>`;
      popup.querySelector('[role="option"]')!.addEventListener("click", () => {
        trigger.textContent = "Closed Won";
        popup.innerHTML = "";
        trigger.setAttribute("aria-expanded", "false");
      });
    });

    const resolved = resolveSemanticTarget(root, STAGE, adapter());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.target.element.tagName).toBe("BUTTON");

    const outcome = await setFieldValue(resolved.target, "Closed Won", "select", adapter());
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).not.toMatch(/no generic way to receive a value/i);
    expect(trigger.textContent).toBe("Closed Won");
  });

  it("reads the live options from that same bare-button control", () => {
    const root = mount(`
      <records-record-edit>
        <label for="stage-field">*Stage</label>
        <button id="stage-field" role="combobox" aria-expanded="false">Select an Option</button>
        <div id="popup"></div>
      </records-record-edit>
    `);
    const trigger = root.querySelector<HTMLButtonElement>("#stage-field")!;
    const popup = root.querySelector("#popup")!;
    trigger.addEventListener("click", () => {
      const open = trigger.getAttribute("aria-expanded") === "true";
      trigger.setAttribute("aria-expanded", open ? "false" : "true");
      popup.innerHTML = open ? "" : `<div role="listbox"><div role="option">Qualify</div><div role="option">Closed Won</div></div>`;
    });
    trigger.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") {
        popup.innerHTML = "";
        trigger.setAttribute("aria-expanded", "false");
      }
    });

    expect(readSemanticOptions(root, STAGE, adapter())).toEqual(["Qualify", "Closed Won"]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

/* ------------------------------ no regressions ------------------------------ */

describe("J — Close Date is untouched by any of this", () => {
  it("is not a closed-domain field, so nothing is inspected for it", async () => {
    const dateBinding: BrowserExecutionBinding = {
      ...bindingFor(),
      inputs: [
        {
          semanticInput: "close_date",
          semanticTarget: { role: "field", label: "*Close Date", applicationIdentifier: "CloseDate" },
          valueKind: "date",
          applicationField: {
            objectApiName: "Opportunity",
            apiName: "CloseDate",
            type: "date",
            knowledge: "standard",
            release: "summer-26"
          }
        }
      ]
    };
    mount(`<records-record-edit>
      <label for="cd">*Close Date</label><input id="cd" name="CloseDate" type="date" />
      <input id="a" aria-label="Amount" /><input id="b" aria-label="Name" />
      <button>Save</button><button>Cancel</button>
    </records-record-edit>`);
    const inspection = await inspectValueDomains({ root: document.body, binding: dateBinding, adapter: adapter() });
    expect(inspection.options).toEqual({});
    expect(inspection.unresolved).toEqual({});

    const fields = buildTestFormFields(
      { ...capability, inputs: [{ name: "close_date", description: "close_date", type: "date", required: true }] },
      dateBinding
    );
    expect(fields[0]).toMatchObject({ control: "date" });
    expect(fields[0].domainUnknown).toBeUndefined();
  });
});
