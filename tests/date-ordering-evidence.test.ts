// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { executeConfirmed } from "../src/binding/browserExecution/execute";
import { observedDateValues } from "../src/binding/browserExecution/engine";
import { resolverAdapterForPlatform } from "../src/binding/browserExecution/adapters";
import { DEFAULT_RESOLUTION_POLICY } from "../src/binding/browserExecution/resolutionPolicy";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";

/* ------------------------------------------------------------------ *
 * Establishing an org's date ordering from the whole surface.
 *
 * A live Salesforce run produced the defect these cover. Close Date held
 * "6/1/2027" — which pins nothing, since either component could be the
 * month — so the ordering stayed unknown, an ambiguous requested date was
 * (correctly) refused rather than typed, and the date picker that was
 * supposed to catch it did not exist on that field. The net effect: every
 * date with a day of 12 or lower was unwritable.
 *
 * The same form was carrying other dates that would have settled the
 * question outright. How an org writes dates is a property of the ORG, so
 * the evidence for it is the page, not the one field a capability happens
 * to touch.
 * ------------------------------------------------------------------ */

const adapter = () => resolverAdapterForPlatform("salesforce-lightning");
const SALESFORCE = sourceApplicationFor("salesforce-lightning", "nvent-dev-ed.lightning.force.com");

const BINDING: BrowserExecutionBinding = {
  id: "browser-update_opportunity-salesforce-lightning",
  capabilityId: "update_opportunity",
  sourceApplication: SALESFORCE,
  platform: "salesforce-lightning",
  context: { recordType: "Opportunity", pageMode: "edit-or-record" },
  inputs: [
    {
      semanticInput: "close_date",
      semanticTarget: { role: "field", label: "Close Date", applicationIdentifier: "CloseDate" },
      valueKind: "date",
      required: true
    }
  ],
  commit: { semanticAction: { role: "button", label: "Save" } },
  verification: ["edit-state-closed", "returned-to-record-view", "field-value-observable", "no-validation-error-visible"],
  safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
  evidence: []
};

/**
 * The live shape, faithfully: Close Date is a plain text input with no
 * native date input, no mirrored value property, and NO date-picker
 * trigger anywhere near it. `otherDates` are the other values the form
 * happens to be rendering.
 */
function mountEditForm(closeDate: string, otherDates: Record<string, string> = {}): HTMLElement {
  const extra = Object.entries(otherDates)
    .map(([name, value]) => `<label for="${name}">${name}</label><input id="${name}" name="${name}" value="${value}" />`)
    .join("");
  document.body.innerHTML = `
    <div role="dialog" aria-modal="true" id="edit-dialog">
      <label for="cd">Close Date</label>
      <input id="cd" name="CloseDate" type="text" value="${closeDate}" />
      <label for="am">Amount</label>
      <input id="am" name="Amount" value="50000" />
      ${extra}
      <button id="save">Save</button>
      <button>Cancel</button>
    </div>
  `;
  const save = document.querySelector("#save") as HTMLButtonElement;
  save.addEventListener("click", () => {
    const dialog = document.querySelector("#edit-dialog")!;
    dialog.removeAttribute("role");
    dialog.removeAttribute("aria-modal");
    for (const control of dialog.querySelectorAll("button")) (control as HTMLElement).hidden = true;
  });
  return document.body;
}

const run = (root: HTMLElement, value: string) =>
  executeConfirmed({
    root,
    binding: BINDING,
    inputs: { close_date: value },
    adapter: adapter(),
    confirmed: true,
    reaction: { timeoutMs: 40, quietMs: 10 },
    resolveRetryMs: 50
  });

describe("observedDateValues", () => {
  it("collects form-control values so the whole surface can settle the ordering", () => {
    const root = mountEditForm("6/1/2027", { LastModified: "12/25/2026" });
    const values = observedDateValues(root, DEFAULT_RESOLUTION_POLICY);
    expect(values).toContain("6/1/2027");
    expect(values).toContain("12/25/2026");
    // Non-dates come along harmlessly; only date-shaped values are read as
    // evidence, and the inference ignores the rest.
    expect(values).toContain("50000");
  });

  it("never reads a password or hidden control", () => {
    document.body.innerHTML = `
      <input type="password" value="12/25/2026" />
      <input type="hidden" value="25/12/2026" />
      <input type="text" value="3/4/2027" />
    `;
    expect(observedDateValues(document.body, DEFAULT_RESOLUTION_POLICY)).toEqual(["3/4/2027"]);
  });
});

describe("the org's ordering is established from the whole form", () => {
  it("writes an ambiguous date once another field on the page pins the ordering", async () => {
    // The live case, with the one thing that was missing: a second date
    // whose day is above 12. 3/1/2027 was previously unwritable here.
    const root = mountEditForm("6/1/2027", { LastModified: "12/25/2026" });
    const result = await run(root, "2027-03-01");

    expect(result.status).toBe("succeeded");
    expect(result.evidence.join(" ")).toMatch(/date ordering for this org established as month-first/i);
    expect((document.querySelector("#cd") as HTMLInputElement).value).toBe("3/1/2027");
  });

  it("writes the same date the other way round for a day-first org", async () => {
    const root = mountEditForm("6/1/2027", { LastModified: "25/12/2026" });
    const result = await run(root, "2027-03-01");

    expect(result.status).toBe("succeeded");
    expect(result.evidence.join(" ")).toMatch(/established as day-first/i);
    expect((document.querySelector("#cd") as HTMLInputElement).value).toBe("1/3/2027");
  });

  it("still refuses when nothing on the page pins the ordering", async () => {
    // Every date ambiguous — exactly the live form. The refusal stands:
    // widening the evidence must not become a licence to guess.
    const root = mountEditForm("6/1/2027", { LastModified: "1/2/2026" });
    const result = await run(root, "2027-03-01");

    expect(result.status).toBe("blocked");
    expect(result.evidence.join(" ")).toMatch(/could not be established \(no-evidence\)/i);
    expect((document.querySelector("#cd") as HTMLInputElement).value).toBe("6/1/2027");
  });

  it("refuses when the page contradicts itself rather than taking a majority", async () => {
    const root = mountEditForm("6/1/2027", { A: "12/25/2026", B: "25/12/2026" });
    const result = await run(root, "2027-03-01");

    expect(result.status).toBe("blocked");
    expect(result.evidence.join(" ")).toMatch(/could not be established \(conflicting\)/i);
  });

  it("writes an unambiguous date with no ordering evidence at all, as before", async () => {
    // Unchanged behaviour: day 25 cannot be a month, so the value settles
    // itself and no page evidence is needed.
    const root = mountEditForm("6/1/2027");
    const result = await run(root, "2027-03-25");

    expect(result.status).toBe("succeeded");
    expect((document.querySelector("#cd") as HTMLInputElement).value).toBe("3/25/2027");
  });
});

/* ------------------------------------------------------------------ *
 * The date-picker trigger, from the shape a live org actually reports.
 *
 * A DOM probe of a real Opportunity edit form settled what had been
 * guesswork: the trigger sits in the input's immediate parent, carries NO
 * `aria-label`, and its `title` is "Select a date for Close Date". The
 * selector looked for the words "date picker", which Salesforce never
 * says, so every ambiguous date fell through to a failure that read as if
 * no trigger existed.
 *
 * The same probe showed why widening the search would be a bug: the form
 * carries a picker for every date field it renders.
 * ------------------------------------------------------------------ */

/** The live shape: no native date input, no mirrored value, picker only. */
function mountPickerForm(): HTMLElement {
  document.body.innerHTML = `
    <div role="dialog" aria-modal="true" id="edit-dialog">
      <records-record-layout-section>
        <div class="slds-form-element" id="close-date-field">
          <label for="cd">Close Date</label>
          <div class="slds-form-element__control">
            <span id="cd" role="textbox" aria-label="Close Date"></span>
            <button title="Select a date for Close Date" class="slds-button_icon" id="cd-trigger"></button>
          </div>
        </div>
        <div class="slds-form-element" id="start-date-field">
          <label for="sd">Project Start Date</label>
          <div class="slds-form-element__control">
            <span id="sd" role="textbox" aria-label="Project Start Date"></span>
            <button title="Select a date for Project Start Date" id="sd-trigger"></button>
          </div>
        </div>
      </records-record-layout-section>
      <input aria-label="Amount" value="50000" />
      <button id="save">Save</button><button>Cancel</button>
    </div>
  `;
  const surface = document.createElement("div");
  surface.setAttribute("role", "grid");
  surface.hidden = true;
  surface.innerHTML = `<h2 role="heading">March 2027</h2>
    <div role="gridcell" aria-label="Monday, March 1, 2027" id="day-1"></div>`;
  document.body.appendChild(surface);

  for (const id of ["cd-trigger", "sd-trigger"]) {
    document.querySelector(`#${id}`)!.addEventListener("click", () => {
      surface.hidden = false;
      surface.setAttribute("data-opened-by", id);
    });
  }
  return document.body;
}

describe("the date-picker trigger is found by what the platform actually calls it", () => {
  it("resolves a trigger titled \"Select a date for Close Date\"", async () => {
    const root = mountPickerForm();
    const { resolveSemanticTarget } = await import("../src/binding/browserExecution/engine");
    const resolved = resolveSemanticTarget(root, { role: "field", label: "Close Date" }, adapter());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const { setFieldValue } = await import("../src/binding/browserExecution/engine");
    await setFieldValue(resolved.target, "2027-03-01", "date", adapter());

    // It opened THIS field's calendar, not the one next to it.
    const surface = document.querySelector('[role="grid"]')!;
    expect(surface.getAttribute("data-opened-by")).toBe("cd-trigger");
  });

  it("never reaches a neighbouring field's picker", async () => {
    const root = mountPickerForm();
    const { resolveSemanticTarget, setFieldValue } = await import("../src/binding/browserExecution/engine");
    const resolved = resolveSemanticTarget(root, { role: "field", label: "Project Start Date" }, adapter());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    await setFieldValue(resolved.target, "2027-03-01", "date", adapter());
    expect(document.querySelector('[role="grid"]')!.getAttribute("data-opened-by")).toBe("sd-trigger");
  });
});
