// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { executeConfirmed } from "../src/binding/browserExecution/execute";
import { resolverAdapterForPlatform } from "../src/binding/browserExecution/adapters";

/**
 * The production composition root, not a hand-built adapter: this is what
 * attaches the Salesforce resolution policy compiled from Platform
 * Intelligence, so these tests exercise the same wiring the extension does.
 */
const salesforceAdapter = () => resolverAdapterForPlatform("salesforce-lightning");
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
      <label for="am">Amount</label>
      <input id="am" name="Amount" />
      <button id="save">Save</button>
      <button>Cancel</button>
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
    // does not simply delete the field from the page. Stripping only the
    // dialog's ARIA markers previously simulated that (candidate discovery
    // depended entirely on the boundary marker being present), but generic
    // surface observation now finds a record-edit surface structurally,
    // from its editable fields and a nearby Save action, independent of
    // any dialog role — so a faithful "closed" simulation must actually
    // stop offering those controls, the way a real Lightning save does by
    // tearing the edit form down.
    dialog.removeAttribute("role");
    dialog.removeAttribute("aria-modal");
    for (const control of dialog.querySelectorAll("input, mock-lightning-datepicker, button")) {
      (control as HTMLElement).hidden = true;
    }
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
      <label for="am">Amount</label>
      <input id="am" name="Amount" />
      <button id="save">Save</button>
      <button>Cancel</button>
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
    const dialog = document.querySelector("#edit-dialog")!;
    dialog.removeAttribute("aria-modal");
    for (const control of dialog.querySelectorAll('input, button, [role="textbox"]')) {
      (control as HTMLElement).hidden = true;
    }
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
      adapter: salesforceAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.status).toBe("succeeded");
    expect(result.checks.map((check) => `${check.name}:${check.status}`)).toEqual([
      "editable_state:pass",
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
      adapter: salesforceAdapter(),
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
      adapter: salesforceAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.status).toBe("failed");
    expect(result.checks.find((check) => check.name === "validation_clear")?.status).toBe("fail");
  });

  it("blocks before writing anything when a target cannot be resolved on a genuine edit surface", async () => {
    // A real record-edit surface that simply lacks the target field: the
    // edit state is proven, and blocking is then honestly attributed to
    // target resolution rather than page state.
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <label for="a">Stage</label><input id="a" name="StageName" />
        <label for="b">Amount</label><input id="b" name="Amount" />
        <button>Save</button>
      </div>
    `;
    const result = await executeConfirmed({
      root: document,
      binding: BINDING,
      inputs: { close_date: "2026-12-15" },
      adapter: salesforceAdapter(),
      confirmed: true,
      resolveRetryMs: 50
    });

    expect(result.status).toBe("blocked");
    expect(result.checks.map((check) => `${check.name}:${check.status}`)).toEqual([
      "editable_state:pass",
      "target_resolved:fail"
    ]);
  });

  it("case 10: a failed edit transition blocks at the state layer — no field mutation, no resolution retries", async () => {
    // Plain record view whose Edit control opens nothing (the live shape:
    // wrong page state). Execution must stop at editable_state, never touch
    // the input elsewhere on the page, and never enter the retry loop.
    document.body.innerHTML = `
      <button>Edit</button>
      <label for="cd">Close Date</label><input id="cd" name="CloseDate" value="untouched" />
    `;
    const result = await executeConfirmed({
      root: document,
      binding: BINDING,
      inputs: { close_date: "2026-12-15" },
      adapter: salesforceAdapter(),
      confirmed: true,
      resolveRetryMs: 50
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual([
      { name: "editable_state", status: "fail", detail: expect.stringContaining("record edit state") }
    ]);
    expect((document.querySelector("#cd") as HTMLInputElement).value).toBe("untouched");
    expect(result.evidence.join("\n")).toMatch(/Resulting Salesforce page state/);
  }, 15000);

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

/**
 * A live-DOM stand-in for the actual gap the live Salesforce test surfaced:
 * the page starts in plain record view — no edit surface, no Close Date
 * field to resolve at all — with only an accessible "Edit" control. This is
 * where a real WebMCP invocation actually starts; a human is not there to
 * click Edit first.
 */
function mountRecordViewWithEditButton(): HTMLElement {
  document.body.innerHTML = `<button>Edit</button>`;
  document.querySelector("button")!.addEventListener("click", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true" id="edit-dialog">
        <label for="cd">Close Date</label>
        <mock-lightning-datepicker id="cd" name="CloseDate"></mock-lightning-datepicker>
        <label for="am">Amount</label>
        <input id="am" name="Amount" />
        <button id="save">Save</button>
        <button>Cancel</button>
      </div>
    `;
    document.querySelector("#save")!.addEventListener("click", () => {
      const dialog = document.querySelector("#edit-dialog")!;
      dialog.removeAttribute("role");
      dialog.removeAttribute("aria-modal");
      for (const control of dialog.querySelectorAll("input, mock-lightning-datepicker, button")) {
        (control as HTMLElement).hidden = true;
      }
    });
  });
  return document.body;
}

describe("executeConfirmed — entering edit mode automatically", () => {
  it("opens the edit surface itself, starting from plain record view, with no manual Edit click", async () => {
    mountRecordViewWithEditButton();
    const result = await executeConfirmed({
      root: document,
      binding: BINDING,
      inputs: { close_date: "2026-12-15" },
      adapter: salesforceAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.status).toBe("succeeded");
    expect(result.checks.map((check) => `${check.name}:${check.status}`)).toContain("editable_state:pass");
    expect(result.evidence.join("\n")).toMatch(/Resulting Salesforce page state: record-edit/);
  });

  it("does not attempt to click Edit when the binding's pageMode does not call for it", async () => {
    document.body.innerHTML = `<button>Edit</button>`; // present, but never clicked
    const recordViewBinding: BrowserExecutionBinding = {
      ...BINDING,
      context: { ...BINDING.context, pageMode: "record-view" }
    };
    const result = await executeConfirmed({
      root: document,
      binding: recordViewBinding,
      inputs: { close_date: "2026-12-15" },
      adapter: salesforceAdapter(),
      confirmed: true,
      resolveRetryMs: 50
    });

    // No edit surface was ever opened, so the field genuinely cannot be found.
    expect(result.status).toBe("blocked");
    expect(result.evidence.join(" ")).not.toMatch(/entered the record's edit view/i);
  });
});


describe("post-save verification against the record view", () => {
  it("reaches full succeeded when the save closes the edit surface, shows a success toast, and the record view displays the new value", async () => {
    // The live run, as it should have been scored: ground truth was a
    // successful save misreported as failed by the platform's own toast.
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true" id="edit-dialog">
        <label for="cd">Close Date</label>
        <mock-lightning-datepicker id="cd" name="CloseDate"></mock-lightning-datepicker>
        <label for="am">Amount</label>
        <input id="am" name="Amount" />
        <button id="save">Save</button>
        <button>Cancel</button>
      </div>
    `;
    document.querySelector("#save")!.addEventListener("click", () => {
      document.querySelector("#edit-dialog")!.remove();
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div class="slds-notify_container"><div role="alert" class="slds-notify toast">Saved.</div></div>
         <button>Edit</button>
         <div class="slds-form-element"><span>Close Date</span><div class="field-value">12/15/2026</div></div>`
      );
    });

    const result = await executeConfirmed({
      root: document,
      binding: BINDING,
      inputs: { close_date: "2026-12-15" },
      adapter: salesforceAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.checks.find((check) => check.name === "validation_clear")?.status).toBe("pass");
    expect(result.checks.find((check) => check.name === "value_verified")?.status).toBe("pass");
    expect(result.status).toBe("succeeded");
  });

  it("stays failed when the save is genuinely rejected: the edit surface remains open with the error inside it", async () => {
    mountEditForm({ rejectSave: true });
    const result = await executeConfirmed({
      root: document,
      binding: BINDING,
      inputs: { close_date: "2026-12-15" },
      adapter: salesforceAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.status).toBe("failed");
    expect(result.checks.find((check) => check.name === "validation_clear")?.status).toBe("fail");
    expect(result.checks.find((check) => check.name === "returned_to_record")?.status).toBe("fail");
  });
});

describe("an optional input nobody supplied is not part of the invocation", () => {
  const OPTIONAL_BINDING: BrowserExecutionBinding = {
    ...BINDING,
    inputs: [
      { ...BINDING.inputs[0], required: true },
      {
        semanticInput: "next_step",
        semanticTarget: { role: "field", label: "Next Step" },
        valueKind: "text",
        required: false
      }
    ]
  };

  it("saves without it, rather than blocking on a field the caller deliberately left alone", async () => {
    // The optional field is not even present on this form. Resolving it
    // would fail and block the whole run — which is what happened live:
    // Run test refused to save because a field nobody asked to change had
    // no value.
    mountEditForm();
    const result = await executeConfirmed({
      root: document,
      binding: OPTIONAL_BINDING,
      inputs: { close_date: "2026-12-15" },
      adapter: salesforceAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.status).toBe("succeeded");
    expect(result.evidence.join("\n")).toMatch(/Not part of this invocation.*next_step.*optional/);
    expect(result.transactions?.map((t) => t.name)).toEqual(["close_date"]);
  });

  it("still refuses when a REQUIRED input has no value, and says which one", async () => {
    mountEditForm();
    const result = await executeConfirmed({
      root: document,
      binding: OPTIONAL_BINDING,
      inputs: {},
      adapter: salesforceAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });

    expect(result.status).not.toBe("succeeded");
    expect(result.warnings.join(" ")).toMatch(/required input "close_date"/);
  });

  it("treats a binding with no required flag as required, so an older stored binding cannot start saving partial records", async () => {
    mountEditForm();
    const legacy: BrowserExecutionBinding = {
      ...BINDING,
      inputs: [{ ...BINDING.inputs[0] }] // no `required` field at all
    };
    const result = await executeConfirmed({
      root: document,
      binding: legacy,
      inputs: {},
      adapter: salesforceAdapter(),
      confirmed: true,
      reaction: { quietMs: 20, timeoutMs: 500 }
    });
    expect(result.status).not.toBe("succeeded");
  });
});
