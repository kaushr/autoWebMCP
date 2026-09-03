import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import { groundCapability } from "../src/training/semanticGrounding";
import { confirmCandidate } from "../src/training/semanticizer";
import { contractChanged } from "../src/training/semanticContract";
import { executionGuarantees } from "../src/training/executionSemantics";
import { claimsRuntimeBehaviour, composeDescription } from "../src/semantic/description";
import { applicationIntelligenceForPlatform } from "../src/binding/browserExecution/adapters";
import { emptyTenantIntelligence } from "../src/applicationIntelligence/tenant";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import { compileCapability } from "../src/webmcp/compiler";
import { assertSafetyMatchesBindings } from "../src/webmcp/publication";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";
import type { CaptureEvent } from "../src/capture/types";
import type { SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * The description is part of the contract, and it has two authors.
 *
 * A demonstration is evidence of INTENT — a rep edited Stage, edited
 * Close Date, and saved — and a model reading it can honestly say the
 * capability updates an Opportunity's stage and close date. What the
 * model cannot know is what the RUNTIME will do: whether an identity is
 * required, whether a mismatch refuses, whether anything is written at
 * all, whether one result comes back or several. Every one of those is a
 * promise something later has to keep.
 *
 * So these tests assert the split, in both directions: that the business
 * half survives and reaches an agent, and that the runtime half can only
 * ever be written by the system that enforces it.
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";
const SALESFORCE = sourceApplicationFor(PLATFORM, "nvent-dev-ed.lightning.force.com");
const HOST = "nvent-dev-ed.lightning.force.com";
const recordPage = { host: HOST, path: "/lightning/r/Opportunity/0065w00002AZ0GeAAL/view" };
const listPage = { host: HOST, path: "/lightning/o/Opportunity/list" };
/** The live search recording ended here: an id, with no object segment anywhere in it. */
const searchLanding = { host: HOST, path: "/lightning/r/0065w00002AZ0GeAAL/view" };

const KNOWN_PLATFORM = applicationIntelligenceForPlatform(PLATFORM, emptyTenantIntelligence());
/** A platform with no pack: nothing declares an identity, so nothing can be promised about one. */
const UNKNOWN_PLATFORM = applicationIntelligenceForPlatform("acme-crm", emptyTenantIntelligence());

/** The real Teach Mode shape for a record edit: two fields changed, then Save. */
function mutationTrace() {
  const session = new CaptureSession("sess-update", 0, {
    host: HOST,
    platform: PLATFORM,
    title: "PS Project Test | Opportunity"
  });
  session.addMany([
    { id: "nav", kind: "navigate", t: 100, page: recordPage },
    {
      id: "close-date-change",
      kind: "field_change",
      t: 1_500,
      page: recordPage,
      element: { tag: "lightning-datepicker", label: "*Close Date" },
      field: { label: "*Close Date", section: "Opportunity Details", control: "other" },
      value: { masked: false, to: "2027-03-01" }
    },
    {
      id: "stage-change",
      kind: "field_change",
      t: 2_500,
      page: recordPage,
      element: { tag: "lightning-combobox", label: "*Stage" },
      field: { label: "*Stage", section: "Opportunity Details", control: "other" },
      value: { masked: false, to: "Negotiation/Review" }
    },
    { id: "save", kind: "click", t: 3_000, page: recordPage, actionLabel: "Save" }
  ]);
  session.stop(4_000);
  return session.toTrace();
}

/** The real Teach Mode shape for a search: a term typed, no commit, a record opened. */
function searchTrace() {
  const session = new CaptureSession("sess-search", 0, {
    host: HOST,
    platform: PLATFORM,
    title: "PS Project Test | Opportunity | Salesforce"
  });
  const events: CaptureEvent[] = [
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
  ];
  session.addMany(events);
  session.stop(4_000);
  return session.toTrace();
}

/** What the semanticizer hands over for the edit demonstration. */
function proposedUpdate(overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  return {
    id: "update_opportunity",
    name: "Update opportunity",
    description: "Updates an existing Salesforce Opportunity's stage and close date.",
    inputs: [
      { name: "stage", description: "The sales stage the deal has reached.", type: "string", required: true },
      { name: "close_date", description: "When the deal is expected to close.", type: "date", required: true }
    ],
    outputs: [],
    provenance: { source: "inferred", observationIds: [], confirmedByHuman: false, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true },
    ...overrides
  };
}

/** And for the search demonstration. */
function proposedSearch(overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  return {
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
}

const describedInput = (capability: SemanticCapability, name: string) =>
  capability.inputs.find((input) => input.name === name);

/* =============== 1 & 2. the model's half survives =============== */

describe("1 & 2 — a demonstration yields a business description and described inputs", () => {
  it("keeps the inferred business intent as the first thing an agent reads", () => {
    const grounded = groundCapability(proposedUpdate(), mutationTrace(), KNOWN_PLATFORM);

    expect(grounded.descriptionComposition.intent).toBe(
      "Updates an existing Salesforce Opportunity's stage and close date."
    );
    expect(grounded.capability.description.startsWith(grounded.descriptionComposition.intent)).toBe(true);
    // Not a name restated, and not empty: a sentence about the outcome.
    expect(grounded.capability.description.length).toBeGreaterThan(grounded.capability.name.length);
  });

  it("carries a description for every demonstrated input", () => {
    const grounded = groundCapability(proposedUpdate(), mutationTrace(), KNOWN_PLATFORM);

    for (const input of grounded.capability.inputs) {
      expect(input.description.trim()).not.toBe("");
    }
    expect(describedInput(grounded.capability, "stage")?.description).toBe("The sales stage the deal has reached.");
    expect(describedInput(grounded.capability, "close_date")?.description).toBe(
      "When the deal is expected to close."
    );
  });

  it("derives a description for an input the model left undescribed, rather than publishing a blank one", () => {
    const undescribed = proposedUpdate({
      inputs: [
        { name: "stage", description: "", type: "string", required: true },
        { name: "close_date", description: "   ", type: "date", required: true }
      ]
    });
    const grounded = groundCapability(undescribed, mutationTrace(), KNOWN_PLATFORM);

    // Derived from the demonstration, not invented: the recording saved a
    // record, so these are values being set on one.
    expect(describedInput(grounded.capability, "stage")?.description).toBe("Stage to set on the Opportunity.");
    expect(describedInput(grounded.capability, "close_date")?.description).toBe(
      "Close date to set on the Opportunity."
    );
  });

  it("describes a search's inputs as narrowing a search rather than setting a value", () => {
    const undescribed = proposedSearch({
      inputs: [
        { name: "name", description: "", type: "string", required: true, role: "query" },
        { name: "account_name", description: "", type: "string", required: false }
      ]
    });
    const grounded = groundCapability(undescribed, searchTrace(), KNOWN_PLATFORM);

    expect(describedInput(grounded.capability, "name")?.description).toBe(
      "Search term used to find matching Opportunity records."
    );
    expect(describedInput(grounded.capability, "account_name")?.description).toBe(
      "Account name used to narrow the Opportunity search."
    );
  });
});

/* ========= 3. the input nobody demonstrated describes itself ========= */

describe("3 — the system-added target identity carries a system-derived description", () => {
  it("describes the identity parameter from platform knowledge, not from the demonstration", () => {
    const grounded = groundCapability(proposedUpdate(), mutationTrace(), KNOWN_PLATFORM);
    const identity = grounded.capability.inputs.find((input) => input.role === "target-identity");

    expect(identity).toMatchObject({ name: "opportunity_id", required: true });
    expect(identity?.description).toContain("Opportunity record identity");
    // Says what the runtime does with it, because the runtime does it.
    expect(identity?.description).toContain("before anything is written");
    expect(identity?.description).toContain("after saving");
    // And it is the same description the target-identity machinery gives
    // the rest of the pipeline — one source, not a second copy.
    expect(identity?.description).toBe(grounded.targetIdentity?.description);
  });

  it("does not invent an identity parameter for a platform that declares no identity scheme", () => {
    const grounded = groundCapability(proposedUpdate(), mutationTrace(), UNKNOWN_PLATFORM);

    expect(grounded.capability.inputs.some((input) => input.role === "target-identity")).toBe(false);
    expect(grounded.capability.description).not.toContain("Requires");
    expect(grounded.descriptionComposition.guarantees).toEqual([]);
  });
});

/* ============ 4. the model may not promise anything ============ */

describe("4 — runtime guarantees cannot be fabricated by the semantic model", () => {
  it("strips guarantee claims the model wrote and keeps only the intent", () => {
    const boastful = proposedUpdate({
      description:
        "Updates an existing Salesforce Opportunity's stage and close date. " +
        "This tool is read-only and never modifies records. " +
        "It is idempotent and safe to retry. " +
        "It requires no identity and always succeeds."
    });
    const grounded = groundCapability(boastful, mutationTrace(), KNOWN_PLATFORM);

    expect(grounded.descriptionComposition.intent).toBe(
      "Updates an existing Salesforce Opportunity's stage and close date."
    );
    expect(grounded.descriptionComposition.rejectedClaims).toHaveLength(3);
    expect(grounded.capability.description).not.toContain("read-only");
    expect(grounded.capability.description).not.toContain("idempotent");
    expect(grounded.capability.description).not.toContain("always succeeds");
    // The contradiction is the point: a mutation that claimed to be
    // read-only ends up carrying the opposite guarantee, from code.
    expect(grounded.capability.description).toContain("Refuses to write anything");
  });

  it("refuses a model claim inside an input description too", () => {
    const boastful = proposedUpdate({
      inputs: [
        {
          name: "stage",
          description: "The sales stage the deal has reached. Validated against the picklist before saving.",
          type: "string",
          required: true
        },
        { name: "close_date", description: "When the deal is expected to close.", type: "date", required: true }
      ]
    });
    const grounded = groundCapability(boastful, mutationTrace(), KNOWN_PLATFORM);

    expect(describedInput(grounded.capability, "stage")?.description).toBe(
      "The sales stage the deal has reached."
    );
  });

  it("emits no guarantee without code that enforces it", () => {
    for (const guarantee of executionGuarantees({
      targetIdentity: { inputName: "ticket_id", entityType: "Ticket", description: "d" },
      readOnly: false
    })) {
      expect(guarantee.enforcedBy.trim().length).toBeGreaterThan(0);
      // Every generated sentence must itself read as a guarantee claim, or
      // an older wording could survive a re-grounding as if it were intent.
      expect(claimsRuntimeBehaviour(guarantee.statement)).toBe(true);
    }
  });

  it("composes the same text however many times grounding runs", () => {
    const once = groundCapability(proposedUpdate(), mutationTrace(), KNOWN_PLATFORM);
    const twice = groundCapability(once.capability, mutationTrace(), KNOWN_PLATFORM);
    const thrice = groundCapability(twice.capability, mutationTrace(), KNOWN_PLATFORM);

    expect(twice.capability.description).toBe(once.capability.description);
    expect(thrice.capability.description).toBe(once.capability.description);
    // And a re-run does not report the system's own sentences as claims
    // the model tried to make.
    expect(twice.descriptionComposition.rejectedClaims).toEqual([]);
  });
});

/* ============ 5 & 6. what a search may honestly say ============ */

describe("5 & 6 — a search's description is honest about cardinality and about writing", () => {
  const grounded = () => groundCapability(proposedSearch(), searchTrace(), KNOWN_PLATFORM);

  it("says it may return several candidates and never chooses between them", () => {
    const description = grounded().capability.description;
    expect(description).toContain("May return zero, one, or several matching Opportunity candidates");
    expect(description).toContain("never chooses between them");
    // The entity type came from the platform's declared identifier
    // prefixes: the live recording ended on a route with no object segment.
    expect(description).not.toContain("0065w00002AZ0GeAAL");
  });

  it("says it is read-only", () => {
    expect(grounded().capability.description).toContain(
      "Read-only: it does not create, modify, or delete anything in the application."
    );
  });

  it("promises the identity a later mutation needs", () => {
    expect(grounded().capability.description).toContain(
      "Each candidate carries the Opportunity record identity that identity-gated tools require."
    );
  });

  it("adds no identity requirement to a capability that writes nothing", () => {
    const capability = grounded().capability;
    expect(capability.inputs.some((input) => input.role === "target-identity")).toBe(false);
    expect(capability.description).not.toContain("Refuses to write");
  });

  it("holds the read-only claim to something: a mutation binding cannot be published under it", () => {
    const capability = grounded().capability;
    const mutation = { id: "b", capabilityId: capability.id } as unknown as BrowserExecutionBinding;
    expect(() => assertSafetyMatchesBindings(capability, mutation)).toThrow(/read-only/i);
    expect(() => assertSafetyMatchesBindings(capability)).not.toThrow();
  });
});

/* ====== 7. what an update may honestly say, and only when true ====== */

describe("7 — an update states its identity requirement exactly when the runtime enforces one", () => {
  it("names the identity parameter it will refuse without", () => {
    const description = groundCapability(proposedUpdate(), mutationTrace(), KNOWN_PLATFORM).capability.description;

    expect(description).toContain("Requires opportunity_id: the Opportunity record identity to act on.");
    expect(description).toContain(
      "Refuses to write anything unless that Opportunity is the record the application currently has open"
    );
    expect(description).toContain("re-checks the identity after saving");
    expect(description).not.toContain("Read-only");
  });

  it("says nothing about identity where nothing would enforce it", () => {
    const description = groundCapability(proposedUpdate(), mutationTrace(), UNKNOWN_PLATFORM).capability.description;
    expect(description).toBe("Updates an existing Salesforce Opportunity's stage and close date.");
  });

  it("says nothing about identity for a demonstration that never saved anything", () => {
    // A trace with no commit is not a mutation, whatever the model called it.
    const description = groundCapability(proposedUpdate(), searchTrace(), KNOWN_PLATFORM).capability.description;
    expect(description).not.toContain("Requires opportunity_id");
  });
});

/* ============ 8 & 9. the human's turn with the text ============ */

describe("8 & 9 — descriptions are editable before confirmation, and edits invalidate it after", () => {
  it("lets a person rewrite the capability and input descriptions, and confirms what they wrote", () => {
    const grounded = groundCapability(proposedUpdate(), mutationTrace(), KNOWN_PLATFORM);

    // What the Studio's editor does: replace the text, then re-compose so
    // the runtime's half is still the runtime's.
    const edited: SemanticCapability = {
      ...grounded.capability,
      description: composeDescription(
        "Moves a deal forward by setting its stage and expected close date.",
        grounded.descriptionComposition.guarantees
      ).text,
      inputs: grounded.capability.inputs.map((input) =>
        input.name === "stage" ? { ...input, description: "Pipeline stage to move the deal to." } : input
      )
    };
    const confirmed = confirmCandidate(edited);

    expect(confirmed.description).toContain("Moves a deal forward by setting its stage");
    // The person's words did not displace the runtime's.
    expect(confirmed.description).toContain("Requires opportunity_id");
    expect(describedInput(confirmed, "stage")?.description).toBe("Pipeline stage to move the deal to.");

    // Grounding again leaves a confirmed contract alone: the human's text
    // is intent, and intent is theirs.
    const again = groundCapability(confirmed, mutationTrace(), KNOWN_PLATFORM);
    expect(again.capability.description).toBe(confirmed.description);
    expect(again.confirmationWithdrawn).toBe(false);
    expect(again.capability.provenance.confirmedByHuman).toBe(true);
  });

  it("treats a changed description as a changed contract", () => {
    const confirmed = confirmCandidate(
      groundCapability(proposedUpdate(), mutationTrace(), KNOWN_PLATFORM).capability
    );

    expect(contractChanged(confirmed, { ...confirmed, description: `${confirmed.description} And more.` })).toBe(true);
    expect(
      contractChanged(confirmed, {
        ...confirmed,
        inputs: confirmed.inputs.map((input) =>
          input.name === "stage" ? { ...input, description: "Something else entirely." } : input
        )
      })
    ).toBe(true);
    // A binding is not part of the meaning, so changing one is not a
    // changed contract.
    expect(
      contractChanged(confirmed, { ...confirmed, binding: { application: SALESFORCE.id, action: "x" } })
    ).toBe(false);
  });

  it("withdraws a confirmation when grounding has to change the description under it", () => {
    // A capability confirmed before the identity parameter existed: the
    // description it was confirmed with promises nothing, and the one that
    // would be published promises two things.
    const confirmed = confirmCandidate(proposedUpdate());
    const grounded = groundCapability(confirmed, mutationTrace(), KNOWN_PLATFORM);

    expect(grounded.confirmationWithdrawn).toBe(true);
    expect(grounded.capability.provenance.confirmedByHuman).toBe(false);
    expect(grounded.capability.description).toContain("Requires opportunity_id");
  });
});

/* ============ 10 & 11. what actually reaches an agent ============ */

describe("10 & 11 — the published WebMCP tool carries the confirmed descriptions", () => {
  const publishable = () => {
    const grounded = groundCapability(proposedUpdate(), mutationTrace(), KNOWN_PLATFORM);
    return confirmCandidate({
      ...grounded.capability,
      binding: { application: SALESFORCE.id, action: "update_opportunity" }
    });
  };

  it("publishes the confirmed capability description verbatim", () => {
    const capability = publishable();
    const tool = compileCapability(capability, () => ({}));

    expect(tool.name).toBe("update_opportunity");
    expect(tool.description).toBe(capability.description);
    expect(tool.description).toContain("Updates an existing Salesforce Opportunity's stage and close date.");
    expect(tool.description).toContain("Requires opportunity_id");
  });

  it("publishes every input description, the required list, and the declared constraints", () => {
    const capability = {
      ...publishable(),
      inputs: publishable().inputs.map((input) =>
        input.name === "stage" ? { ...input, enum: ["Prospecting", "Negotiation/Review", "Closed Won"] } : input
      )
    };
    const schema = compileCapability(capability, () => ({})).inputSchema;

    expect(schema.properties["opportunity_id"].description).toBe(
      capability.inputs.find((input) => input.role === "target-identity")?.description
    );
    expect(schema.properties["stage"]).toEqual({
      type: "string",
      description: "The sales stage the deal has reached.",
      enum: ["Prospecting", "Negotiation/Review", "Closed Won"]
    });
    // A date keeps its machine-readable format alongside its description.
    expect(schema.properties["close_date"]).toEqual({
      type: "string",
      format: "date",
      description: "When the deal is expected to close. (date, YYYY-MM-DD)"
    });
    expect(schema.required).toContain("opportunity_id");
    expect(Object.values(schema.properties).every((property) => property.description.trim().length > 0)).toBe(true);
  });

  it("publishes a search's description and read-only annotation", () => {
    const grounded = groundCapability(proposedSearch(), searchTrace(), KNOWN_PLATFORM);
    const capability = confirmCandidate({
      ...grounded.capability,
      binding: { application: SALESFORCE.id, action: "search_opportunities" }
    });
    const tool = compileCapability(capability, () => ({}));

    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.description).toContain("Searches Salesforce Opportunities by name, account, or status.");
    expect(tool.description).toContain("several matching Opportunity candidates");
    expect(tool.inputSchema.properties["name"].description).toBe("Opportunity name to look for.");
  });
});

/* ======= 12 & 13. nothing else moved, and nothing leaked in ======= */

describe("12 — grounding's existing answers are unchanged", () => {
  it("still canonicalizes, still adds the identity parameter, still asks its questions", () => {
    const grounded = groundCapability(proposedUpdate(), mutationTrace(), KNOWN_PLATFORM);

    expect(
      grounded.capability.inputs.filter((input) => (input.role ?? "business") === "business").map((i) => i.name).sort()
    ).toEqual(["close_date", "stage"]);
    expect(grounded.renames).toEqual([]);
    expect(grounded.unresolved).toEqual([]);
    expect(grounded.targetIdentity?.inputName).toBe("opportunity_id");
    expect(grounded.capability.id).toBe("update_opportunity");
    expect(grounded.capability.name).toBe("Update opportunity");
  });
});

describe("13 — the description machinery knows nothing about any particular application", () => {
  it("names no vendor, platform or object in its source", () => {
    for (const file of ["src/semantic/description.ts", "src/training/executionSemantics.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/salesforce|lightning|opportunity|soql|sobject/i);
    }
  });

  it("composes the same way for an entity type it has never heard of", () => {
    const guarantees = executionGuarantees({
      targetIdentity: { inputName: "ticket_id", entityType: "Ticket", description: "d" },
      readOnly: false
    });
    const composed = composeDescription("Reassigns a support ticket to another queue.", guarantees);

    expect(composed.text).toBe(
      "Reassigns a support ticket to another queue. " +
        "Requires ticket_id: the Ticket record identity to act on. " +
        "Refuses to write anything unless that Ticket is the record the application currently has open, and " +
        "re-checks the identity after saving."
    );
  });

  it("says only what it can when a search's entity type is unknown", () => {
    const guarantees = executionGuarantees({ readOnly: true, entityResolution: {} });
    const statements = guarantees.map((guarantee) => guarantee.statement);

    expect(statements).toContain("May return zero, one, or several matching candidates, and never chooses between them.");
    expect(statements).toContain("Each candidate carries the record identity that identity-gated tools require.");
  });
});
