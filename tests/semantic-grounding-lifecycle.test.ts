import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import { groundCapability } from "../src/training/semanticGrounding";
import { confirmCandidate } from "../src/training/semanticizer";
import { proposeBrowserBinding } from "../src/binding/browserExecution/propose";
import { applicationIntelligenceForPlatform } from "../src/binding/browserExecution/adapters";
import { emptyTenantIntelligence, tenantIntelligenceFrom } from "../src/applicationIntelligence/tenant";
import { compileCapability } from "../src/webmcp/compiler";
import { assertPublishable } from "../src/webmcp/publication";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { FieldClarification, TenantIntelligenceSnapshot } from "../src/applicationIntelligence/model";
import type { CapabilityInput, SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * The lifecycle invariant, not the helpers.
 *
 *   A human confirms the same agent-facing contract that gets published.
 *
 * Everything capable of changing a parameter name must therefore be
 * settled BEFORE confirmation. These tests walk the real order —
 * propose → ground → (clarify → ground) → confirm → bind → publish — and
 * assert on what a human was shown versus what an agent would receive.
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";
const SALESFORCE = sourceApplicationFor(PLATFORM, "nvent-dev-ed.lightning.force.com");
const page = { host: "nvent-dev-ed.lightning.force.com", path: "/lightning/r/Opportunity/006/view" };

/** The real capture shape, parameterized by what this org calls the field. */
function traceLabelled(stageLabel: string) {
  const session = new CaptureSession("sess-lifecycle", 0, {
    host: page.host,
    platform: PLATFORM,
    title: "PS Project Test | Opportunity"
  });
  session.addMany([
    { id: "nav", kind: "navigate", t: 100, page },
    {
      id: "close-date-focus",
      kind: "click",
      t: 1_000,
      page,
      element: { tag: "input", name: "CloseDate", label: "*Close Date" },
      actionLabel: "*Close Date"
    },
    {
      id: "close-date-change",
      kind: "field_change",
      t: 1_500,
      page,
      element: { tag: "lightning-datepicker", label: "*Close Date" },
      field: { label: "*Close Date", section: "Opportunity Details", control: "other" },
      value: { masked: false, to: "2027-03-01" }
    },
    {
      id: "stage-open",
      kind: "click",
      t: 2_000,
      page,
      element: { tag: "button", label: stageLabel },
      actionLabel: stageLabel
    },
    {
      id: "stage-change",
      kind: "field_change",
      t: 2_500,
      page,
      element: { tag: "lightning-combobox", label: `*${stageLabel}` },
      field: { label: `*${stageLabel}`, section: "Opportunity Details", control: "other" },
      value: { masked: false, to: "Negotiation/Review" }
    },
    { id: "save", kind: "click", t: 3_000, page, actionLabel: "Save" }
  ]);
  session.stop(4_000);
  return session.toTrace();
}

function snapshotLabelled(stageLabel: string, options?: string[]): TenantIntelligenceSnapshot {
  return {
    platform: PLATFORM,
    orgId: "00Dxx0000000000",
    capturedAt: "2026-08-27T09:00:00.000Z",
    mechanism: "injected-snapshot",
    objects: [
      {
        apiName: "Opportunity",
        fields: [
          { apiName: "CloseDate", label: "Close Date", type: "date" },
          { apiName: "StageName", label: stageLabel, type: "picklist", ...(options ? { options } : {}) }
        ]
      }
    ]
  };
}

const STANDARD_ONLY = applicationIntelligenceForPlatform(PLATFORM, emptyTenantIntelligence());
const withTenant = (snapshot: TenantIntelligenceSnapshot) =>
  applicationIntelligenceForPlatform(PLATFORM, tenantIntelligenceFrom(snapshot));
const withClarification = (clarification: FieldClarification) => ({ ...STANDARD_ONLY, clarifications: [clarification] });

/** What the semanticizer hands over: input names taken from the visible labels. */
function proposed(stageInput: string): SemanticCapability {
  const inputs: CapabilityInput[] = [
    { name: "close_date", description: "The close date", type: "date", required: true },
    { name: stageInput, description: "The stage", type: "string", required: true }
  ];
  return {
    id: "update_opportunity",
    name: "Update opportunity",
    description: "Change an opportunity's close date and stage, then save.",
    inputs,
    outputs: [],
    provenance: { source: "inferred", observationIds: [], confirmedByHuman: false, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true }
  };
}

/**
 * The inputs a human demonstrated. Asserted separately from the identity
 * parameter, because they answer different questions: these prove the
 * tenant-independence invariant, while the identity parameter proves the
 * system added its own targeting requirement.
 */
const names = (capability: SemanticCapability) =>
  capability.inputs
    .filter((input) => (input.role ?? "business") === "business")
    .map((input) => input.name)
    .sort();

/** The identity parameter the system contributes, if any. */
const identityInput = (capability: SemanticCapability) =>
  capability.inputs.find((input) => input.role === "target-identity");

const SALES_STAGE_IS_STAGENAME: FieldClarification = {
  platform: PLATFORM,
  objectApiName: "Opportunity",
  observedLabel: "Sales Stage",
  apiName: "StageName",
  source: "human-confirmed",
  scope: "capability"
};

/* ============ 1. grounded from knowledge already available ============ */

describe("1 — canonical identity available before the human is asked", () => {
  it("presents `stage` for confirmation in a renamed org with tenant metadata", () => {
    const grounded = groundCapability(
      proposed("sales_stage"),
      traceLabelled("Sales Stage"),
      withTenant(snapshotLabelled("Sales Stage"))
    );
    // The name is settled before anyone confirms anything.
    expect(names(grounded.capability)).toEqual(["close_date", "stage"]);
    // And the system has contributed the targeting parameter nobody
    // demonstrated, before the human is asked to approve the contract.
    expect(identityInput(grounded.capability)).toMatchObject({
      name: "opportunity_id",
      required: true,
      role: "target-identity"
    });
    expect(grounded.capability.provenance.confirmedByHuman).toBe(false);
    expect(grounded.needs).toEqual([]);
    expect(grounded.confirmationWithdrawn).toBe(false);

    // And what the human then confirms is exactly what an agent receives.
    const confirmed = confirmCandidate(grounded.capability);
    expect(names(confirmed)).toEqual(["close_date", "stage"]);
  });

  it("leaves an already-canonical contract untouched", () => {
    const grounded = groundCapability(proposed("stage"), traceLabelled("Stage"), STANDARD_ONLY);
    expect(names(grounded.capability)).toEqual(["close_date", "stage"]);
    expect(grounded.renames).toEqual([]);
    expect(grounded.noncanonical).toEqual([]);
  });
});

/* ====== 2. grounding arrives after the proposal, before confirmation ====== */

describe("2 — identity discovered after the proposal but before confirmation", () => {
  it("renames the contract while it is still open, and confirmation receives the canonical name", () => {
    const trace = traceLabelled("Sales Stage");
    const candidate = proposed("sales_stage");

    // The model proposed a tenant-shaped name.
    expect(names(candidate)).toEqual(["close_date", "sales_stage"]);

    // Tenant metadata is installed before the human confirms — the ordering
    // this whole stage exists to guarantee.
    const grounded = groundCapability(candidate, trace, withTenant(snapshotLabelled("Sales Stage")));
    expect(grounded.renames).toHaveLength(1);
    expect(grounded.renames[0]).toMatchObject({ from: "sales_stage", to: "stage", apiName: "StageName" });

    // Nothing was confirmed yet, so nothing had to be withdrawn.
    expect(grounded.confirmationWithdrawn).toBe(false);

    const confirmed = confirmCandidate(grounded.capability);
    expect(confirmed.provenance.confirmedByHuman).toBe(true);
    expect(names(confirmed)).toEqual(["close_date", "stage"]);

    // Grounding again after confirmation must now be a no-op: there is
    // nothing left to discover, so the confirmed contract stands.
    const again = groundCapability(confirmed, trace, withTenant(snapshotLabelled("Sales Stage")));
    expect(again.renames).toEqual([]);
    expect(again.confirmationWithdrawn).toBe(false);
    expect(again.capability.provenance.confirmedByHuman).toBe(true);
    expect(names(again.capability)).toEqual(["close_date", "stage"]);
  });
});

/* ============ 3. human clarification establishes the identity ============ */

describe("3 — a human answer grounds the identity before confirmation", () => {
  const trace = traceLabelled("Sales Stage");

  it("asks a question whose answer decides the parameter name", () => {
    const grounded = groundCapability(proposed("sales_stage"), trace, STANDARD_ONLY);
    // Nothing available identifies "Sales Stage", so the system asks rather
    // than guessing, and asks BEFORE the contract is confirmed.
    expect(grounded.needs.length).toBeGreaterThan(0);
    expect(grounded.needs[0].kind).toBe("field-api-name");
    expect(grounded.needs[0].knownEvidence.observedLabel).toBe("Sales Stage");
    expect(names(grounded.capability)).toEqual(["close_date", "sales_stage"]);
  });

  it("canonicalizes once the answer is given, still before confirmation", () => {
    const grounded = groundCapability(
      proposed("sales_stage"),
      trace,
      withClarification(SALES_STAGE_IS_STAGENAME)
    );
    expect(names(grounded.capability)).toEqual(["close_date", "stage"]);
    expect(grounded.needs).toEqual([]);
    expect(grounded.confirmationWithdrawn).toBe(false);

    const confirmed = confirmCandidate(grounded.capability);
    expect(names(confirmed)).toEqual(["close_date", "stage"]);
  });

  it("keeps the canonical contract bindable — the answer travels with the identity", () => {
    // The trap this closes: renaming to `stage` while the page still says
    // "Sales Stage" produced a contract that could no longer be grounded,
    // leaving a capability that was understood and unexecutable.
    const grounded = groundCapability(
      proposed("sales_stage"),
      trace,
      withClarification(SALES_STAGE_IS_STAGENAME)
    );
    const proposal = proposeBrowserBinding(
      confirmCandidate(grounded.capability),
      trace,
      withClarification(SALES_STAGE_IS_STAGENAME)
    );
    expect(proposal.binding).not.toBeNull();
    const stage = proposal.binding!.inputs.find((input) => input.semanticInput === "stage");
    expect(stage?.applicationField?.apiName).toBe("StageName");
    // The contract is canonical; the live target still says what the page says.
    expect(stage?.semanticTarget.label).toBe("*Sales Stage");
  });

  it("does not treat the model's own guess as human-confirmed identity", () => {
    // No clarification: the identity is genuinely unestablished, and the
    // system must not manufacture one from the proposal's wording alone.
    const grounded = groundCapability(proposed("stage"), trace, STANDARD_ONLY);
    expect(grounded.capability.inputs.some((input) => input.name === "stage")).toBe(true);
    // `stage` cannot be grounded against a page that says "Sales Stage"
    // with nothing to connect them. That is UNRESOLVED — it will not
    // execute — and not merely a contract that travels badly.
    expect(grounded.unresolved).toContain("stage");
    expect(grounded.noncanonical).not.toContain("stage");
    expect(proposeBrowserBinding(grounded.capability, trace, STANDARD_ONLY).binding).toBeNull();
  });
});

/* ================== 4. identity genuinely unresolved ================== */

describe("4 — an identity nothing can establish stays honestly noncanonical", () => {
  const trace = traceLabelled("Foo Revenue Bucket");

  it("keeps the tenant-derived name rather than fabricating a canonical one", () => {
    const grounded = groundCapability(proposed("foo_revenue_bucket"), trace, STANDARD_ONLY);
    expect(names(grounded.capability)).toEqual(["close_date", "foo_revenue_bucket"]);
    expect(grounded.renames).toEqual([]);
    // Reported as one of the two honest outcomes, never renamed to an
    // invented canonical concept.
    expect([...grounded.noncanonical, ...grounded.unresolved]).toContain("foo_revenue_bucket");
    // Close Date is grounded by the identifier the control exposed, so it
    // is not swept into either bucket.
    expect(grounded.noncanonical).not.toContain("close_date");
    expect(grounded.unresolved).not.toContain("close_date");
  });

  it("separates a contract that travels badly from one that cannot execute", () => {
    // The custom-field case: grounded, so it executes; not vendor-named, so
    // its contract is org-specific.
    const customField: TenantIntelligenceSnapshot = {
      platform: PLATFORM,
      orgId: "00D",
      objects: [
        {
          apiName: "Opportunity",
          fields: [
            { apiName: "CloseDate", label: "Close Date", type: "date" },
            { apiName: "Foo_Revenue_Bucket__c", label: "Foo Revenue Bucket", type: "picklist", custom: true }
          ]
        }
      ]
    };
    const grounded = groundCapability(proposed("foo_revenue_bucket"), trace, withTenant(customField));
    expect(grounded.noncanonical).toContain("foo_revenue_bucket");
    expect(grounded.unresolved).toEqual([]);
    expect(proposeBrowserBinding(grounded.capability, trace, withTenant(customField)).binding).not.toBeNull();

    // With nothing describing it, the same input is unresolved instead.
    const ungrounded = groundCapability(proposed("foo_revenue_bucket"), trace, STANDARD_ONLY);
    expect(ungrounded.unresolved).toContain("foo_revenue_bucket");
    expect(ungrounded.noncanonical).toEqual([]);
  });

  it("fabricates no canonical concept, and stays confirmable", () => {
    const grounded = groundCapability(proposed("foo_revenue_bucket"), trace, STANDARD_ONLY);
    const confirmed = confirmCandidate(grounded.capability);
    // Functional rather than fabricated: the human may confirm a contract
    // that is specific to this org.
    expect(confirmed.provenance.confirmedByHuman).toBe(true);
    expect(names(confirmed)).toEqual(["close_date", "foo_revenue_bucket"]);
  });
});

/* ============ 5. no silent rename after confirmation ============ */

describe("5 — a confirmed contract is never silently renamed", () => {
  const trace = traceLabelled("Sales Stage");

  it("withdraws confirmation rather than changing what an agent sees behind the human's back", () => {
    // A human confirmed the tenant-shaped contract, because nothing could
    // ground it at the time.
    const confirmed = confirmCandidate(groundCapability(proposed("sales_stage"), trace, STANDARD_ONLY).capability);
    expect(confirmed.provenance.confirmedByHuman).toBe(true);
    expect(names(confirmed)).toEqual(["close_date", "sales_stage"]);

    // Metadata arrives afterwards and would rename the contract.
    const late = groundCapability(confirmed, trace, withTenant(snapshotLabelled("Sales Stage")));

    expect(late.confirmationWithdrawn).toBe(true);
    expect(late.capability.provenance.confirmedByHuman).toBe(false);
    expect(late.capability.provenance.source).toBe("inferred");

    // The publication gate is what makes this safe rather than merely tidy:
    // the corrected contract cannot reach an agent until a human approves it.
    expect(() => assertPublishable({ ...late.capability, binding: { application: PLATFORM, action: "x" } })).toThrow(
      /human-confirmed/i
    );
  });

  it("never publishes a name the confirming human did not see", () => {
    const confirmed = confirmCandidate(groundCapability(proposed("sales_stage"), trace, STANDARD_ONLY).capability);
    const approved = names(confirmed);
    const late = groundCapability(confirmed, trace, withTenant(snapshotLabelled("Sales Stage")));

    // Either the contract is unchanged, or its confirmation is gone. What
    // must never happen is a changed contract that still counts as approved.
    const changed = names(late.capability).join() !== approved.join();
    expect(changed && late.capability.provenance.confirmedByHuman).toBe(false);
  });

  it("leaves a confirmed contract alone when nothing new is learned", () => {
    const confirmed = confirmCandidate(
      groundCapability(proposed("sales_stage"), trace, withTenant(snapshotLabelled("Sales Stage"))).capability
    );
    const again = groundCapability(confirmed, trace, withTenant(snapshotLabelled("Sales Stage")));
    expect(again.confirmationWithdrawn).toBe(false);
    expect(again.capability.provenance.confirmedByHuman).toBe(true);
  });
});

/* ============ 6. two tenant labels, one published schema ============ */

describe("6 — the tenant-independence invariant holds through the lifecycle", () => {
  it("publishes an identical schema for Stage and Sales Stage", () => {
    const publishedFor = (stageLabel: string, stageInput: string, intelligence: ReturnType<typeof withTenant>) => {
      const trace = traceLabelled(stageLabel);
      const grounded = groundCapability(proposed(stageInput), trace, intelligence);
      const confirmed = confirmCandidate(grounded.capability);
      return compileCapability(confirmed, () => ({})).inputSchema;
    };

    const a = publishedFor("Stage", "stage", withTenant(snapshotLabelled("Stage")));
    const b = publishedFor("Sales Stage", "sales_stage", withTenant(snapshotLabelled("Sales Stage")));
    expect(b).toEqual(a);
    // The system's own targeting parameter travels with the demonstrated
    // fields, and is identical across tenants for the same reason they are.
    expect(Object.keys(a.properties).sort()).toEqual(["close_date", "opportunity_id", "stage"]);
    expect(a.required).toContain("opportunity_id");
  });

  it("holds when one org's identity came from metadata and the other's from a human", () => {
    const fromMetadata = confirmCandidate(
      groundCapability(
        proposed("sales_stage"),
        traceLabelled("Sales Stage"),
        withTenant(snapshotLabelled("Sales Stage"))
      ).capability
    );
    const fromHuman = confirmCandidate(
      groundCapability(
        proposed("sales_stage"),
        traceLabelled("Sales Stage"),
        withClarification(SALES_STAGE_IS_STAGENAME)
      ).capability
    );
    expect(compileCapability(fromHuman, () => ({})).inputSchema).toEqual(
      compileCapability(fromMetadata, () => ({})).inputSchema
    );
  });
});

/* ============ 7. grounding introduces no locator persistence ============ */

describe("7 — semantic grounding stores nothing a DOM could invalidate", () => {
  it("produces a capability carrying no selector, XPath, coordinate, or node reference", () => {
    const grounded = groundCapability(
      proposed("sales_stage"),
      traceLabelled("Sales Stage"),
      withTenant(snapshotLabelled("Sales Stage", ["Prospecting", "Negotiation/Review"]))
    );
    const serialized = JSON.stringify(grounded.capability);
    expect(serialized).not.toMatch(/queryselector|xpath|\/html\/|nth-child|clientx|offsettop|nodeid|elementref/i);

    // A capability is a contract, not a location: its inputs carry names,
    // types, and value domains only.
    for (const input of grounded.capability.inputs) {
      expect(Object.keys(input).every((key) =>
        ["name", "description", "type", "required", "enum", "role"].includes(key)
      )).toBe(true);
    }
  });

  it("runs without a DOM at all", () => {
    // This whole file runs in the default (non-jsdom) environment, so a
    // stage that touched `document` could not have got this far. Stated
    // explicitly because it is the architectural boundary: semantic
    // identity is settled here, and the live control is resolved later.
    expect(typeof globalThis.document).toBe("undefined");
  });
});
