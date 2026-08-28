// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { observeSurfaces } from "../src/binding/browserExecution/surfaceObservation";
import {
  resolutionPolicyForPlatform,
  resolutionProvenanceForPlatform,
  resolverAdapterForPlatform
} from "../src/binding/browserExecution/adapters";
import { createPlatformIntelligenceProvider } from "../src/platformIntelligence";
import { PLATFORM_INTELLIGENCE_SCHEMA_VERSION } from "../src/platformIntelligence/schema";
import type { EpistemicStrength, PageStateSemanticsEntry, PlatformIntelligencePack } from "../src/platformIntelligence/schema";

/* ------------------------------------------------------------------ *
 * Regression coverage for the observation-before-interpretation
 * architecture.
 *
 * The bug this replaces: Salesforce page-state candidate discovery used a
 * hardcoded selector (`[role="dialog"], [aria-modal="true"]`, plus
 * whatever component tags the pack happened to declare) BEFORE Platform
 * Intelligence ever got a say. A live, sixteen-field Salesforce edit form
 * matched neither identity, so it never became a candidate surface at
 * all — the traversal and field-counting logic were both proven correct
 * by direct read; discovery itself was too narrow and ran too early.
 *
 * `observeSurfaces` (generic, no Salesforce tag names) now discovers every
 * plausible candidate; `assessSalesforcePageState` asks each of the
 * pack's declared *patterns* whether one explains a given candidate. Tests
 * here prove: (A/L/M) multiple independently-provenanced patterns can
 * each establish record-edit, with their own strength preserved; (B) the
 * live case itself, reproduced; (C/N) an unrelated dialog — the actual
 * Aura "Sorry to interrupt" error banner this investigation turned up —
 * is observable in diagnostics without ever being mistaken for an edit
 * surface; (D/E) generic dialogs that fall short of any pattern stay
 * `record-view`; (F) a surface that looks edit-like but satisfies no
 * pattern reports `unknown`, never a false `record-view`; (G) genuine
 * record-view still requires positive evidence; (H/I) field counting is
 * the one shared definition execution itself trusts; (J/K) Platform
 * Intelligence actually controls the outcome, proven by swapping it out
 * from under the same DOM.
 * ------------------------------------------------------------------ */

const SF = resolutionPolicyForPlatform("salesforce-lightning");
/** The shipped adapter, carrying the real pack's declared patterns. */
const productionAdapter = () => resolverAdapterForPlatform("salesforce-lightning")!;

function mount(html: string): HTMLElement {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

/** A minimal stand-in for an LWC-style field host: a custom element that mirrors a `value` property. */
class MockField extends HTMLElement {
  value = "";
}
if (!customElements.get("mock-field")) customElements.define("mock-field", MockField);

/** A custom element with NO mirrored value property — must be recognized, if at all, purely by a native control reachable somewhere inside it. */
class OpaqueWrapper extends HTMLElement {}
if (!customElements.get("opaque-wrapper")) customElements.define("opaque-wrapper", OpaqueWrapper);

function structuralEntry(id: string, strength: EpistemicStrength, minimumEditableFields: number): PageStateSemanticsEntry {
  return {
    id,
    category: "page-state-semantics",
    strength,
    summary: `test structural pattern (${id})`,
    sourceReferenceIds: ["test-source"],
    pageState: {
      genericDialogIsNotEditEvidence: true,
      editSurface: {
        kind: "structural",
        minimumEditableFields,
        commitActionLabels: ["save"],
        dismissActionLabels: ["cancel"]
      }
    }
  };
}

function componentIdentityEntry(id: string, strength: EpistemicStrength, tags: string[]): PageStateSemanticsEntry {
  return {
    id,
    category: "page-state-semantics",
    strength,
    summary: `test component-identity pattern (${id})`,
    sourceReferenceIds: ["test-source"],
    pageState: {
      genericDialogIsNotEditEvidence: true,
      editSurface: { kind: "component-identity", componentIdentities: tags }
    }
  };
}

function packWith(entries: PageStateSemanticsEntry[]): PlatformIntelligencePack {
  return {
    packId: "test-pack",
    packVersion: "0.0.1",
    schemaVersion: PLATFORM_INTELLIGENCE_SCHEMA_VERSION,
    platform: { id: "salesforce-lightning", label: "Test Salesforce" },
    sourceReferences: [{ id: "test-source", kind: "internal-evidence", title: "test evidence" }],
    knowledge: entries
  };
}

function adapterWith(entries: PageStateSemanticsEntry[]) {
  const provider = createPlatformIntelligenceProvider([packWith(entries)]);
  return resolverAdapterForPlatform("salesforce-lightning", provider)!;
}

describe("A — a known component identity establishes record-edit on its own", () => {
  it("qualifies with zero editable fields, purely on component identity", () => {
    const root = mount(`<custom-edit-form><button>Save</button></custom-edit-form>`);
    const adapter = adapterWith([componentIdentityEntry("p-identity", "validated-platform-rule", ["custom-edit-form"])]);
    const assessment = adapter.assessPageState!(root, SF)!;
    expect(assessment.state).toBe("record-edit");
    expect(assessment.evidence.matchedPattern).toEqual({ id: "p-identity", strength: "validated-platform-rule" });
  });
});

describe("B — the live case: a rich edit form with no known tag and no dialog role", () => {
  it("becomes record-edit through the production pack's structural pattern, not a hardcoded selector", () => {
    const fields = Array.from(
      { length: 12 },
      (_, i) => `<label for="f${i}">Field ${i}</label><input id="f${i}" />`
    ).join("");
    // Deliberately: no role="dialog", no aria-modal, no lightning-record-edit-form,
    // no records-record-edit, no record-edit-form — exactly what the live
    // Salesforce edit form looked like to the observation layer.
    const root = mount(`<div class="opaque-vendor-wrapper">${fields}<button>Save</button><button>Cancel</button></div>`);
    const assessment = productionAdapter().assessPageState!(root, SF)!;
    expect(assessment.state).toBe("record-edit");
    expect(assessment.evidence.matchedPattern?.id).toBe("sf-record-edit-structural-semantics");
    expect(assessment.evidence.matchedPattern?.strength).toBe("observed-pattern");
    expect(assessment.evidence.editableFieldCount).toBe(12);
  });
});

describe("C & N — an unrelated Aura error banner is observed, never treated as an edit surface", () => {
  it("does not qualify as record-edit, and is not silently dropped from diagnostics", () => {
    // The actual live shape this investigation found: role="dialog",
    // "Sorry to interrupt", a "CSS Error" message, and a Refresh action —
    // zero editable fields.
    const root = mount(`
      <div role="dialog" aria-labelledby="auraErrorTitle" aria-describedby="auraErrorMessage" aria-modal="true" class="auraErrorBox" id="auraError">
        <span id="auraErrorTitle">Sorry to interrupt</span>
        <div id="auraErrorMessage">CSS Error</div>
        <a role="button" id="auraErrorReload">Refresh</a>
      </div>
    `);
    const assessment = productionAdapter().assessPageState!(root, SF)!;
    expect(assessment.state).not.toBe("record-edit");
    expect(assessment.evidence.otherSurfaces?.some((s) => s.heading === "Sorry to interrupt")).toBe(true);
  });

  it("names the error surface in the ensureEditable diagnostics trail, not just an aggregate count", async () => {
    const root = mount(`
      <div role="dialog" aria-labelledby="auraErrorTitle" id="auraError"><span id="auraErrorTitle">Sorry to interrupt</span></div>
      <button>Edit</button>
    `);
    // The Edit button here has no click handler — the transition itself is
    // expected to fail, and bounded tightly so that failure is fast; this
    // test is only about what the diagnostics say along the way.
    const transition = await productionAdapter().ensureEditable!(root, SF, 30);
    expect(transition!.diagnostics.join("\n")).toMatch(/Sorry to interrupt/);
  });
});

describe("D — a generic dialog with one field and no commit action stays record-view", () => {
  it("does not qualify, and reports record-view because an Edit action is genuinely offered", () => {
    const root = mount(`
      <div role="dialog"><label for="x">Search</label><input id="x" /></div>
      <button>Edit</button>
    `);
    const assessment = productionAdapter().assessPageState!(root, SF)!;
    expect(assessment.state).toBe("record-view");
  });
});

describe("E — a surface with a Save action but no meaningful editable controls stays record-view", () => {
  it("zero fields never qualifies, no matter how confident the action looks", () => {
    const root = mount(`<div role="dialog"><button>Save</button></div><button>Edit</button>`);
    const assessment = productionAdapter().assessPageState!(root, SF)!;
    expect(assessment.state).toBe("record-view");
  });
});

describe("F — insufficient evidence reports unknown, never a false record-view", () => {
  it("one field short of the threshold, with a real commit action, is unexplained — not proof of a plain view", () => {
    const root = mount(`
      <div role="dialog"><label for="x">Note</label><input id="x" /><button>Save</button></div>
      <button>Edit</button>
    `);
    const assessment = productionAdapter().assessPageState!(root, SF)!;
    // Below the structural threshold (needs 2), no known component tag —
    // genuinely unexplained. An Edit button being findable elsewhere must
    // NOT be enough to call this record-view: that is exactly the false
    // negative a live run was caught making.
    expect(assessment.state).toBe("unknown");
    expect(assessment.state).not.toBe("record-view");
  });
});

describe("G — genuine record-view requires positive evidence, and gets it", () => {
  it("no edit-like surface anywhere, an Edit action offered — record-view", () => {
    const root = mount(`<div>Opportunity Owner: Kaushik Ruparel</div><button>Edit</button>`);
    const assessment = productionAdapter().assessPageState!(root, SF)!;
    expect(assessment.state).toBe("record-view");
  });

  it("no edit-like surface and no Edit action either — unknown, not a guess", () => {
    const root = mount(`<div>nothing recognizable here</div>`);
    const assessment = productionAdapter().assessPageState!(root, SF)!;
    expect(assessment.state).toBe("unknown");
  });
});

describe("H & I — field counting is exactly the definition execution itself trusts", () => {
  it("H — a field nested behind two shadow boundaries is still counted", () => {
    mount(`<div id="host"></div>`);
    const host = document.querySelector("#host")!;
    const outer = document.createElement("opaque-wrapper");
    host.appendChild(outer);
    const shadow = outer.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    shadow.appendChild(inner);
    const innerShadow = inner.attachShadow({ mode: "open" });
    innerShadow.innerHTML = `<input />`;

    const surfaces = observeSurfaces(document.body, SF);
    const withField = surfaces.find((s) => s.facts.editableFieldCount > 0);
    expect(withField?.facts.editableFieldCount).toBe(1);
  });

  it("I — a component host wrapping a native input counts once, not twice", () => {
    mount(`<mock-field id="mf"></mock-field>`);
    const host = document.querySelector("#mf")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<input />`;
    const surfaces = observeSurfaces(document.body, SF);
    const withField = surfaces.find((s) => s.facts.editableFieldCount > 0);
    expect(withField?.facts.editableFieldCount).toBe(1);
  });
});

describe("J & K — Platform Intelligence actually controls the outcome", () => {
  const domWithThreeFields = () =>
    mount(`
      <div role="dialog">
        <label for="a">A</label><input id="a" />
        <label for="b">B</label><input id="b" />
        <label for="c">C</label><input id="c" />
        <button>Save</button>
      </div>
    `);

  it("J — a low threshold qualifies the same DOM a high threshold rejects", () => {
    const permissive = adapterWith([structuralEntry("p-lenient", "observed-pattern", 2)]);
    const strict = adapterWith([structuralEntry("p-strict", "observed-pattern", 50)]);

    const root1 = domWithThreeFields();
    expect(permissive.assessPageState!(root1, SF)!.state).toBe("record-edit");

    const root2 = domWithThreeFields();
    expect(strict.assessPageState!(root2, SF)!.state).not.toBe("record-edit");
  });

  it("K — with no page-state knowledge declared at all, behavior is the generic conservative default, not a hidden Salesforce-specific threshold", () => {
    const bare = adapterWith([]);
    const root = domWithThreeFields();
    const assessment = bare.assessPageState!(root, SF)!;
    // The generic default (two-field minimum, Save/Cancel wording) still
    // applies — this is NOT the same as re-deriving Salesforce's own
    // declared pattern id from nowhere.
    expect(assessment.state).toBe("record-edit");
    expect(assessment.evidence.matchedPattern?.id).toBe("generic-structural");
    expect(assessment.evidence.matchedPattern?.id).not.toMatch(/^sf-/);
  });
});

describe("O — execution and introspection diagnostics identify the same PI provenance", () => {
  it("names both page-state patterns, by id, in the shared provenance string execution and introspection both use", () => {
    // content.ts's introspection path and its execution path both call this
    // exact function to stamp their result's evidence — proven here at the
    // one place that could drift, rather than by re-deriving the string in
    // two different call sites that could silently disagree.
    const provenance = resolutionProvenanceForPlatform("salesforce-lightning");
    expect(provenance).toMatch(/salesforce-intelligence-pack@0\.6\.0/);
    expect(provenance).toMatch(/sf-record-edit-component-identity/);
    expect(provenance).toMatch(/sf-record-edit-structural-semantics/);
  });
});

describe("L & M — multiple independently-provenanced patterns coexist", () => {
  const both = () =>
    adapterWith([
      componentIdentityEntry("p-identity", "validated-platform-rule", ["custom-edit-form"]),
      structuralEntry("p-structural", "observed-pattern", 2)
    ]);

  it("L — component identity alone is sufficient, independent of the structural pattern", () => {
    const root = mount(`<custom-edit-form><button>Save</button></custom-edit-form>`);
    const assessment = both().assessPageState!(root, SF)!;
    expect(assessment.state).toBe("record-edit");
    expect(assessment.evidence.matchedPattern?.id).toBe("p-identity");
  });

  it("L — the structural pattern alone is sufficient, independent of any known component tag", () => {
    const root = mount(`
      <div role="dialog">
        <label for="a">A</label><input id="a" />
        <label for="b">B</label><input id="b" />
        <button>Save</button>
      </div>
    `);
    const assessment = both().assessPageState!(root, SF)!;
    expect(assessment.state).toBe("record-edit");
    expect(assessment.evidence.matchedPattern?.id).toBe("p-structural");
  });

  it("M — each match preserves its own pattern's strength, not the other pattern's", () => {
    const identityRoot = mount(`<custom-edit-form><button>Save</button></custom-edit-form>`);
    const identityAssessment = both().assessPageState!(identityRoot, SF)!;
    expect(identityAssessment.evidence.matchedPattern?.strength).toBe("validated-platform-rule");

    const structuralRoot = mount(`
      <div role="dialog">
        <label for="a">A</label><input id="a" />
        <label for="b">B</label><input id="b" />
        <button>Save</button>
      </div>
    `);
    const structuralAssessment = both().assessPageState!(structuralRoot, SF)!;
    expect(structuralAssessment.evidence.matchedPattern?.strength).toBe("observed-pattern");
  });
});
