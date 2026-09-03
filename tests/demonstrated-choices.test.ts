// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { choiceKey, optionsFor, optionsInListbox, type FieldDescriptor } from "../src/capture/policy";

/* ------------------------------------------------------------------ *
 * The choices were on screen the whole time.
 *
 * A person changing a picklist opens it first, so every legal value was
 * rendered at the moment of the demonstration. Not recording them meant
 * the only way to learn a field's domain was to drive the browser back
 * into edit mode later and open the control again — the slowest and most
 * fragile path in the system, sitting in front of every test.
 * ------------------------------------------------------------------ */

const field = (over: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  type: "select",
  label: "Stage",
  ...over
});

describe("what a closed-set control was offering is captured, not re-derived", () => {
  it("reads a native select's own options", () => {
    document.body.innerHTML = `
      <select id="stage">
        <option>--None--</option><option>Establish</option><option>Engage</option>
      </select>`;
    expect(optionsFor(document.querySelector("#stage")!, field())).toEqual([
      "--None--",
      "Establish",
      "Engage"
    ]);
  });

  it("follows the listbox a custom combobox says it owns", () => {
    // Not "whichever listbox happens to be open": on a busy page that is a
    // different control's, and a domain published from the wrong control
    // would tell an agent that values are legal when they are not.
    document.body.innerHTML = `
      <button id="stage" role="combobox" aria-controls="stage-list">Engage</button>
      <div id="stage-list" role="listbox">
        <div role="option" title="Establish">Establish</div>
        <div role="option" title="Engage">Engage</div>
      </div>
      <div id="other-list" role="listbox"><div role="option">Newest first</div></div>`;
    expect(optionsFor(document.querySelector("#stage")!, field({ type: "button" }))).toEqual([
      "Establish",
      "Engage"
    ]);
  });

  it("yields nothing when the control never showed its choices", () => {
    // An absent set is honest. A fabricated one would put values into a
    // published contract that the application never offered.
    document.body.innerHTML = `<button id="stage" role="combobox" aria-controls="stage-list">Engage</button>`;
    expect(optionsFor(document.querySelector("#stage")!, field({ type: "button" }))).toBeUndefined();
  });

  it("captures nothing for a field the policy masks", () => {
    // A set of choices from a sensitive control is still content from a
    // sensitive control.
    document.body.innerHTML = `<select id="s"><option>4111</option><option>5500</option></select>`;
    expect(optionsFor(document.querySelector("#s")!, field({ label: "Credit card" }))).toBeUndefined();
  });

  it("does not let a page make a capture unboundedly large", () => {
    const many = Array.from({ length: 200 }, (_, index) => `<option>Value ${index}</option>`).join("");
    document.body.innerHTML = `<select id="s">${many}</select>`;
    const options = optionsFor(document.querySelector("#s")!, field())!;
    expect(options.length).toBeLessThanOrEqual(60);
  });

  it("keeps each choice once, in the order the application listed them", () => {
    document.body.innerHTML = `
      <select id="s"><option>Engage</option><option>Engage</option><option>Establish</option></select>`;
    expect(optionsFor(document.querySelector("#s")!, field())).toEqual(["Engage", "Establish"]);
  });
});

/* ====== a picklist that tears down its listbox before the change ====== */

describe("choices are read while the listbox is still open", () => {
  it("reads every option a listbox is showing", () => {
    // The live failure: a Salesforce Stage picklist recorded
    // `options: none` while all six had been on screen a moment earlier,
    // because the component removes its listbox on selection and the
    // change event arrives after that.
    document.body.innerHTML = `
      <div id="list" role="listbox">
        <div role="option" title="--None--">--None--</div>
        <div role="option" title="Establish">Establish</div>
        <div role="option" title="Engage">Engage</div>
      </div>`;
    expect(optionsInListbox(document.querySelector("#list")!)).toEqual(["--None--", "Establish", "Engage"]);
  });

  it("returns nothing for a listbox with no options in it", () => {
    document.body.innerHTML = `<div id="list" role="listbox"></div>`;
    expect(optionsInListbox(document.querySelector("#list")!)).toBeUndefined();
  });

  it("is bounded, whatever the page renders", () => {
    const many = Array.from({ length: 300 }, (_, i) => `<div role="option">Choice ${i}</div>`).join("");
    document.body.innerHTML = `<div id="list" role="listbox">${many}</div>`;
    expect(optionsInListbox(document.querySelector("#list")!)!.length).toBeLessThanOrEqual(60);
  });
});

/* ====== one control, two spellings of its own name ====== */

describe("a required field's asterisk does not lose its choices", () => {
  it("matches the same control however the application spelled it", () => {
    // The live failure, exactly: a Salesforce picklist's six values were
    // captured against "Stage" — the label on the element that owns the
    // listbox — and looked for under "*Stage", the label on the field. The
    // optional field beside it, with no asterisk to disagree about, worked
    // perfectly, which is what made this so hard to see.
    expect(choiceKey("*Stage")).toBe(choiceKey("Stage"));
    expect(choiceKey("*Close Date")).toBe(choiceKey("Close Date"));
  });

  it("still tells genuinely different fields apart", () => {
    expect(choiceKey("Stage")).not.toBe(choiceKey("Lead Source"));
    expect(choiceKey("*Close Date")).not.toBe(choiceKey("Created Date"));
  });

  it("ignores only decoration, never the name", () => {
    expect(choiceKey("  Lead   Source ")).toBe(choiceKey("Lead Source"));
    expect(choiceKey("Stage*")).not.toBe(choiceKey("Stage"));
  });
});
