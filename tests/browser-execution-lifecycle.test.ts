// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { executeConfirmed } from "../src/binding/browserExecution/execute";
import { createSalesforceResolverAdapter } from "../src/binding/browserExecution/salesforceAdapter";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";
import { sourceApplicationFor } from "../src/training/sourceApplication";

const SALESFORCE = sourceApplicationFor("salesforce-lightning", "nvent-dev-ed.lightning.force.com");

const BINDING: BrowserExecutionBinding = {
  id: "browser-update_opportunity_close_date-salesforce-lightning",
  capabilityId: "update_opportunity_close_date",
  sourceApplication: SALESFORCE,
  platform: "salesforce-lightning",
  context: { recordType: "Opportunity", pageMode: "edit-or-record" },
  inputs: [
    {
      semanticInput: "close_date",
      semanticTarget: { role: "field", label: "Close Date", applicationIdentifier: "CloseDate" },
      valueKind: "date"
    }
  ],
  commit: { semanticAction: { role: "button", label: "Save" } },
  verification: ["edit-state-closed", "returned-to-record-view", "field-value-observable", "no-validation-error-visible"],
  safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
  evidence: []
};

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

/**
 * A minimal live-DOM stand-in for a Salesforce Opportunity edit form: an
 * edit-mode dialog containing the labelled field and Save button, wired so
 * that clicking Save closes the dialog (removes the modal markers) while the
 * field itself continues to reflect its value in the record view — the
 * "still open" / "validation shown" failure paths are simulated by simply
 * not doing that.
 */
function mountEditForm(options: { rejectSave?: boolean } = {}): HTMLElement {
  document.body.innerHTML = `
    <div role="dialog" aria-modal="true" id="edit-dialog">
      <label for="cd">Close Date</label>
      <mock-lightning-datepicker id="cd" name="CloseDate"></mock-lightning-datepicker>
      <button id="save">Save</button>
    </div>
  `;
  const save = document.querySelector("#save") as HTMLButtonElement;
  save.addEventListener("click", () => {
    const dialog = document.querySelector("#edit-dialog")!;
    if (options.rejectSave) {
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      alert.textContent = "Close Date is required.";
      dialog.appendChild(alert);
      return;
    }
    // A real successful Lightning save closes the edit surface and returns
    // to a record view that still shows the field's persisted value — it
    // does not simply delete the field from the page.
    dialog.removeAttribute("role");
    dialog.removeAttribute("aria-modal");
  });
  return document.body;
}

/**
 * A field host with neither a mirrored `value` property nor a reachable
 * native input in its shadow root — forcing every write through the
 * date-picker's own accessible UI, and leaving no path to read the
 * committed value back afterward. This is the real hard case: Lightning's
 * shadow encapsulation genuinely can make read-back unavailable even when
 * the write itself is proven to have worked.
 */
function mountPickerOnlyEditForm(): HTMLElement {
  document.body.innerHTML = `
    <div aria-modal="true" id="edit-dialog">
      <label for="cd">Close Date</label>
      <span id="cd" role="textbox" aria-label="Close Date">
        <button aria-label="Date picker" id="picker-trigger"></button>
      </span>
      <button id="save">Save</button>
    </div>
    <div role="dialog" id="calendar">
      <h2 id="month-heading">December 2026</h2>
      <table><tbody id="days">
        <tr><td><button aria-label="Tuesday, December 15, 2026">15</button></td></tr>
      </tbody></table>
    </div>
  `;
  // A real calendar popover closes itself once a day is picked.
  document.querySelector('[aria-label="Tuesday, December 15, 2026"]')!.addEventListener("click", () => {
    document.querySelector("#calendar")!.remove();
  });
  document.querySelector("#save")!.addEventListener("click", () => {
    document.querySelector("#edit-dialog")!.removeAttribute("aria-modal");
  });
  return document.body;
}

describe("executeConfirmed — write confirmation gate", () => {
  it("refuses to run without an explicit confirmed: true", async () => {
    mountEditForm();
    await expect(
      executeConfirmed({
        root: document,
        binding: BINDING,
        inputs: { close_date: "2026-12-15" },
        // @ts-expect-error deliberately testing the runtime guard, not the type
        confirmed: false
      })
    ).rejects.toThrow(/explicit confirmed: true/i);
  });
});

describe("executeConfirmed — full lifecycle", () => {
  it("succeeds when every check, including value read-back, passes", async () => {
    mountEditForm();
    const result = await executeConfirmed({
      root: document,
      binding: BINDING,
      inputs: { close_date: "2026-12-15" },
      adapter: createSalesforceResolverAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.status).toBe("succeeded");
    expect(result.checks.map((check) => `${check.name}:${check.status}`)).toEqual([
      "target_resolved:pass",
      "value_set:pass",
      "commit_invoked:pass",
      "validation_clear:pass",
      "returned_to_record:pass",
      "value_verified:pass"
    ]);
    const cd = document.querySelector("mock-lightning-datepicker") as MockLightningDatepicker;
    expect(cd.value).toBe("2026-12-15");
  });

  it("reports partially_verified, never succeeded, when the write goes through the date-picker UI and no read-back path exists", async () => {
    mountPickerOnlyEditForm();
    const result = await executeConfirmed({
      root: document,
      binding: BINDING,
      inputs: { close_date: "2026-12-15" },
      adapter: createSalesforceResolverAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.status).toBe("partially_verified");
    expect(result.checks.find((check) => check.name === "value_set")?.status).toBe("pass");
    expect(result.checks.find((check) => check.name === "value_verified")?.status).toBe("skipped");
  });

  it("reports failed when a validation error is visible after commit", async () => {
    mountEditForm({ rejectSave: true });
    const result = await executeConfirmed({
      root: document,
      binding: BINDING,
      inputs: { close_date: "2026-12-15" },
      adapter: createSalesforceResolverAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.status).toBe("failed");
    expect(result.checks.find((check) => check.name === "validation_clear")?.status).toBe("fail");
  });

  it("blocks before writing anything when a target cannot be resolved", async () => {
    document.body.innerHTML = `<div>nothing relevant here</div>`;
    const result = await executeConfirmed({
      root: document,
      binding: BINDING,
      inputs: { close_date: "2026-12-15" },
      adapter: createSalesforceResolverAdapter(),
      confirmed: true
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual([
      { name: "target_resolved", status: "fail", detail: expect.stringContaining("close_date") }
    ]);
  });

  it("blocks when a value cannot be set, without invoking the commit action", async () => {
    document.body.innerHTML = `
      <label for="cd">Close Date</label>
      <select id="cd" name="CloseDate"><option value="a">A</option></select>
      <button id="save">Save</button>
    `;
    const saveClicked = { called: false };
    document.querySelector("#save")!.addEventListener("click", () => (saveClicked.called = true));

    const selectBinding: BrowserExecutionBinding = {
      ...BINDING,
      inputs: [{ ...BINDING.inputs[0], valueKind: "select" }]
    };

    const result = await executeConfirmed({
      root: document,
      binding: selectBinding,
      inputs: { close_date: "not-a-real-option" },
      confirmed: true
    });

    expect(result.status).toBe("blocked");
    expect(saveClicked.called).toBe(false);
  });
});
