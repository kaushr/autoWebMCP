// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  inspectValueDomains,
  readOnlyIntrospector,
  type DomainInspection
} from "../src/binding/browserExecution/execute";
import { resolverAdapterForPlatform } from "../src/binding/browserExecution/adapters";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";

/* ------------------------------------------------------------------ *
 * Read-only acquisition restores what it disturbs.
 *
 * Reading a picklist's live choices is not pure observation: it may open a
 * record for editing and it does open a popup. Those are real changes to
 * the user's application even though nothing is saved, so the operation
 * owns them and must put them back.
 *
 * Ownership — not the final state — decides what gets restored. A record
 * the user was already editing is theirs; ending in edit mode is not a
 * reason to cancel their work.
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";
const SALESFORCE = sourceApplicationFor(PLATFORM, "example.lightning.force.com");
const adapter = () => resolverAdapterForPlatform(PLATFORM);

interface Page {
  root: HTMLElement;
  /** Every mutation the fixture would treat as a business change. */
  saves: number;
  valueMutations: number;
  optionSelections: string[];
  listboxOpen(): boolean;
  editing(): boolean;
  otherFieldValue(): string;
}

/**
 * A Salesforce record page that can be in view or edit mode, with a
 * picklist whose control is a `<button role="combobox">` two shadow
 * boundaries down. Every business-mutating affordance increments a counter
 * so tests can prove none of them fired.
 */
function mountRecord(
  options: string[],
  config: {
    startEditing?: boolean;
    withCancel?: boolean;
    cancelWorks?: boolean;
    dismissWorks?: boolean;
    openWorks?: boolean;
    otherFieldValue?: string;
    throwOnOpen?: boolean;
  } = {}
): Page {
  const {
    startEditing = false,
    withCancel = true,
    cancelWorks = true,
    dismissWorks = true,
    openWorks = true,
    throwOnOpen = false
  } = config;
  const state = { saves: 0, valueMutations: 0, selections: [] as string[], editing: startEditing };

  document.body.innerHTML = `<div id="page"></div>`;
  const page = document.querySelector<HTMLElement>("#page")!;

  const renderView = (): void => {
    page.innerHTML = `<div class="record"><h1>PS Project Test</h1><button id="edit">Edit</button></div>`;
    page.querySelector<HTMLButtonElement>("#edit")!.addEventListener("click", () => {
      state.editing = true;
      renderEdit();
    });
  };

  const renderEdit = (): void => {
    page.innerHTML = `
      <records-record-edit>
        <label for="stage-field">*Stage</label>
        <lightning-combobox id="stage-field"></lightning-combobox>
        <input id="amount" aria-label="Amount" value="${config.otherFieldValue ?? ""}" />
        <input id="name" aria-label="Opportunity Name" />
        <input id="close" type="date" aria-label="Close Date" />
        <button id="save">Save</button>
        ${withCancel ? `<button id="cancel">Cancel</button>` : ""}
      </records-record-edit>`;

    page.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", () => {
      state.saves++;
    });
    page.querySelector<HTMLInputElement>("#amount")!.addEventListener("change", () => {
      state.valueMutations++;
    });
    page.querySelector<HTMLButtonElement>("#cancel")?.addEventListener("click", () => {
      if (!cancelWorks) return;
      state.editing = false;
      renderView();
    });

    const outer = (page.querySelector("lightning-combobox")! as HTMLElement).attachShadow({ mode: "open" });
    outer.innerHTML = `<lightning-base-combobox></lightning-base-combobox>`;
    const inner = (outer.querySelector("lightning-base-combobox")! as HTMLElement).attachShadow({ mode: "open" });
    inner.innerHTML = `<button role="combobox" aria-expanded="false">Select an Option</button><div class="dd"></div>`;

    const trigger = inner.querySelector("button")!;
    const dropdown = inner.querySelector(".dd")!;
    const close = (): void => {
      if (!dismissWorks) return;
      dropdown.innerHTML = "";
      trigger.setAttribute("aria-expanded", "false");
    };
    trigger.addEventListener("click", () => {
      if (throwOnOpen) {
        // A real browser never lets a listener's exception escape back to
        // whatever called `.click()` — it reports the error to the console
        // and event dispatch continues unaffected. jsdom does the same, but
        // reports it as a process-level uncaught exception here instead of a
        // console line, which failed the suite even though every assertion
        // below was passing. Marking it handled matches what a browser
        // actually does, rather than papering over a real gap.
        window.addEventListener("error", (event) => event.preventDefault(), { once: true });
        throw new Error("the component exploded while opening");
      }
      if (trigger.getAttribute("aria-expanded") === "true") return close();
      if (!openWorks) return;
      trigger.setAttribute("aria-expanded", "true");
      dropdown.innerHTML = `<div role="listbox">${options
        .map((option) => `<lightning-base-combobox-item role="option">${option}</lightning-base-combobox-item>`)
        .join("")}</div>`;
      for (const item of dropdown.querySelectorAll('[role="option"]')) {
        item.addEventListener("click", () => {
          // Selecting is a value mutation. Introspection must never do it.
          state.valueMutations++;
          state.selections.push(item.textContent ?? "");
          trigger.textContent = item.textContent ?? "";
          close();
        });
      }
    });
    trigger.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") close();
    });
  };

  if (startEditing) renderEdit();
  else renderView();

  return {
    root: document.body,
    get saves() {
      return state.saves;
    },
    get valueMutations() {
      return state.valueMutations;
    },
    get optionSelections() {
      return state.selections;
    },
    listboxOpen() {
      const combobox = page.querySelector("lightning-combobox");
      const trigger = combobox?.shadowRoot
        ?.querySelector("lightning-base-combobox")
        ?.shadowRoot?.querySelector("button");
      return trigger?.getAttribute("aria-expanded") === "true";
    },
    editing() {
      return state.editing;
    },
    otherFieldValue() {
      return page.querySelector<HTMLInputElement>("#amount")?.value ?? "";
    }
  };
}

const binding: BrowserExecutionBinding = {
  id: "browser-update_opportunity",
  capabilityId: "update_opportunity",
  sourceApplication: SALESFORCE,
  platform: PLATFORM,
  context: { recordType: "Opportunity", pageMode: "edit-or-record" },
  inputs: [
    {
      semanticInput: "stage",
      semanticTarget: { role: "field", label: "*Stage" },
      valueKind: "select",
      applicationField: {
        objectApiName: "Opportunity",
        apiName: "StageName",
        type: "picklist",
        knowledge: "standard",
        domain: "discoverable-live"
      }
    }
  ],
  commit: { semanticAction: { role: "button", label: "Save" } },
  verification: ["no-validation-error-visible"],
  safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
  evidence: []
};

const inspect = (page: Page): Promise<DomainInspection> =>
  inspectValueDomains({
    root: page.root,
    binding,
    adapter: adapter(),
    reaction: { quietMs: 5, timeoutMs: 100 },
    restoreTimeoutMs: 150
  });

/** Asserted after every single path below: introspection changes no business state. */
function expectNoMutation(page: Page): void {
  expect(page.saves).toBe(0);
  expect(page.valueMutations).toBe(0);
  expect(page.optionSelections).toEqual([]);
}

/* ------------------------------ the happy path ------------------------------ */

describe("A — starts in record view, discovery succeeds, prior state restored", () => {
  it("enters edit, reads the choices, closes the control, cancels, and proves view mode", async () => {
    const page = mountRecord(["Prospecting", "Qualification", "Closed Won"]);
    const result = await inspect(page);

    expect(result.options.stage).toEqual(["Prospecting", "Qualification", "Closed Won"]);
    expect(result.initialPageState).toBe("record-view");
    expect(result.finalPageState).toBe("record-view");
    expect(result.ownership).toEqual({ enteredEditMode: true, openedControls: ["stage"] });
    expect(result.restoration).toMatchObject({ control: "proven", page: "proven" });
    expect(page.editing()).toBe(false);
    expect(page.listboxOpen()).toBe(false);
    expectNoMutation(page);
  });

  it("explains itself step by step", async () => {
    const page = mountRecord(["Prospecting", "Closed Won"]);
    const trail = (await inspect(page)).evidence.join("\n");
    expect(trail).toMatch(/Initial page state: record-view/);
    expect(trail).toMatch(/Edit action invoked: yes/);
    expect(trail).toMatch(/currently offers 2 values/);
    expect(trail).toMatch(/Dismiss action resolved: yes/);
    expect(trail).toMatch(/Dismiss action invoked: yes/);
    expect(trail).toMatch(/Final page state: record-view/);
  });
});

/* --------------------------- failure still restores --------------------------- */

describe("B — discovery fails after entering edit; the record is still put back", () => {
  it("reports the failure and still returns to record view", async () => {
    const page = mountRecord([], { openWorks: false });
    const result = await inspect(page);

    expect(result.options).toEqual({});
    expect(result.unresolved.stage).toBeDefined();
    expect(result.restoration.page).toBe("proven");
    expect(result.finalPageState).toBe("record-view");
    expectNoMutation(page);
  });
});

describe("C — a control that cannot be proven closed is reported, and the page still restored", () => {
  it("does not claim a clean state-preserving success", async () => {
    const page = mountRecord(["Prospecting", "Closed Won"], { dismissWorks: false });
    const result = await inspect(page);

    expect(result.options.stage).toEqual(["Prospecting", "Closed Won"]);
    expect(result.restoration.control).toBe("unproven");
    // Page-level restoration is still attempted, because it is safe.
    expect(result.restoration.page).toBe("proven");
    expectNoMutation(page);
  });
});

describe("D — Cancel cannot be resolved", () => {
  it("keeps the discovered options but refuses to call the restoration proven", async () => {
    const page = mountRecord(["Prospecting", "Closed Won"], { withCancel: false });
    const result = await inspect(page);

    expect(result.options.stage).toEqual(["Prospecting", "Closed Won"]);
    expect(result.restoration.page).toBe("failed");
    expect(result.restoration.reason).toMatch(/No dismiss action could be resolved/i);
    expect(result.finalPageState).toBe("record-edit");
    expectNoMutation(page);
  });
});

describe("E — Cancel is invoked but view mode cannot be proven", () => {
  it("marks the restoration unproven and reports the final state", async () => {
    const page = mountRecord(["Prospecting", "Closed Won"], { cancelWorks: false });
    const result = await inspect(page);

    expect(result.options.stage).toEqual(["Prospecting", "Closed Won"]);
    expect(result.restoration.page).toBe("unproven");
    expect(result.restoration.reason).toMatch(/invoked but the record was not observed returning/i);
    expect(result.finalPageState).toBe("record-edit");
    expectNoMutation(page);
  });
});

/* ------------------------- the user's own edit session ------------------------- */

describe("F — starts in record edit: the user's session is not ours to cancel", () => {
  it("does not click Edit, does not click Cancel, and leaves edit mode intact", async () => {
    const page = mountRecord(["Prospecting", "Closed Won"], { startEditing: true });
    const result = await inspect(page);

    expect(result.options.stage).toEqual(["Prospecting", "Closed Won"]);
    expect(result.initialPageState).toBe("record-edit");
    expect(result.finalPageState).toBe("record-edit");
    expect(result.ownership.enteredEditMode).toBe(false);
    expect(result.restoration.page).toBe("not-required");
    expect(result.restoration.reason).toMatch(/already in edit mode/i);
    expect(page.editing()).toBe(true);
    expectNoMutation(page);
  });

  it("still closes the control it opened itself", async () => {
    const page = mountRecord(["Prospecting", "Closed Won"], { startEditing: true });
    const result = await inspect(page);
    expect(result.ownership.openedControls).toEqual(["stage"]);
    expect(result.restoration.control).toBe("proven");
    expect(page.listboxOpen()).toBe(false);
  });
});

describe("G — an edit session with unsaved changes is left exactly as found", () => {
  it("does not revert the user's other field", async () => {
    const page = mountRecord(["Prospecting", "Closed Won"], {
      startEditing: true,
      otherFieldValue: "999999"
    });
    const result = await inspect(page);

    expect(result.options.stage).toEqual(["Prospecting", "Closed Won"]);
    expect(page.otherFieldValue()).toBe("999999");
    expect(page.editing()).toBe(true);
    expectNoMutation(page);
  });
});

/* ------------------------------ unknown state ------------------------------ */

describe("H — an unknown initial state is treated conservatively", () => {
  it("makes no page-level transition, because ownership could not later be attributed", async () => {
    document.body.innerHTML = `<div>Something that is neither a record view nor a record edit form.</div>`;
    const result = await inspectValueDomains({
      root: document.body,
      binding,
      adapter: adapter(),
      reaction: { quietMs: 5, timeoutMs: 100 }
    });

    expect(result.initialPageState).toBe("unknown");
    expect(result.ownership.enteredEditMode).toBe(false);
    expect(result.restoration.page).toBe("not-required");
    expect(result.evidence.join(" ")).toMatch(/no page-level transition was made/i);
    expect(result.unresolved.stage).toBeDefined();
  });
});

/* --------------------------- other discovery outcomes --------------------------- */

describe("I — an empty option list is a failed discovery, not an empty domain", () => {
  it("reports the domain as undiscovered and still restores view state", async () => {
    const page = mountRecord([]);
    const result = await inspect(page);

    expect(result.options).toEqual({});
    expect(result.unresolved.stage).toMatch(/no readable values/i);
    expect(result.restoration.page).toBe("proven");
    expect(page.editing()).toBe(false);
    expectNoMutation(page);
  });
});

describe("J — duplicate labels dedupe, and restoration still happens", () => {
  it("returns one entry per distinct label", async () => {
    const page = mountRecord(["Closed Won", "Closed Won", "Prospecting"]);
    const result = await inspect(page);

    expect(result.options.stage).toEqual(["Closed Won", "Prospecting"]);
    expect(result.restoration.page).toBe("proven");
    expectNoMutation(page);
  });
});

describe("K & L — an exception or a stall mid-read does not skip restoration", () => {
  it("K — restores the page even when the component throws while opening", async () => {
    const page = mountRecord(["Prospecting"], { throwOnOpen: true });
    const result = await inspect(page);

    expect(result.unresolved.stage).toBeDefined();
    expect(result.restoration.page).toBe("proven");
    expect(page.editing()).toBe(false);
    expectNoMutation(page);
  });

  it("L — a control that never opens is treated the same as any other failure", async () => {
    const page = mountRecord(["Prospecting"], { openWorks: false });
    const result = await inspect(page);

    expect(result.options).toEqual({});
    expect(result.restoration.page).toBe("proven");
    expect(page.editing()).toBe(false);
    expectNoMutation(page);
  });
});

/* --------------------------- structural prohibitions --------------------------- */

describe("M & N — Save and value mutation are unreachable from introspection", () => {
  it("M — no path ever clicks Save", async () => {
    const paths: Array<() => Page> = [
      () => mountRecord(["Prospecting", "Closed Won"]),
      () => mountRecord([], { openWorks: false }),
      () => mountRecord(["Prospecting"], { withCancel: false }),
      () => mountRecord(["Prospecting"], { cancelWorks: false }),
      () => mountRecord(["Prospecting"], { dismissWorks: false }),
      () => mountRecord(["Prospecting"], { throwOnOpen: true }),
      () => mountRecord(["Prospecting"], { startEditing: true }),
      () => mountRecord([])
    ];
    for (const build of paths) {
      const page = build();
      await inspect(page);
      expect(page.saves).toBe(0);
    }
  });

  it("N — options are read without any of them being selected", async () => {
    const page = mountRecord(["Prospecting", "Qualification", "Closed Won"]);
    const result = await inspect(page);
    expect(result.options.stage).toHaveLength(3);
    expect(page.valueMutations).toBe(0);
    expect(page.optionSelections).toEqual([]);
  });

  it("the introspector this path receives cannot write a value at all", () => {
    const narrowed = readOnlyIntrospector(adapter()) as unknown as Record<string, unknown>;
    // Structural, not a convention: the projection simply has no writing
    // method on it, so no code in the introspection path can call one.
    expect(narrowed.setFieldValue).toBeUndefined();
    expect(narrowed.readFieldOptions).toBeDefined();
    expect(narrowed.restoreRecordView).toBeDefined();
    expect(Object.keys(narrowed).sort()).toEqual(
      ["assessPageState", "ensureEditable", "id", "readFieldOptions", "resolutionPolicy", "resolveTarget", "restoreRecordView"].sort()
    );
  });
});

describe("O — introspection changes no lifecycle state of its own", () => {
  it("returns only observations: no binding acceptance, confirmation, or publication", async () => {
    const page = mountRecord(["Prospecting", "Closed Won"]);
    const result = await inspect(page);

    // The result is a set of observations plus how they were obtained, and
    // nothing else. Anything resembling acceptance or publication would
    // have to appear here first.
    expect(Object.keys(result).sort()).toEqual(
      ["evidence", "finalPageState", "initialPageState", "options", "ownership", "restoration", "unresolved"].sort()
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/accepted|publish|confirmed/i);
  });
});

describe("an Edit we opened but could not classify is still ours to close", () => {
  /**
   * The live case: AutoWebMCP clicked Edit, Salesforce opened its edit
   * modal, the page-state assessment did not recognize it, and ownership —
   * which required a successfully classified result — concluded the
   * transition was not ours. So the user's record was left sitting in edit
   * mode by an operation that only meant to read.
   */
  function mountUnrecognizedEditSurface(): { root: HTMLElement; cancelled: number; saves: number } {
    const state = { cancelled: 0, saves: 0 };
    document.body.innerHTML = `<div id="page"></div>`;
    const page = document.querySelector<HTMLElement>("#page")!;

    const renderView = (): void => {
      page.innerHTML = `<div><h1>PS Project Test</h1><button id="edit">Edit</button></div>`;
      page.querySelector<HTMLButtonElement>("#edit")!.addEventListener("click", () => {
        // An edit surface the assessment cannot qualify: no recognized
        // component, and only one editable field beside its actions.
        page.innerHTML = `
          <div class="opaque-modal">
            <h2>Edit PS Project Test</h2>
            <input aria-label="Quantity" />
            <button id="save">Save</button>
            <button id="cancel">Cancel</button>
          </div>
          <button id="edit">Edit</button>`;
        page.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", () => {
          state.saves++;
        });
        page.querySelector<HTMLButtonElement>("#cancel")!.addEventListener("click", () => {
          state.cancelled++;
          renderView();
        });
      });
    };
    renderView();
    return {
      root: document.body,
      get cancelled() {
        return state.cancelled;
      },
      get saves() {
        return state.saves;
      }
    };
  }

  it("owns the transition because it invoked Edit, not because it recognized the result", async () => {
    const page = mountUnrecognizedEditSurface();
    const result = await inspectValueDomains({
      root: page.root,
      binding,
      adapter: adapter(),
      reaction: { quietMs: 5, timeoutMs: 100 },
      restoreTimeoutMs: 150,
      editWaitMs: 150
    });

    expect(result.ownership.enteredEditMode).toBe(true);
    // And having owned it, it closes it rather than walking away.
    expect(page.cancelled).toBe(1);
    expect(page.saves).toBe(0);
  });

  it("explains why the surface was not recognized, rather than only that it was not", async () => {
    const page = mountUnrecognizedEditSurface();
    const result = await inspectValueDomains({
      root: page.root,
      binding,
      adapter: adapter(),
      reaction: { quietMs: 5, timeoutMs: 100 },
      restoreTimeoutMs: 150,
      editWaitMs: 150
    });
    expect(result.unresolved.stage).toMatch(/Edit-state evidence/);
    expect(result.unresolved.stage).toMatch(/editable fields found/);
  });
});
