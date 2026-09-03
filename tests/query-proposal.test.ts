import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import { proposeQueryBinding } from "../src/binding/browserExecution/proposeQuery";
import { entityIdentityPolicyForPlatform } from "../src/binding/browserExecution/adapters";
import type { EntityIdentityPolicy } from "../src/binding/browserExecution/entityIdentity";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { CaptureEvent } from "../src/capture/types";
import type { SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * Proposing a search from what a rep demonstrated.
 *
 * Every shape below is taken from a real recording against a live org:
 * a click on a button labelled "Search", nine keystrokes into a field
 * labelled "Search...", no commit anywhere, and a final navigation to
 * /lightning/r/<id>/view.
 *
 * Deterministic on purpose. An entity search is determined by its entity
 * type, so there is nothing here for a model to infer — and a model asked
 * to invent the shape would add a source of error where none is needed.
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";
const IDENTITY = entityIdentityPolicyForPlatform(PLATFORM) as EntityIdentityPolicy;
const SALESFORCE = sourceApplicationFor(PLATFORM, "nvent-dev-ed.lightning.force.com");
const RECORD = "0065w00002AZ0GeAAL";

const listPage = { host: "nvent-dev-ed.lightning.force.com", path: "/lightning/o/Opportunity/list" };
const resultsPage = { host: listPage.host, path: "/one/one.app#eyJjb21wb25lbnREZWYiOiJmb3JjZVNlYXJjaDp" };
const recordPage = { host: listPage.host, path: `/lightning/r/${RECORD}/view` };

/** The live recording's shape, keystroke events and all. */
function searchTrace(overrides: { events?: CaptureEvent[] } = {}) {
  const session = new CaptureSession("sess-search", 0, {
    host: listPage.host,
    platform: PLATFORM,
    title: "PS Project Test - updated | Opportunity | Salesforce"
  });
  session.addMany(
    overrides.events ?? [
      { id: "nav", kind: "navigate", t: 100, page: listPage },
      {
        id: "open",
        kind: "click",
        t: 500,
        page: listPage,
        element: { tag: "button", label: "Search" },
        actionLabel: "Search"
      },
      // Nine changes for one term — a search box emits one per keystroke,
      // and only the last carries what was actually searched for.
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `key-${index}`,
        kind: "field_change" as const,
        t: 1_000 + index * 100,
        page: listPage,
        element: { tag: "lightning-primitive-input-simple", label: "Search..." },
        field: { label: "Search...", section: "", control: "text" as const },
        value: { masked: false }
      })),
      {
        id: "term",
        kind: "field_change",
        t: 2_000,
        page: listPage,
        element: { tag: "input", label: "Search..." },
        field: { label: "Search...", section: "", control: "text" },
        value: { masked: false, to: "PS Project" }
      },
      { id: "results", kind: "navigate", t: 2_500, page: resultsPage },
      { id: "record", kind: "navigate", t: 3_000, page: recordPage }
    ]
  );
  session.stop(4_000);
  return session.toTrace();
}

function capability(): SemanticCapability {
  return {
    id: "search_opportunities",
    name: "Search opportunities",
    description: "Find opportunities by name.",
    inputs: [{ name: "name", description: "The name to search for", type: "string", required: true, role: "query" }],
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: true, requiresConfirmation: false }
  };
}

describe("a search is proposed from the demonstration, deterministically", () => {
  it("derives the query control, the opening action, and the entity type", () => {
    const proposal = proposeQueryBinding(capability(), searchTrace(), IDENTITY);
    expect(proposal.binding).not.toBeNull();
    const binding = proposal.binding!;

    // Two distinct controls, exactly as the live trace showed: a button
    // that opens the search, and the field that receives the term.
    expect(binding.open).toEqual({ role: "button", label: "Search" });
    expect(binding.query.semanticTarget).toEqual({ role: "field", label: "Search..." });
    expect(binding.query.inputName).toBe("name");

    // The entity comes from where the rep LANDED. A search is only a
    // search for something.
    expect(binding.entityType).toBe("Opportunity");

    // Nothing was clicked to run it, so it is submitted by key.
    expect(binding.submitKey).toBe("Enter");
    expect(binding.submit).toBeUndefined();
  });

  it("keeps the demonstrated term as evidence, not as a stored value", () => {
    const binding = proposeQueryBinding(capability(), searchTrace(), IDENTITY).binding!;
    expect(binding.evidence.join(" ")).toContain('"PS Project"');
    // Evidence only — the term is an argument at call time, never baked in.
    expect(JSON.stringify(binding.query)).not.toContain("PS Project");
  });

  it("is deterministic: the same trace proposes the same binding", () => {
    const first = proposeQueryBinding(capability(), searchTrace(), IDENTITY).binding;
    const second = proposeQueryBinding(capability(), searchTrace(), IDENTITY).binding;
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });

  it("stores no selector, XPath or coordinate", () => {
    const binding = proposeQueryBinding(capability(), searchTrace(), IDENTITY).binding!;
    const targets = JSON.stringify([binding.query.semanticTarget, binding.open, binding.submit]);
    expect(targets).not.toMatch(/queryselector|xpath|\/html\/|nth-child|clientx|nodeid/i);
  });
});

describe("what it refuses to propose, and why", () => {
  it("refuses a recording that saved something — that is a change, not a search", () => {
    const trace = searchTrace({
      events: [
        { id: "nav", kind: "navigate", t: 100, page: recordPage },
        {
          id: "term",
          kind: "field_change",
          t: 200,
          page: recordPage,
          element: { tag: "input", label: "Search..." },
          field: { label: "Search...", section: "", control: "text" },
          value: { masked: false, to: "PS Project" }
        },
        { id: "save", kind: "click", t: 300, page: recordPage, actionLabel: "Save" }
      ]
    });
    const proposal = proposeQueryBinding(capability(), trace, IDENTITY);
    expect(proposal.binding).toBeNull();
    expect(proposal.warnings.join(" ")).toMatch(/saved a record/i);
  });

  it("refuses when the recording never reached a record", () => {
    // Without a destination there is nothing to say what was being looked
    // for, and a search for an unknown kind of thing cannot return
    // identities a later step could use.
    const trace = searchTrace({
      events: [
        { id: "nav", kind: "navigate", t: 100, page: listPage },
        {
          id: "term",
          kind: "field_change",
          t: 200,
          page: listPage,
          element: { tag: "input", label: "Search..." },
          field: { label: "Search...", section: "", control: "text" },
          value: { masked: false, to: "PS Project" }
        },
        { id: "results", kind: "navigate", t: 300, page: resultsPage }
      ]
    });
    const proposal = proposeQueryBinding(capability(), trace, IDENTITY);
    expect(proposal.binding).toBeNull();
    expect(proposal.warnings.join(" ")).toMatch(/never reached a record/i);
  });

  it("refuses when nothing was typed", () => {
    const trace = searchTrace({
      events: [
        { id: "nav", kind: "navigate", t: 100, page: listPage },
        { id: "record", kind: "navigate", t: 200, page: recordPage }
      ]
    });
    expect(proposeQueryBinding(capability(), trace, IDENTITY).warnings.join(" ")).toMatch(/no search term was typed/i);
  });

  it("refuses when the platform cannot identify entities at all", () => {
    // A search that cannot return an identity returns nothing a mutation
    // could be gated on, which is the entire point of the pair.
    const proposal = proposeQueryBinding(capability(), searchTrace(), undefined);
    expect(proposal.binding).toBeNull();
    expect(proposal.warnings.join(" ")).toMatch(/does not declare how it identifies entities/i);
  });
});

/* ------------------------------------------------------------------ *
 * The answer that was missing.
 *
 * A live attempt to teach a search was asked "What is the API name for
 * the field labelled 'Search...' on Opportunity?" — a question with no
 * true answer, since a global search box is not a field on any record.
 * The only way past it was to name a field that does not exist.
 * ------------------------------------------------------------------ */

describe("a control that is not a record field can say so", () => {
  const searchCapability = (role?: "query"): SemanticCapability => ({
    id: "search_sales_records",
    name: "Search sales records",
    description: "Search and open a record.",
    inputs: [{ name: "search", description: "The term", type: "string", required: true, ...(role ? { role } : {}) }],
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: true, requiresConfirmation: false }
  });

  it("asks for an API name while the input reads as a record field", async () => {
    const { groundCapability } = await import("../src/training/semanticGrounding");
    const { applicationIntelligenceForPlatform } = await import("../src/binding/browserExecution/adapters");
    const { emptyTenantIntelligence } = await import("../src/applicationIntelligence/tenant");
    const intelligence = applicationIntelligenceForPlatform(PLATFORM, emptyTenantIntelligence());

    const grounded = groundCapability(searchCapability(), searchTrace(), intelligence);
    // The live dead end: a question whose only permitted answer is false.
    expect(grounded.needs.some((need) => need.kind === "field-api-name")).toBe(true);
  });

  it("stops asking once the input is classified as a query control", async () => {
    const { groundCapability } = await import("../src/training/semanticGrounding");
    const { applicationIntelligenceForPlatform } = await import("../src/binding/browserExecution/adapters");
    const { emptyTenantIntelligence } = await import("../src/applicationIntelligence/tenant");
    const intelligence = applicationIntelligenceForPlatform(PLATFORM, emptyTenantIntelligence());

    const grounded = groundCapability(searchCapability("query"), searchTrace(), intelligence);
    expect(grounded.needs).toEqual([]);
    // And it is not reported as a field that failed to ground, because it
    // is not a field.
    expect(grounded.unresolved).not.toContain("search");
    expect(grounded.noncanonical).not.toContain("search");
    // The name is kept; classifying is not answering.
    expect(grounded.capability.inputs[0]).toMatchObject({ name: "search", role: "query" });
  });

  it("carries the classified input into the query binding", () => {
    const binding = proposeQueryBinding(searchCapability("query"), searchTrace(), IDENTITY).binding!;
    expect(binding.query.inputName).toBe("search");
  });
});

/* ------------------------------------------------------------------ *
 * A search is publishable on its own terms.
 *
 * It has nothing to commit and no record to verify, so it can never
 * satisfy a mutation route's proof. Refusing to publish it on that basis
 * would be demanding evidence of a change it does not perform.
 * ------------------------------------------------------------------ */

describe("an accepted search unblocks publication by itself", () => {
  const confirmed = (): SemanticCapability => ({
    id: "search_opportunities",
    name: "Search opportunities",
    description: "Find opportunities by name.",
    inputs: [{ name: "name", description: "The term", type: "string", required: true, role: "query" }],
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: true, requiresConfirmation: false }
  });

  it("stays blocked while nothing has been accepted", async () => {
    const { deriveStudioLifecycle } = await import("../src/training/studioLifecycle");
    const view = deriveStudioLifecycle({
      capability: confirmed(),
      advertisedBound: false,
      bindingCandidate: undefined,
      validation: undefined,
      published: false
    });
    expect(view.publication.canPublish).toBe(false);
  });

  it("becomes publishable once the search is accepted", async () => {
    const { deriveStudioLifecycle } = await import("../src/training/studioLifecycle");
    const view = deriveStudioLifecycle({
      capability: confirmed(),
      advertisedBound: false,
      bindingCandidate: undefined,
      validation: undefined,
      queryAccepted: true,
      published: false
    });
    expect(view.publication.canPublish).toBe(true);
  });

  it("still requires human confirmation first", async () => {
    const { deriveStudioLifecycle } = await import("../src/training/studioLifecycle");
    const view = deriveStudioLifecycle({
      capability: { ...confirmed(), provenance: { ...confirmed().provenance, confirmedByHuman: false } },
      advertisedBound: false,
      bindingCandidate: undefined,
      validation: undefined,
      queryAccepted: true,
      published: false
    });
    expect(view.publication.canPublish).toBe(false);
  });
});
