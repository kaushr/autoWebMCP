// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { executeConfirmed } from "../src/binding/browserExecution/execute";
import { resolverAdapterForPlatform } from "../src/binding/browserExecution/adapters";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";

/* ------------------------------------------------------------------ *
 * Before, requested, after write, after save — four facts, never one.
 *
 * A live run showed the record holding 4/1/2027 while the test asked for
 * 11/01/2026, and nothing in the result said which of those the executor
 * had seen, written, or read back. A write that reports success is also
 * not the same as a field that holds the value: the date strategies wrote
 * and returned, proving nothing.
 * ------------------------------------------------------------------ */

const SALESFORCE = sourceApplicationFor("salesforce-lightning", "example.lightning.force.com");
const adapter = () => resolverAdapterForPlatform("salesforce-lightning");

function mountRecord(opts: { dateAcceptsWrites?: boolean } = {}): { root: HTMLElement; saves: number; editing(): boolean } {
  const state = { saves: 0, editing: false };
  document.body.innerHTML = `<div id="page"></div>`;
  const page = document.querySelector<HTMLElement>("#page")!;

  const renderView = (): void => {
    page.innerHTML = `<div><h1>PS Project Test</h1><button id="edit">Edit</button></div>`;
    page.querySelector<HTMLButtonElement>("#edit")!.addEventListener("click", () => {
      state.editing = true;
      renderEdit();
    });
  };
  const renderEdit = (): void => {
    page.innerHTML = `
      <records-record-edit>
        <label for="cd">*Close Date</label>
        <input id="cd" name="CloseDate" type="date" value="2027-04-01" />
        <input aria-label="Amount" /><input aria-label="Opportunity Name" />
        <button id="save">Save</button><button id="cancel">Cancel</button>
      </records-record-edit>`;
    page.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", () => {
      state.saves++;
    });
    page.querySelector<HTMLButtonElement>("#cancel")!.addEventListener("click", () => {
      state.editing = false;
      renderView();
    });
    if (opts.dateAcceptsWrites === false) {
      // A control that refuses the write and snaps back, which is what an
      // unaccepted value looks like from outside.
      const input = page.querySelector<HTMLInputElement>("#cd")!;
      input.addEventListener("change", () => {
        input.value = "2027-04-01";
      });
    }
  };
  renderView();
  return {
    root: document.body,
    get saves() {
      return state.saves;
    },
    editing: () => state.editing
  };
}

const binding: BrowserExecutionBinding = {
  id: "b",
  capabilityId: "update_opportunity",
  sourceApplication: SALESFORCE,
  platform: "salesforce-lightning",
  context: { recordType: "Opportunity", pageMode: "edit-or-record" },
  inputs: [
    {
      semanticInput: "close_date",
      semanticTarget: { role: "field", label: "*Close Date", applicationIdentifier: "CloseDate" },
      valueKind: "date",
      applicationField: { objectApiName: "Opportunity", apiName: "CloseDate", type: "date", knowledge: "standard" }
    }
  ],
  commit: { semanticAction: { role: "button", label: "Save" } },
  verification: ["no-validation-error-visible"],
  safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
  evidence: []
};

const run = (page: { root: HTMLElement }) =>
  executeConfirmed({
    root: page.root,
    binding,
    inputs: { close_date: "2026-11-01" },
    adapter: adapter(),
    confirmed: true,
    reaction: { quietMs: 10, timeoutMs: 200 },
    resolveRetryMs: 300
  });

describe("the four facts are tracked separately", () => {
  it("records what the record held, what was asked for, and what it held afterwards", async () => {
    const page = mountRecord();
    const result = await run(page);
    const transaction = result.transactions?.[0];

    expect(transaction).toMatchObject({
      name: "close_date",
      apiName: "CloseDate",
      beforeValue: "2027-04-01",
      requestedValue: "2026-11-01",
      afterWriteValue: "2026-11-01",
      verified: "yes"
    });
    // The requested value is an invocation argument, never an observation
    // of the record — the two are visibly different here.
    expect(transaction?.beforeValue).not.toBe(transaction?.requestedValue);
  });
});

describe("a write that is not accepted fails closed", () => {
  const build = () => mountRecord({ dateAcceptsWrites: false });

  it("reports the input as unverified rather than trusting the setter", async () => {
    const page = build();
    const result = await run(page);
    expect(result.status).toBe("blocked");
    expect(result.transactions?.[0]).toMatchObject({
      requestedValue: "2026-11-01",
      afterWriteValue: "2027-04-01",
      verified: "no"
    });
  });

  it("never invokes Save, and says exactly why it did not", async () => {
    const page = build();
    const result = await run(page);
    expect(page.saves).toBe(0);
    expect(result.warnings.join(" ")).toMatch(
      /Save was not attempted because close_date could not be changed to "2026-11-01"/
    );
  });

  it("discards the edit session it opened rather than leaving changes on screen", async () => {
    const page = build();
    const result = await run(page);
    expect(page.editing()).toBe(false);
    expect(result.evidence.join(" ")).toMatch(/Discarding the unsaved changes/i);
  });
});

describe("an edit session the user already had open is not ours to discard", () => {
  it("leaves it open when AutoWebMCP did not enter edit mode", async () => {
    const page = mountRecord({ dateAcceptsWrites: false });
    // Put the record into edit mode first, as the user would have.
    page.root.querySelector<HTMLButtonElement>("#edit")!.click();

    const result = await run(page);
    expect(result.status).toBe("blocked");
    expect(page.editing()).toBe(true);
    expect(result.evidence.join(" ")).toMatch(/already being edited before this run/i);
    expect(page.saves).toBe(0);
  });
});
