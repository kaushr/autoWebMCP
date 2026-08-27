// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { executeConfirmed } from "../src/binding/browserExecution/execute";
import { invokeSemanticAction, resolveSemanticTarget } from "../src/binding/browserExecution/engine";
import {
  resolutionPolicyForPlatform,
  resolverAdapterForPlatform
} from "../src/binding/browserExecution/adapters";
import { DEFAULT_RESOLUTION_POLICY } from "../src/binding/browserExecution/resolutionPolicy";
import { createSalesforceResolverAdapter } from "../src/binding/browserExecution/salesforceAdapter";
import type { BrowserExecutionBinding, SemanticTarget } from "../src/binding/browserExecution/model";
import { sourceApplicationFor } from "../src/training/sourceApplication";

/* ------------------------------------------------------------------ *
 * The regression suite for the defect class that recurred four times in
 * one live Salesforce session: a lookup that could not cross a shadow
 * boundary. Each case below nests the thing being resolved at least one
 * boundary deep — several of them deeper than any single-level
 * `host.shadowRoot.querySelector` would reach — so the composed-tree
 * foundation is exercised, not just the flat happy path.
 * ------------------------------------------------------------------ */

const SF = resolutionPolicyForPlatform("salesforce-lightning");
const salesforceAdapter = () => resolverAdapterForPlatform("salesforce-lightning");
const SALESFORCE = sourceApplicationFor("salesforce-lightning", "example.lightning.force.com");

class MirroredValueHost extends HTMLElement {
  private _value = "";
  get value(): string {
    return this._value;
  }
  set value(next: string) {
    this._value = next;
  }
}
if (!customElements.get("mirrored-value-host")) customElements.define("mirrored-value-host", MirroredValueHost);

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** Attaches an open shadow root and fills it, returning the root. */
function shadow(host: Element, html: string): ShadowRoot {
  const root = (host as HTMLElement).attachShadow({ mode: "open" });
  root.innerHTML = html;
  return root;
}

const CLOSE_DATE: SemanticTarget = {
  role: "field",
  label: "*Close Date",
  applicationIdentifier: "CloseDate"
};

describe("1 — an action nested one or more shadow boundaries deep", () => {
  it("resolves and clicks an Edit control whose native button is two boundaries down", async () => {
    const root = mount(`<record-actions></record-actions>`);
    const outer = shadow(root.querySelector("record-actions")!, `<lightning-button></lightning-button>`);
    const inner = shadow(outer.querySelector("lightning-button")!, `<button>Edit</button>`);

    const adapter = salesforceAdapter();
    let opened = false;
    inner.querySelector("button")!.addEventListener("click", () => (opened = true));

    const outcome = await invokeSemanticAction(root, { role: "button", label: "Edit" }, adapter);
    expect(outcome.ok).toBe(true);
    expect(opened).toBe(true);
  });
});

describe("2 — a field host nested one or more shadow boundaries deep", () => {
  it("resolves the field host through two component boundaries", () => {
    const root = mount(`<record-form></record-form>`);
    const outer = shadow(root.querySelector("record-form")!, `<field-section></field-section>`);
    shadow(
      outer.querySelector("field-section")!,
      `<label for="cd">*Close Date</label><mirrored-value-host id="cd" name="CloseDate"></mirrored-value-host>`
    );

    const outcome = resolveSemanticTarget(root, CLOSE_DATE, salesforceAdapter());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.target.element.getAttribute("name")).toBe("CloseDate");
  });
});

describe("3 — a native input nested beneath component shadow roots", () => {
  it("writes into a native date input two boundaries below the resolved host", async () => {
    // The precise shape a real `lightning-input type="date"` takes: the host
    // a semantic target resolves to renders a primitive component, which
    // renders the actual <input>. One level of `host.shadowRoot` misses it.
    const root = mount(`<lightning-input name="CloseDate" aria-label="*Close Date"></lightning-input>`);
    const host = root.querySelector("lightning-input")!;
    const outer = shadow(host, `<lightning-primitive-input-date></lightning-primitive-input-date>`);
    const inner = shadow(outer.querySelector("lightning-primitive-input-date")!, `<input type="date" />`);

    const adapter = createSalesforceResolverAdapter();
    const outcome = await adapter.setFieldValue!({ element: host, strategy: "test" }, "2026-12-15", "date", SF);

    expect(outcome && outcome.ok).toBe(true);
    expect((inner.querySelector("input") as HTMLInputElement).value).toBe("2026-12-15");
  });

  it("writes the locale display format into a nested non-date native input", async () => {
    const root = mount(`<lightning-input name="CloseDate" aria-label="*Close Date"></lightning-input>`);
    const host = root.querySelector("lightning-input")!;
    const outer = shadow(host, `<lightning-primitive-input></lightning-primitive-input>`);
    const inner = shadow(outer.querySelector("lightning-primitive-input")!, `<input type="text" />`);

    const adapter = createSalesforceResolverAdapter();
    const outcome = await adapter.setFieldValue!({ element: host, strategy: "test" }, "2026-12-15", "date", SF);

    expect(outcome && outcome.ok).toBe(true);
    expect((inner.querySelector("input") as HTMLInputElement).value).toBe("12/15/2026");
  });
});

describe("4 — a Save action nested beneath shadow boundaries", () => {
  it("resolves and activates Save through a component boundary", async () => {
    const root = mount(`<record-footer></record-footer>`);
    const footer = shadow(root.querySelector("record-footer")!, `<button name="SaveEdit">Save</button>`);
    let saved = false;
    footer.querySelector("button")!.addEventListener("click", () => (saved = true));

    const outcome = await invokeSemanticAction(root, { role: "button", label: "Save" }, salesforceAdapter());
    expect(outcome.ok).toBe(true);
    expect(saved).toBe(true);
  });
});

describe("5 — read-back through shadow boundaries", () => {
  it("reads a nested native input's value back", () => {
    const root = mount(`<lightning-input name="CloseDate" aria-label="*Close Date"></lightning-input>`);
    const host = root.querySelector("lightning-input")!;
    const outer = shadow(host, `<lightning-primitive-input-date></lightning-primitive-input-date>`);
    const inner = shadow(outer.querySelector("lightning-primitive-input-date")!, `<input type="date" />`);
    (inner.querySelector("input") as HTMLInputElement).value = "2026-12-15";

    const adapter = createSalesforceResolverAdapter();
    expect(adapter.readFieldValue!(root, CLOSE_DATE, SF)).toBe("2026-12-15");
  });
});

describe("6 — multiple nested shadow boundaries", () => {
  it("reaches a control four boundaries deep", () => {
    const root = mount(`<level-one></level-one>`);
    const one = shadow(root.querySelector("level-one")!, `<level-two></level-two>`);
    const two = shadow(one.querySelector("level-two")!, `<level-three></level-three>`);
    const three = shadow(two.querySelector("level-three")!, `<level-four></level-four>`);
    shadow(
      three.querySelector("level-four")!,
      `<label for="cd">*Close Date</label><mirrored-value-host id="cd" name="CloseDate"></mirrored-value-host>`
    );

    const outcome = resolveSemanticTarget(root, CLOSE_DATE, salesforceAdapter());
    expect(outcome.ok).toBe(true);
  });
});

describe("7 — ambiguity still fails safely", () => {
  it("refuses to guess between two identically-identified hosts in different shadow roots", () => {
    const root = mount(`<form-a></form-a><form-b></form-b>`);
    for (const tag of ["form-a", "form-b"]) {
      shadow(
        root.querySelector(tag)!,
        `<label for="cd">*Close Date</label><mirrored-value-host id="cd" name="CloseDate"></mirrored-value-host>`
      );
    }

    const outcome = resolveSemanticTarget(root, CLOSE_DATE, salesforceAdapter());
    expect(outcome.ok).toBe(false);
  });

  it("never writes into an unrelated single field that does not match the target", () => {
    // "Only one field on the page" is not evidence that it is the target.
    const root = mount(`<label for="other">Amount</label><input id="other" name="Amount" />`);
    expect(root).toBeDefined();
    const outcome = resolveSemanticTarget(document, CLOSE_DATE, salesforceAdapter());
    expect(outcome.ok).toBe(false);
  });
});

describe("8 — identity: application identifier plus accessible name", () => {
  it("disambiguates by application identifier when labels collide", () => {
    const root = mount(`<record-form></record-form>`);
    shadow(
      root.querySelector("record-form")!,
      `<label for="a">*Close Date</label><mirrored-value-host id="a" name="OtherDate"></mirrored-value-host>
       <label for="b">*Close Date</label><mirrored-value-host id="b" name="CloseDate"></mirrored-value-host>`
    );

    const outcome = resolveSemanticTarget(root, CLOSE_DATE, salesforceAdapter());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.target.element.getAttribute("id")).toBe("b");
  });

  it("still resolves when only the application identifier matches and the label drifted", () => {
    const root = mount(`<record-form></record-form>`);
    shadow(
      root.querySelector("record-form")!,
      `<label for="cd">Fecha de cierre</label><mirrored-value-host id="cd" name="CloseDate"></mirrored-value-host>`
    );

    const outcome = resolveSemanticTarget(root, CLOSE_DATE, salesforceAdapter());
    expect(outcome.ok).toBe(true);
  });
});

describe("9 — generic non-Salesforce pages are unaffected", () => {
  it("resolves an ordinary flat page with the default policy", () => {
    mount(`<label for="cd">Close Date</label><input id="cd" name="CloseDate" />`);
    const outcome = resolveSemanticTarget(document, {
      role: "field",
      label: "Close Date",
      applicationIdentifier: "CloseDate"
    });
    expect(outcome.ok).toBe(true);
  });

  it("keeps the generic default for a platform that declares no resolution policy", () => {
    expect(resolutionPolicyForPlatform("prospect-intelligence")).toEqual(DEFAULT_RESOLUTION_POLICY);
    expect(resolverAdapterForPlatform("prospect-intelligence")).toBeUndefined();
  });
});

describe("Salesforce declares composed-tree resolution through Platform Intelligence", () => {
  it("compiles the pack's declared policy rather than hardcoding it in the engine", () => {
    expect(SF).toEqual({
      traversal: "composed-tree",
      shadowRoots: "recursive",
      eventRetargeting: true,
      identityPriority: ["applicationIdentifier", "accessibleName", "section"]
    });
  });
});

describe("end-to-end through nested components", () => {
  it("opens edit, resolves, writes and commits entirely across shadow boundaries", async () => {
    // Every element this execution touches is inside a component: nothing
    // it needs is reachable by flat traversal.
    document.body.innerHTML = `<record-page></record-page>`;
    const page = shadow(document.querySelector("record-page")!, `<lightning-button></lightning-button>`);
    const editShell = shadow(page.querySelector("lightning-button")!, `<button>Edit</button>`);

    editShell.querySelector("button")!.addEventListener("click", () => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.id = "edit-dialog";
      document.body.appendChild(dialog);
      const form = shadow(
        dialog.appendChild(document.createElement("record-edit-form")),
        `<label for="cd">*Close Date</label>
         <mirrored-value-host id="cd" name="CloseDate"></mirrored-value-host>
         <button name="SaveEdit">Save</button>`
      );
      form.querySelector("button")!.addEventListener("click", () => {
        dialog.removeAttribute("role");
        dialog.removeAttribute("aria-modal");
      });
    });

    const binding: BrowserExecutionBinding = {
      id: "browser-update_opportunity_close_date-salesforce-lightning",
      capabilityId: "update_opportunity_close_date",
      sourceApplication: SALESFORCE,
      platform: "salesforce-lightning",
      context: { recordType: "Opportunity", pageMode: "edit-or-record" },
      inputs: [{ semanticInput: "close_date", semanticTarget: CLOSE_DATE, valueKind: "date" }],
      commit: { semanticAction: { role: "button", label: "Save" } },
      verification: ["edit-state-closed", "returned-to-record-view", "no-validation-error-visible"],
      safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
      evidence: []
    };

    const result = await executeConfirmed({
      root: document,
      binding,
      inputs: { close_date: "2026-12-15" },
      adapter: salesforceAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.status).toBe("succeeded");
    expect(result.evidence).toContain("Entered the record's edit view before resolving targets.");
  });
});
