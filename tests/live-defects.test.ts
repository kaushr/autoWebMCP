// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import {
  compareObservedValue,
  readSemanticOptions,
  resolveSemanticTarget,
  setFieldValue
} from "../src/binding/browserExecution/engine";
import { resolverAdapterForPlatform } from "../src/binding/browserExecution/adapters";
import { suspiciousDomain } from "../src/binding/browserExecution/salesforceAdapter";
import { buildTestFormFields } from "../src/training/executionTestForm";
import { assessExecutionReadiness } from "../src/training/executionReadiness";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserExecutionBinding, SemanticTarget } from "../src/binding/browserExecution/model";
import type { SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * Three defects from one live run, reproduced.
 *
 *   Stage acquisition read `"stage completeEngage"` — a label and two
 *   option texts run together — and that string travelled into an
 *   execution request as if it were a business value.
 *
 *   Picklist verification read the control back in the same tick as the
 *   click, so a correct selection reported "still shows Collaborate".
 *
 *   Close Date reported having no date-picker trigger, because every
 *   earlier strategy required the resolved element to own a shadow root —
 *   and resolution had landed exactly on the input itself.
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";
const adapter = () => resolverAdapterForPlatform(PLATFORM);
const SALESFORCE = sourceApplicationFor(PLATFORM, "example.lightning.force.com");
const STAGE: SemanticTarget = { role: "field", label: "*Stage" };
const CLOSE_DATE: SemanticTarget = { role: "field", label: "*Close Date", applicationIdentifier: "CloseDate" };

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

function shadow(host: Element, html: string): ShadowRoot {
  const root = (host as HTMLElement).attachShadow({ mode: "open" });
  root.innerHTML = html;
  return root;
}

const EDIT_SHELL = (fields: string) => `
  <records-record-edit>
    ${fields}
    <input aria-label="Amount" /><input aria-label="Opportunity Name" />
    <button id="save">Save</button><button>Cancel</button>
  </records-record-edit>`;

/* ------------------- 1. option extraction ------------------- */

/**
 * The shape that produced the live blob: a wrapper that carries the option
 * role itself while holding the real options, so its text is everything
 * beneath it concatenated.
 */
function mountWrapperPicklist(): { root: HTMLElement; saves: number } {
  const state = { saves: 0 };
  const root = mount(EDIT_SHELL(`<label for="s">*Stage</label><lightning-combobox id="s"></lightning-combobox>`));
  root.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", () => {
    state.saves++;
  });

  const outer = shadow(root.querySelector("lightning-combobox")!, `<lightning-base-combobox></lightning-base-combobox>`);
  const inner = shadow(
    outer.querySelector("lightning-base-combobox")!,
    `<button role="combobox" aria-expanded="false">Collaborate</button><div class="dd"></div>`
  );
  const trigger = inner.querySelector("button")!;
  const dropdown = inner.querySelector(".dd")!;
  const close = (): void => {
    dropdown.innerHTML = "";
    trigger.setAttribute("aria-expanded", "false");
  };
  trigger.addEventListener("click", () => {
    if (trigger.getAttribute("aria-expanded") === "true") return close();
    trigger.setAttribute("aria-expanded", "true");
    dropdown.innerHTML = `
      <div role="listbox">
        <div role="option" class="wrapper">stage complete
          <lightning-base-combobox-item role="option"><span> Engage </span></lightning-base-combobox-item>
          <lightning-base-combobox-item role="option"><span>Collaborate</span></lightning-base-combobox-item>
          <lightning-base-combobox-item role="option"><span>Complete</span></lightning-base-combobox-item>
        </div>
      </div>`;
  });
  trigger.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape") close();
  });
  return {
    root,
    get saves() {
      return state.saves;
    }
  };
}

describe("1 — a container carrying the option role is not a choice", () => {
  const page = mountWrapperPicklist();
  let read: Awaited<ReturnType<typeof readSemanticOptions>>;
  beforeAll(async () => {
    read = await readSemanticOptions(page.root, STAGE, adapter());
  });

  it("returns only the leaf options a human could actually select", () => {
    expect(read.options).toEqual(["Engage", "Collaborate", "Complete"]);
  });

  it("never produces the run-together blob the live run sent into execution", () => {
    expect(read.options).not.toContain("stage completeEngage");
    expect(read.options?.some((option) => option.toLowerCase().includes("stage complete"))).toBe(false);
  });

  it("normalizes whitespace, so a padded label is the same option", () => {
    // " Engage " in the fixture.
    expect(read.options).toContain("Engage");
    expect(read.options).not.toContain(" Engage ");
  });

  it("reads without selecting anything or saving", () => {
    expect(page.saves).toBe(0);
  });
});

describe("an option never inherits the field's own label", () => {
  it("reads the option's own text even when it sits inside the field's <label>", async () => {
    // The shape the live capture recorded: `lightning-base-combobox-item`
    // whose reported label was "*Stage" — the field's label, inherited
    // through the generic accessible-name computation's ancestor-label
    // fallback.
    const root = mount(EDIT_SHELL(`<label for="s">*Stage</label><lightning-combobox id="s"></lightning-combobox>`));
    const outer = shadow(root.querySelector("lightning-combobox")!, `<lightning-base-combobox></lightning-base-combobox>`);
    const inner = shadow(
      outer.querySelector("lightning-base-combobox")!,
      `<label>*Stage
         <button role="combobox" aria-expanded="false">Collaborate</button>
         <div class="dd"></div>
       </label>`
    );
    const trigger = inner.querySelector("button")!;
    const dropdown = inner.querySelector(".dd")!;
    trigger.addEventListener("click", () => {
      if (trigger.getAttribute("aria-expanded") === "true") {
        dropdown.innerHTML = "";
        trigger.setAttribute("aria-expanded", "false");
        return;
      }
      trigger.setAttribute("aria-expanded", "true");
      dropdown.innerHTML = `<div role="listbox">
        <lightning-base-combobox-item role="option">Engage</lightning-base-combobox-item>
        <lightning-base-combobox-item role="option">Collaborate</lightning-base-combobox-item>
        <lightning-base-combobox-item role="option">Complete</lightning-base-combobox-item>
      </div>`;
    });
    trigger.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") {
        dropdown.innerHTML = "";
        trigger.setAttribute("aria-expanded", "false");
      }
    });

    const read = await readSemanticOptions(root, STAGE, adapter());
    expect(read.options).toEqual(["Engage", "Collaborate", "Complete"]);
    expect(read.options?.some((option) => option.includes("Stage"))).toBe(false);
  });
});

describe("the structural gate catches a blob that still escapes extraction", () => {
  it("recognizes a value that is several other options run together", () => {
    expect(suspiciousDomain(["Engage", "Collaborate", "Complete", "stage completeEngage"])).toMatch(
      /several options run together/i
    );
  });

  it("tolerates one option legitimately containing another", () => {
    expect(suspiciousDomain(["Closed Won", "Closed Won - Renewal"])).toBeUndefined();
  });

  it("rejects a domain with an unreadable label", () => {
    expect(suspiciousDomain(["Engage", "   "])).toMatch(/no readable label/i);
  });

  it("accepts an ordinary domain", () => {
    expect(suspiciousDomain(["Engage", "Collaborate", "Complete"])).toBeUndefined();
  });
});

describe("4 — a suspicious domain does not unlock Run test", () => {
  const capability: SemanticCapability = {
    id: "update_opportunity",
    name: "Update opportunity",
    description: "Change stage and save.",
    inputs: [{ name: "stage", description: "stage", type: "string", required: true }],
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true }
  };
  const binding: BrowserExecutionBinding = {
    id: "b",
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
          domain: "discoverable-live"
        }
      }
    ],
    commit: { semanticAction: { role: "button", label: "Save" } },
    verification: ["no-validation-error-visible"],
    safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
    evidence: []
  };

  it("an unresolved domain leaves the field constrained and the test blocked", () => {
    // Acquisition returned nothing, which is what a rejected domain produces.
    const fields = buildTestFormFields(capability, binding);
    expect(fields[0].domainUnknown).toBe(true);
    expect(assessExecutionReadiness(fields, binding).canRun).toBe(false);
  });

  it("a clean domain unlocks it", () => {
    const fields = buildTestFormFields(capability, binding, { stage: ["Engage", "Complete"] });
    expect(fields[0].options).toEqual(["Engage", "Complete"]);
    expect(assessExecutionReadiness(fields, binding).canRun).toBe(true);
  });
});

/* ------------------- 2. async verification ------------------- */

/** A picklist that updates its trigger only after a delay, as Lightning does. */
function mountAsyncPicklist(delayMs: number, opts: { ignoresSelection?: boolean } = {}): {
  root: HTMLElement;
  saves: number;
} {
  const state = { saves: 0 };
  const root = mount(EDIT_SHELL(`<label for="s">*Stage</label><lightning-combobox id="s"></lightning-combobox>`));
  root.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", () => {
    state.saves++;
  });

  const outer = shadow(root.querySelector("lightning-combobox")!, `<lightning-base-combobox></lightning-base-combobox>`);
  const inner = shadow(
    outer.querySelector("lightning-base-combobox")!,
    `<button role="combobox" aria-expanded="false">Collaborate</button><div class="dd"></div>`
  );
  const trigger = inner.querySelector("button")!;
  const dropdown = inner.querySelector(".dd")!;
  trigger.addEventListener("click", () => {
    if (trigger.getAttribute("aria-expanded") === "true") {
      dropdown.innerHTML = "";
      trigger.setAttribute("aria-expanded", "false");
      return;
    }
    trigger.setAttribute("aria-expanded", "true");
    dropdown.innerHTML = `<div role="listbox">
      <lightning-base-combobox-item role="option">Engage</lightning-base-combobox-item>
      <lightning-base-combobox-item role="option">Complete</lightning-base-combobox-item>
    </div>`;
    for (const item of dropdown.querySelectorAll('[role="option"]')) {
      item.addEventListener("click", () => {
        dropdown.innerHTML = "";
        trigger.setAttribute("aria-expanded", "false");
        if (opts.ignoresSelection) return;
        // The real component repaints its trigger a beat later.
        setTimeout(() => {
          trigger.textContent = item.textContent ?? "";
        }, delayMs);
      });
    }
  });
  return {
    root,
    get saves() {
      return state.saves;
    }
  };
}

describe("2 — verification waits for the application to settle", () => {
  it("a delayed Lightning update verifies successfully", async () => {
    const page = mountAsyncPicklist(150);
    const resolved = resolveSemanticTarget(page.root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);

    const outcome = await setFieldValue(resolved.target, "Complete", "select", adapter());
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toMatch(/Complete/);
    expect(page.saves).toBe(0);
  });

  it("a picklist that genuinely ignores the selection still fails", async () => {
    const page = mountAsyncPicklist(0, { ignoresSelection: true });
    const resolved = resolveSemanticTarget(page.root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);

    const outcome = await setFieldValue(resolved.target, "Complete", "select", adapter());
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/still shows "Collaborate"/);
    expect(page.saves).toBe(0);
  });

  it("stays honest about the platform's true current state, even when the write's own check was fooled by a stale reference", async () => {
    // A live run showed setPicklistValue's own internal check reporting
    // "Confirm" while the transaction's separate, freshly-resolved
    // read-back still showed "Collaborate" — investigated as a possible
    // bug in the read-back (preferring a fresh resolution over the
    // write's own verified element), and disproven by this exact
    // fixture: the write's own check reads from a single reference it
    // captured before the click, so if the platform ever replaces that
    // element (plausible — Stage also drives a visible Path indicator),
    // the write's check would keep reporting success from an orphaned
    // copy forever, no matter how stale. Reading fresh every time is
    // what stays truthful. This is not a code bug to fix; it documents
    // why "the write said it worked" and "the record actually holds it"
    // are two different questions, and why only the second is trusted.
    const root = mount(EDIT_SHELL(`<label for="s">*Stage</label><lightning-combobox id="s"></lightning-combobox>`));
    const buildHost = (selected: string): Element => {
      const el = document.createElement("lightning-combobox");
      el.id = "s";
      const outer = shadow(el, `<lightning-base-combobox></lightning-base-combobox>`);
      const inner = shadow(
        outer.querySelector("lightning-base-combobox")!,
        `<button role="combobox" aria-expanded="false">${selected}</button><div class="dd"></div>`
      );
      const trigger = inner.querySelector("button")!;
      const dropdown = inner.querySelector(".dd")!;
      trigger.addEventListener("click", () => {
        if (trigger.getAttribute("aria-expanded") === "true") {
          dropdown.innerHTML = "";
          trigger.setAttribute("aria-expanded", "false");
          return;
        }
        trigger.setAttribute("aria-expanded", "true");
        dropdown.innerHTML = `<div role="listbox">
          <lightning-base-combobox-item role="option">Collaborate</lightning-base-combobox-item>
          <lightning-base-combobox-item role="option">Confirm</lightning-base-combobox-item>
        </div>`;
        for (const item of dropdown.querySelectorAll('[role="option"]')) {
          item.addEventListener("click", () => {
            trigger.textContent = item.textContent ?? "";
            dropdown.innerHTML = "";
            trigger.setAttribute("aria-expanded", "false");
            // The platform's own reactive re-render: this component gets
            // replaced by a fresh instance a beat later, still reflecting
            // the record's real (unchanged, unsaved) value.
            setTimeout(() => el.replaceWith(buildHost("Collaborate")), 10);
          });
        }
      });
      return el;
    };
    root.querySelector("lightning-combobox")!.replaceWith(buildHost("Collaborate"));

    const resolved = resolveSemanticTarget(root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);

    const outcome = await setFieldValue(resolved.target, "Confirm", "select", adapter());
    // The write's own check reads its captured reference — genuinely
    // "Confirm" at that moment, and still "Confirm" forever after, since
    // that node is about to be orphaned.
    expect(outcome.ok).toBe(true);

    // Wait past the simulated re-render.
    await new Promise((r) => setTimeout(r, 50));

    // A fresh, independent read — exactly what the transaction's own
    // verification does — finds the truth instead.
    const afterWrite = adapter()!.readFieldValue!(root, STAGE, adapter()!.resolutionPolicy!);
    expect(afterWrite).toBe("Collaborate");
  });
});

/* ------------------- 3. date control discovery ------------------- */

describe("3 — the date control is found wherever it sits beneath the target", () => {
  it("when resolution lands exactly on the native input, which is what broke live", async () => {
    // Reproduces the regression: the resolved element IS the control, so
    // every strategy that searched only inside its shadow root declined.
    const root = mount(
      EDIT_SHELL(`<label for="cd">*Close Date</label><input id="cd" name="CloseDate" type="date" />`)
    );
    const resolved = resolveSemanticTarget(root, CLOSE_DATE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.target.element.tagName).toBe("INPUT");
    expect((resolved.target.element as HTMLElement).shadowRoot).toBeNull();

    const outcome = await setFieldValue(resolved.target, "2027-03-01", "date", adapter());
    expect(outcome.ok).toBe(true);
    expect(root.querySelector<HTMLInputElement>("#cd")!.value).toBe("2027-03-01");
  });

  it("when the target is a light-DOM wrapper and the control is a shadow boundary below", async () => {
    const root = mount(
      EDIT_SHELL(`<label for="cd">*Close Date</label>
        <records-record-field id="cd"><lightning-input></lightning-input></records-record-field>`)
    );
    shadow(root.querySelector("lightning-input")!, `<input name="CloseDate" type="text" class="slds-input" />`);

    const resolved = resolveSemanticTarget(root, CLOSE_DATE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);
    const outcome = await setFieldValue(resolved.target, "2027-03-01", "date", adapter());
    expect(outcome.ok).toBe(true);
    // A text input takes the display format a human would type.
    expect(outcome.detail).toMatch(/display format/i);
  });

  it("the previously working component-host shape stays green", async () => {
    const root = mount(EDIT_SHELL(`<label for="cd">*Close Date</label><lightning-input id="cd"></lightning-input>`));
    const inner = shadow(root.querySelector("lightning-input")!, `<lightning-datepicker></lightning-datepicker>`);
    shadow(inner.querySelector("lightning-datepicker")!, `<input name="CloseDate" type="date" />`);

    const resolved = resolveSemanticTarget(root, CLOSE_DATE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);
    const outcome = await setFieldValue(resolved.target, "2027-03-01", "date", adapter());
    expect(outcome.ok).toBe(true);
  });

  it("does not report success until the page's own reaction to the write has settled", async () => {
    // Reproduces a live failure directly: Close Date was written, success
    // was reported, and the very next read-back — which happens
    // immediately after this resolves — still showed the old value.
    // `setPicklistValue` already had to solve exactly this for picklists;
    // this proves the date write got the same fix, not just that it
    // compiles. A delayed mutation, fired well after the synchronous
    // write, stands in for Lightning's own asynchronous re-render; if the
    // function returned before waiting for it, `reacted` would still be
    // false the instant `setFieldValue` resolves.
    const root = mount(
      EDIT_SHELL(`<label for="cd">*Close Date</label><records-record-field id="cd"><lightning-input></lightning-input></records-record-field>`)
    );
    const inputShadow = shadow(root.querySelector("lightning-input")!, `<input name="CloseDate" type="text" class="slds-input" /><span class="marker"></span>`);
    const input = inputShadow.querySelector("input")!;
    const marker = inputShadow.querySelector(".marker")!;
    let reacted = false;
    input.addEventListener("input", () => {
      setTimeout(() => {
        reacted = true;
        marker.textContent = "reacted";
      }, 20);
    });

    const resolved = resolveSemanticTarget(root, CLOSE_DATE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);
    const outcome = await setFieldValue(resolved.target, "2027-03-01", "date", adapter());
    expect(outcome.ok).toBe(true);
    expect(reacted).toBe(true);
  });

  it("a genuine failure now explains every strategy it tried", async () => {
    const root = mount(
      EDIT_SHELL(`<label for="cd">*Close Date</label><records-record-field id="cd"><span>no control here</span></records-record-field>`)
    );
    const resolved = resolveSemanticTarget(root, CLOSE_DATE, adapter());
    if (!resolved.ok) {
      // Nothing field-like resolved at all, which is itself an honest answer.
      expect(resolved.reason).toBeTruthy();
      return;
    }
    const outcome = await setFieldValue(resolved.target, "2027-03-01", "date", adapter());
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/Strategies attempted/);
    expect(outcome.detail).toMatch(/own shadow root/);
    expect(outcome.detail).toMatch(/native input in composed subtree/);
  });
});

describe("no write escapes a failed field", () => {
  it("Save is never invoked when a value cannot be set", async () => {
    const page = mountAsyncPicklist(0, { ignoresSelection: true });
    const resolved = resolveSemanticTarget(page.root, STAGE, adapter());
    if (!resolved.ok) throw new Error(resolved.reason);
    await setFieldValue(resolved.target, "Complete", "select", adapter());
    expect(page.saves).toBe(0);
  });
});

/* ------------------- the date-format hazard ------------------- */

describe("writing a date into a text control assumes a locale", () => {
  it("documents a silent wrong-value path that verification cannot catch", () => {
    // The adapter types M/D/YYYY, and the read-back parser reads M/D/YYYY.
    // In an org that displays D/M/YYYY both are wrong the same way, so the
    // check agrees with the mistake instead of catching it.
    const requested = "2026-11-01"; // 1 November
    const orgDisplaysDayFirst = "11/01/2026"; // the org stored 11 January
    expect(compareObservedValue(requested, orgDisplaysDayFirst)).toBe("match");

    // Stated plainly so the hazard is not mistaken for correctness: the
    // only unambiguous path is the native date input, which takes ISO.
    // Resolving this properly needs the org's locale, which is application
    // knowledge rather than something to guess in the adapter.
    expect(compareObservedValue("2026-11-01", "2026-11-01")).toBe("match");
  });
});
