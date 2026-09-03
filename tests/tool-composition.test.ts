import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import { groundCapability } from "../src/training/semanticGrounding";
import { confirmCandidate } from "../src/training/semanticizer";
import { semanticContract } from "../src/training/semanticContract";
import { compositionHintsFor, identityProductions, identityRequirements } from "../src/semantic/composition";
import { applicationIntelligenceForPlatform } from "../src/binding/browserExecution/adapters";
import { emptyTenantIntelligence } from "../src/applicationIntelligence/tenant";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import { compileCapability } from "../src/webmcp/compiler";
import {
  assertPublishable,
  parsePublicationRecord,
  publishedCapabilityContract,
  type PublicationRecord
} from "../src/webmcp/publication";
import type { SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * Two tools that need each other, and no field in WebMCP to say so.
 *
 * `update_opportunity` requires `opportunity_id`. An agent holding a
 * company name and no id cannot learn, from that tool alone, that another
 * published tool hands out exactly those ids. WebMCP offers no dependency
 * edge, so the relationship has to be said in the metadata an agent
 * already reads — and it has to be TRUE, which means derived from the two
 * contracts and from what is actually published, never from a model
 * deciding the tools sound related.
 *
 * The invariant that shapes every sentence below: a search returns
 * CANDIDATES. Telling an agent to "find the Opportunity and update it"
 * would promise a uniqueness the search does not have, so the hint stops
 * at handing over candidates and leaves the choosing where it belongs.
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";
const SALESFORCE = sourceApplicationFor(PLATFORM, "nvent-dev-ed.lightning.force.com");
const HOST = "nvent-dev-ed.lightning.force.com";
const recordPage = { host: HOST, path: "/lightning/r/Opportunity/0065w00002AZ0GeAAL/view" };
const listPage = { host: HOST, path: "/lightning/o/Opportunity/list" };
/** The live search recording ended here: an id, with no object segment in it. */
const searchLanding = { host: HOST, path: "/lightning/r/0065w00002AZ0GeAAL/view" };

const KNOWN = applicationIntelligenceForPlatform(PLATFORM, emptyTenantIntelligence());

function mutationTrace() {
  const session = new CaptureSession("sess-update", 0, { host: HOST, platform: PLATFORM, title: "Opportunity" });
  session.addMany([
    { id: "nav", kind: "navigate", t: 100, page: recordPage },
    {
      id: "stage-change",
      kind: "field_change",
      t: 2_500,
      page: recordPage,
      element: { tag: "lightning-combobox", label: "*Stage" },
      field: { label: "*Stage", section: "Opportunity Details", control: "other" },
      value: { masked: false, to: "Negotiation/Review" }
    },
    {
      id: "close-date-change",
      kind: "field_change",
      t: 2_700,
      page: recordPage,
      element: { tag: "lightning-datepicker", label: "*Close Date" },
      field: { label: "*Close Date", section: "Opportunity Details", control: "other" },
      value: { masked: false, to: "2027-03-01" }
    },
    { id: "save", kind: "click", t: 3_000, page: recordPage, actionLabel: "Save" }
  ]);
  session.stop(4_000);
  return session.toTrace();
}

function searchTrace() {
  const session = new CaptureSession("sess-search", 0, { host: HOST, platform: PLATFORM, title: "Opportunity" });
  session.addMany([
    { id: "nav", kind: "navigate", t: 100, page: listPage },
    {
      id: "open",
      kind: "click",
      t: 500,
      page: listPage,
      element: { tag: "button", label: "Search" },
      actionLabel: "Search"
    },
    {
      id: "term",
      kind: "field_change",
      t: 2_000,
      page: listPage,
      element: { tag: "input", label: "Search..." },
      field: { label: "Search...", section: "", control: "text" },
      value: { masked: false, to: "PS Project" }
    },
    { id: "record", kind: "navigate", t: 3_000, page: searchLanding }
  ]);
  session.stop(4_000);
  return session.toTrace();
}

/** The published `update_opportunity`, walked through the real lifecycle. */
function updateCapability(overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  const proposed: SemanticCapability = {
    id: "update_opportunity",
    name: "Update opportunity",
    description: "Updates an existing Salesforce Opportunity's stage and close date.",
    inputs: [
      { name: "stage", description: "Sales stage the deal has reached.", type: "string", required: true },
      { name: "close_date", description: "Date the deal is expected to close.", type: "date", required: true }
    ],
    outputs: [],
    provenance: { source: "inferred", observationIds: [], confirmedByHuman: false, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true },
    ...overrides
  };
  return confirmCandidate({
    ...groundCapability(proposed, mutationTrace(), KNOWN).capability,
    binding: { application: SALESFORCE.id, action: "update_opportunity" }
  });
}

/** The published `search_opportunities`, likewise. */
function searchCapability(overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  const proposed: SemanticCapability = {
    id: "search_opportunities",
    name: "Search opportunities",
    description: "Searches Salesforce Opportunities by name, account, or status.",
    inputs: [
      { name: "name", description: "Opportunity name to look for.", type: "string", required: true, role: "query" },
      { name: "account_name", description: "Account the opportunity belongs to.", type: "string", required: false }
    ],
    outputs: [],
    provenance: { source: "inferred", observationIds: [], confirmedByHuman: false, sourceApplication: SALESFORCE },
    safety: { readOnly: true, requiresConfirmation: false },
    ...overrides
  };
  return confirmCandidate({
    ...groundCapability(proposed, searchTrace(), KNOWN).capability,
    binding: { application: SALESFORCE.id, action: "search_opportunities" }
  });
}

/** A search for something else entirely, built directly: only its contract matters here. */
const accountSearch: SemanticCapability = {
  id: "search_accounts",
  name: "Search accounts",
  description: "Searches Accounts by name.",
  inputs: [{ name: "name", description: "Account name to look for.", type: "string", required: true, role: "query" }],
  outputs: [
    {
      name: "candidates",
      description: "Matching Account records.",
      type: "array",
      role: "entity-identity",
      entityType: "Account"
    }
  ],
  binding: { application: SALESFORCE.id, action: "search_accounts" },
  provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
  safety: { readOnly: true, requiresConfirmation: false }
};

const compile = (capability: SemanticCapability, peers: SemanticCapability[] = []) =>
  compileCapability(capability, () => ({}), peers);

/* ============ 1 & 2. the one annotation WebMCP gives us ============ */

describe("1 & 2 — read/write semantics use the supported annotation and nothing else", () => {
  it("marks the search read-only", () => {
    expect(compile(searchCapability(), [updateCapability()]).annotations.readOnlyHint).toBe(true);
  });

  it("does not mark the mutation read-only", () => {
    expect(compile(updateCapability(), [searchCapability()]).annotations.readOnlyHint).toBe(false);
  });
});

/* ====== 3 & 4. what the search says about what it hands back ====== */

describe("3 & 4 — the search is honest about cardinality and about identity", () => {
  const tool = () => compile(searchCapability(), [updateCapability()]);

  it("says it may return several candidates", () => {
    expect(tool().description).toContain("May return zero, one, or several matching Opportunity candidates");
  });

  it("says each candidate carries a stable record identity", () => {
    expect(tool().description).toContain(
      "Each candidate carries the Opportunity record identity that identity-gated tools require."
    );
  });

  it("declares that identity structurally, so another contract can be matched against it", () => {
    const produced = identityProductions(searchCapability());
    expect(produced).toEqual([
      { capabilityId: "search_opportunities", entityType: "Opportunity", outputName: "candidates", readOnly: true }
    ]);
  });

  it("names the consumer that needs what it produces", () => {
    expect(tool().description).toContain(
      "The identity on each candidate is what update_opportunity needs in order to act on one specific " +
        "Opportunity (opportunity_id)."
    );
  });
});

/* ============ 5, 6, 7. what the update says it needs ============ */

describe("5, 6 & 7 — the update states its requirement, and points somewhere only when there is somewhere", () => {
  it("states that an exact identity is required", () => {
    const tool = compile(updateCapability(), [searchCapability()]);
    expect(tool.description).toContain("Requires opportunity_id: the Opportunity record identity to act on.");
    expect(tool.description).toContain("Refuses to write anything unless that Opportunity is the record");
    expect(tool.inputSchema.required).toContain("opportunity_id");
  });

  it("declares the requirement structurally", () => {
    expect(identityRequirements(updateCapability())).toEqual([
      { inputName: "opportunity_id", entityType: "Opportunity" }
    ]);
  });

  it("adds the search hint only when a compatible search is actually published", () => {
    const alone = compile(updateCapability());
    expect(alone.description).not.toContain("search_opportunities");
    expect(alone.inputSchema.properties["opportunity_id"].description).not.toContain("search_opportunities");

    const together = compile(updateCapability(), [searchCapability()]);
    expect(together.description).toContain(
      "If opportunity_id is not already known, search_opportunities returns candidate Opportunity records; " +
        "choose the intended one and pass its identity here."
    );
  });

  it("hints on the identity input itself, after the description a human confirmed", () => {
    const property = compile(updateCapability(), [searchCapability()]).inputSchema.properties["opportunity_id"];
    const confirmed = updateCapability().inputs.find((input) => input.role === "target-identity")?.description ?? "";

    expect(property.description.startsWith(confirmed)).toBe(true);
    expect(property.description).toContain(
      "If unknown, search_opportunities returns candidate Opportunity records to choose from."
    );
  });

  it("never suggests a tool to itself", () => {
    const search = searchCapability();
    expect(compositionHintsFor(search, [search])).toEqual({ tool: [], inputs: {} });
  });
});

/* ============ 8 & 9. a hint that is not true is not shown ============ */

describe("8 & 9 — hints track reality", () => {
  it("drops the search hint once the search is no longer published", () => {
    const published = [searchCapability()];
    expect(compile(updateCapability(), published).description).toContain("search_opportunities");

    // Unpublished: the surviving capability set no longer contains it, so
    // the next registration carries no hint about a tool nobody can call.
    const afterUnpublish = published.filter((capability) => capability.id !== "search_opportunities");
    const tool = compile(updateCapability(), afterUnpublish);
    expect(tool.description).not.toContain("search_opportunities");
    expect(tool.inputSchema.properties["opportunity_id"].description).not.toContain("search_opportunities");
    // What the runtime enforces is unaffected — that never depended on a peer.
    expect(tool.description).toContain("Requires opportunity_id");
  });

  it("does not suggest a search that produces a different entity's identity", () => {
    const tool = compile(updateCapability(), [accountSearch]);
    expect(tool.description).not.toContain("search_accounts");
    expect(tool.inputSchema.properties["opportunity_id"].description).not.toContain("search_accounts");

    // And the Account search is not told it feeds an Opportunity tool.
    expect(compile(accountSearch, [updateCapability()]).description).not.toContain("update_opportunity");
  });

  it("derives the same relation for entity types it has never been told about", () => {
    const ticketSearch: SemanticCapability = {
      ...accountSearch,
      id: "find_tickets",
      outputs: [{ ...accountSearch.outputs[0], entityType: "Ticket" }]
    };
    const ticketUpdate: SemanticCapability = {
      ...updateCapability(),
      id: "close_ticket",
      inputs: [
        {
          name: "ticket_id",
          description: "The Ticket to close.",
          type: "string",
          required: true,
          role: "target-identity",
          entityType: "Ticket"
        }
      ]
    };
    const hints = compositionHintsFor(ticketUpdate, [ticketSearch]);

    expect(hints.tool).toEqual([
      "If ticket_id is not already known, find_tickets returns candidate Ticket records; choose the intended one " +
        "and pass its identity here."
    ]);
    expect(hints.inputs["ticket_id"]).toBe(
      "If unknown, find_tickets returns candidate Ticket records to choose from."
    );
  });

  it("names every producer when more than one hands out the same identity", () => {
    const secondSearch = { ...searchCapability(), id: "list_my_opportunities" };
    const hints = compositionHintsFor(updateCapability(), [searchCapability(), secondSearch]);
    expect(hints.tool[0]).toContain("search_opportunities or list_my_opportunities");
  });
});

/* ============ 10. ambiguity survives the hint ============ */

describe("10 — a hint never implies the search picked one", () => {
  const both = [searchCapability(), updateCapability()];

  it("hands over candidates and leaves the choosing to the caller", () => {
    const update = compile(updateCapability(), both).description;
    expect(update).toContain("choose the intended one");
    expect(update).toMatch(/candidate Opportunity records/);
  });

  it("never tells an agent to search and then act on the result", () => {
    for (const tool of [compile(searchCapability(), both), compile(updateCapability(), both)]) {
      // The phrasings that would promise uniqueness or automatic selection.
      expect(tool.description).not.toMatch(/find the opportunity and/i);
      expect(tool.description).not.toMatch(/\bthen update (it|the)\b/i);
      expect(tool.description).not.toMatch(/\bthe matching opportunity\b/i);
      expect(tool.description).not.toMatch(/\b(exactly one|a single|the unique|the only)\b/i);
    }
  });
});

/* ====== 11 & 12. whose words are whose, after everything ====== */

describe("11 & 12 — the human's meaning survives, the system's facts are not displaced", () => {
  it("keeps a user-authored business description at the front of what an agent reads", () => {
    const edited = updateCapability({ description: "Moves a deal forward in the pipeline." });
    const tool = compile(edited, [searchCapability()]);

    expect(tool.description.startsWith("Moves a deal forward in the pipeline.")).toBe(true);
    expect(tool.description).toContain("Requires opportunity_id");
    expect(tool.description).toContain("search_opportunities");
  });

  it("keeps a user-authored input description ahead of the composition hint", () => {
    const base = updateCapability();
    const edited: SemanticCapability = {
      ...base,
      inputs: base.inputs.map((input) =>
        input.role === "target-identity" ? { ...input, description: "The deal record to change." } : input
      )
    };
    const property = compile(edited, [searchCapability()]).inputSchema.properties["opportunity_id"];

    expect(property.description.startsWith("The deal record to change.")).toBe(true);
    expect(property.description).toContain("If unknown, search_opportunities returns candidate");
  });

  it("does not let free-form model output displace what the runtime enforces", () => {
    // A model that decided this tool was read-only and needed nothing.
    const boastful = updateCapability({
      description: "Updates an Opportunity. This tool is read-only and requires no identity."
    });
    const tool = compile(boastful, [searchCapability()]);

    expect(tool.description).not.toContain("read-only");
    expect(tool.description).not.toContain("requires no identity");
    expect(tool.description).toContain("Refuses to write anything");
    expect(tool.annotations.readOnlyHint).toBe(false);
  });

  it("says a sentence once, however it got into the description", () => {
    const hint =
      "If opportunity_id is not already known, search_opportunities returns candidate Opportunity records; " +
      "choose the intended one and pass its identity here.";
    // Someone pasted what the Studio showed them into the description itself.
    const pasted = updateCapability({ description: `${updateCapability().description} ${hint}` });
    const description = compile(pasted, [searchCapability()]).description;

    expect(description.split(hint).length - 1).toBe(1);
  });

  it("leaves the confirmed contract untouched: a hint is metadata, never a stored edit", () => {
    const capability = updateCapability();
    const before = semanticContract(capability);
    compile(capability, [searchCapability()]);

    expect(semanticContract(capability)).toBe(before);
    // And a peer appearing or disappearing changes nothing a human confirmed.
    expect(semanticContract(updateCapability())).toBe(before);
  });
});

/* ====== contracts published before the declarations existed ====== */

describe("a published pair predating these declarations still composes", () => {
  /** The real shape in `.autowebmcp/publications.json`: no entityType, no declared output. */
  const legacyUpdate: SemanticCapability = {
    id: "update_opportunity_stage_and_close_date",
    name: "Update opportunity stage and close date",
    description: "Modify an existing opportunity by changing its stage and close date, then save.",
    inputs: [
      {
        name: "opportunity_id",
        description: "Which Opportunity to act on — the application's own record identity.",
        type: "string",
        required: true,
        role: "target-identity"
      },
      { name: "stage", description: "The opportunity stage to set.", type: "string", required: true }
    ],
    outputs: [{ name: "opportunity", description: "The updated opportunity record.", type: "object" }],
    binding: { application: SALESFORCE.id, action: "update_opportunity_stage_and_close_date" },
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true }
  };
  const legacySearch: SemanticCapability = {
    id: "search_opportunities_list",
    name: "Search opportunities list",
    description: "Search the Opportunities list using a text query.",
    inputs: [{ name: "name", description: "Text entered into the search field.", type: "string", required: false }],
    outputs: [{ name: "opportunities", description: "Filtered opportunity records.", type: "array" }],
    binding: { application: SALESFORCE.id, action: "search_opportunities_list" },
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: true, requiresConfirmation: false }
  };

  const updateRecord = {
    capability: legacyUpdate,
    publishedAt: "2026-09-01T00:00:00.000Z",
    executionBinding: {
      context: { recordType: "Opportunity", target: { inputName: "opportunity_id", entityType: "Opportunity" } }
    }
  } as unknown as PublicationRecord;
  const searchRecord = {
    capability: legacySearch,
    publishedAt: "2026-09-01T00:00:00.000Z",
    queryBinding: { entityType: "Opportunity" }
  } as unknown as PublicationRecord;

  it("recovers the entity a targeting parameter selects from the accepted execution binding", () => {
    const recovered = publishedCapabilityContract(updateRecord);
    expect(identityRequirements(recovered)).toEqual([{ inputName: "opportunity_id", entityType: "Opportunity" }]);
    // The confirmed contract itself is untouched — this is a view for registration.
    expect(identityRequirements(legacyUpdate)).toEqual([]);
  });

  it("recovers what a search produces from the accepted query binding", () => {
    const recovered = publishedCapabilityContract(searchRecord);
    expect(identityProductions(recovered)).toEqual([
      { capabilityId: "search_opportunities_list", entityType: "Opportunity", outputName: "candidates", readOnly: true }
    ]);
    // The model's own output description is kept, not rewritten.
    expect(recovered.outputs[0]).toEqual(legacySearch.outputs[0]);
  });

  it("pairs them, so an already-published capability gains the hint without being taught again", () => {
    const peers = [updateRecord, searchRecord].map(publishedCapabilityContract);
    const tool = compile(publishedCapabilityContract(updateRecord), peers);

    expect(tool.description).toContain(
      "If opportunity_id is not already known, search_opportunities_list returns candidate Opportunity records"
    );
    expect(tool.inputSchema.properties["opportunity_id"].description).toContain(
      "If unknown, search_opportunities_list returns candidate Opportunity records to choose from."
    );
  });

  it("adds nothing to a record whose bindings establish nothing", () => {
    const bare = { capability: legacyUpdate, publishedAt: "2026-09-01T00:00:00.000Z" } as PublicationRecord;
    expect(publishedCapabilityContract(bare)).toBe(legacyUpdate);
  });

  it("never overwrites a declaration the contract already carries", () => {
    const declared = publishedCapabilityContract({
      capability: searchCapability(),
      publishedAt: "2026-09-01T00:00:00.000Z",
      queryBinding: { entityType: "Account" }
    } as unknown as PublicationRecord);
    // The contract says Opportunity; a binding is not allowed to redefine it.
    expect(identityProductions(declared)).toEqual([
      { capabilityId: "search_opportunities", entityType: "Opportunity", outputName: "candidates", readOnly: true }
    ]);
  });
});

/* ====== 13 & 14. nothing invented, nothing broken ====== */

describe("13 & 14 — only supported WebMCP fields, and existing contracts still hold", () => {
  it("emits no tool field and no annotation the implementation does not support", () => {
    const tool = compile(searchCapability(), [updateCapability()]);

    expect(Object.keys(tool).sort()).toEqual(["annotations", "description", "execute", "inputSchema", "name"]);
    // `readOnlyHint` is the only annotation this codebase's WebMCP surface
    // carries. A composition edge has no field here and must not invent one.
    expect(Object.keys(tool.annotations)).toEqual(["readOnlyHint"]);
    expect(Object.keys(tool.inputSchema).sort()).toEqual([
      "additionalProperties",
      "properties",
      "required",
      "type"
    ]);
  });

  it("emits no unsupported keys inside an input schema property", () => {
    const capability = updateCapability();
    const withEnum: SemanticCapability = {
      ...capability,
      inputs: capability.inputs.map((input) =>
        input.name === "stage" ? { ...input, enum: ["Prospecting", "Closed Won"] } : input
      )
    };
    const schema = compile(withEnum, [searchCapability()]).inputSchema;

    for (const property of Object.values(schema.properties)) {
      expect(Object.keys(property).every((key) => ["type", "description", "enum", "format"].includes(key))).toBe(true);
    }
    // The structured identity declaration lives in the capability model,
    // which WebMCP has no output schema for — so it must not leak out here.
    expect(JSON.stringify(schema)).not.toContain("entity-identity");
  });

  it("keeps published schemas valid: gate, round-trip, and shape are unchanged", () => {
    const capability = updateCapability();
    expect(() => assertPublishable(capability)).not.toThrow();

    const record = parsePublicationRecord(
      JSON.parse(JSON.stringify({ capability, publishedAt: "2026-09-03T00:00:00.000Z" }))
    );
    expect(record.capability.id).toBe("update_opportunity");
    // The structured additions survive serialization, because that is where
    // the relation is read from on the next page load.
    expect(record.capability.inputs.find((input) => input.role === "target-identity")?.entityType).toBe(
      "Opportunity"
    );

    const schema = compile(searchCapability(), [capability]).inputSchema;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["name"]);
  });

  it("compiles identically to before when nothing else is published", () => {
    const capability = updateCapability();
    expect(compile(capability)).toMatchObject({
      name: "update_opportunity",
      description: capability.description
    });
  });
});
