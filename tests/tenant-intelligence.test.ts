import { describe, expect, it } from "vitest";
import { CaptureSession } from "../src/capture/session";
import { resolveFieldMapping } from "../src/binding/fieldMapping";
import { proposeBrowserBinding } from "../src/binding/browserExecution/propose";
import { applicationIntelligenceForPlatform } from "../src/binding/browserExecution/adapters";
import { emptyTenantIntelligence, tenantIntelligenceFrom } from "../src/applicationIntelligence/tenant";
import {
  mergeTenantSnapshots,
  observedTenantSnapshot,
  staleObservedFields
} from "../src/applicationIntelligence/observedTenant";
import { observedTenantFromBinding } from "../src/training/tenantObservations";
import { canonicalizeCapabilityInputs } from "../src/training/canonicalInputs";
import { buildTestFormFields, validateTestInputs } from "../src/training/executionTestForm";
import { compileCapability } from "../src/webmcp/compiler";
import { withResolvedValueDomains } from "../src/webmcp/publication";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import { inferDateRepresentation } from "../src/binding/browserExecution/dateRepresentation";
import type { TenantIntelligenceSnapshot } from "../src/applicationIntelligence/model";
import type { CapabilityInput, SemanticCapability } from "../src/semantic/model";

/* ------------------------------------------------------------------ *
 * Tenant Intelligence V0.1.
 *
 * The invariant these exist to hold: what one org calls a field is that
 * org's business, and an agent must never inherit it. Two tenants running
 * the same application, one of which renamed Stage to "Sales Stage", must
 * publish the SAME tool — `update_opportunity({ stage, close_date })` —
 * and the difference must be absorbed entirely below the contract.
 *
 * Internal names matter less than that invariant, which is why these tests
 * assert on published contracts and grounded identities rather than on the
 * shape of any particular class.
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";
const SALESFORCE = sourceApplicationFor(PLATFORM, "nvent-dev-ed.lightning.force.com");
const page = { host: "nvent-dev-ed.lightning.force.com", path: "/lightning/r/Opportunity/006/view" };

/**
 * The real observed shape, parameterized by what this org calls Stage.
 *
 * Faithful to the live capture in both respects that made this hard: Close
 * Date's native input names itself, and every Stage event comes through a
 * shadow host carrying no name at all — only the visible label.
 */
function traceLabelled(stageLabel: string) {
  const session = new CaptureSession("sess-tenant", 0, {
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

/** A tenant snapshot in which Stage carries whatever this org renamed it to. */
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
          {
            apiName: "StageName",
            label: stageLabel,
            type: "picklist",
            ...(options ? { options } : {})
          }
        ]
      }
    ]
  };
}

const withTenant = (snapshot: TenantIntelligenceSnapshot) =>
  applicationIntelligenceForPlatform(PLATFORM, tenantIntelligenceFrom(snapshot));
const STANDARD_ONLY = applicationIntelligenceForPlatform(PLATFORM, emptyTenantIntelligence());

/** What the semanticizer produces: input names derived from the labels this org displays. */
function proposedFromLabels(stageInput: string): SemanticCapability {
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

/* =================== 1. the tenant-independence invariant =================== */

describe("1 — two tenants, one contract", () => {
  it("publishes the same tool whether this org calls it Stage or Sales Stage", () => {
    // Tenant A ships the vendor's own label; the semanticizer names the
    // input after it and nothing needs to change.
    const a = canonicalizeCapabilityInputs(
      proposedFromLabels("stage"),
      traceLabelled("Stage"),
      withTenant(snapshotLabelled("Stage"))
    );
    // Tenant B renamed the field. The semanticizer, which names inputs
    // after visible labels, produced `sales_stage`.
    const b = canonicalizeCapabilityInputs(
      proposedFromLabels("sales_stage"),
      traceLabelled("Sales Stage"),
      withTenant(snapshotLabelled("Sales Stage"))
    );

    const names = (capability: SemanticCapability) => capability.inputs.map((input) => input.name).sort();
    expect(names(a.capability)).toEqual(["close_date", "stage"]);
    expect(names(b.capability)).toEqual(["close_date", "stage"]);
    expect(names(a.capability)).toEqual(names(b.capability));

    // And the rename is disclosed, never silent — a human confirms this.
    expect(b.renames).toHaveLength(1);
    expect(b.renames[0]).toMatchObject({ from: "sales_stage", to: "stage", apiName: "StageName" });
    expect(a.renames).toEqual([]);
  });

  it("compiles to identical agent-facing tool schemas", () => {
    const forTenant = (stageLabel: string, stageInput: string) => {
      const { capability } = canonicalizeCapabilityInputs(
        proposedFromLabels(stageInput),
        traceLabelled(stageLabel),
        withTenant(snapshotLabelled(stageLabel))
      );
      return compileCapability({ ...capability, provenance: { ...capability.provenance } }, () => ({}));
    };

    const a = forTenant("Stage", "stage");
    const b = forTenant("Sales Stage", "sales_stage");
    expect(b.inputSchema).toEqual(a.inputSchema);
    expect(Object.keys(b.inputSchema.properties)).toEqual(["close_date", "stage"]);
  });

  it("grounds the canonical input to the same field identity in both orgs", () => {
    const groundedIn = (stageLabel: string) =>
      resolveFieldMapping(
        { ...proposedFromLabels("stage"), provenance: { ...proposedFromLabels("stage").provenance } },
        traceLabelled(stageLabel),
        withTenant(snapshotLabelled(stageLabel))
      );

    expect(groundedIn("Stage").mapping).toEqual({ close_date: "CloseDate", stage: "StageName" });
    expect(groundedIn("Sales Stage").mapping).toEqual({ close_date: "CloseDate", stage: "StageName" });
  });

  it("still resolves the org that runs the vendor's own label with no tenant metadata at all", () => {
    // The proven org. Standard knowledge alone must keep working.
    const result = resolveFieldMapping(proposedFromLabels("stage"), traceLabelled("Stage"), STANDARD_ONLY);
    expect(result.mapping).toEqual({ close_date: "CloseDate", stage: "StageName" });
    expect(result.grounding.stage).toMatchObject({ evidence: "visible-label", knowledge: "standard" });
  });
});

/* =================== 2. the binding keeps tenant vocabulary =================== */

describe("2 — the contract is canonical; the binding stays tenant-specific", () => {
  const build = (stageLabel: string, stageInput: string) => {
    const trace = traceLabelled(stageLabel);
    const intelligence = withTenant(snapshotLabelled(stageLabel, ["Prospecting", "Negotiation/Review"]));
    const { capability } = canonicalizeCapabilityInputs(proposedFromLabels(stageInput), trace, intelligence);
    return proposeBrowserBinding(capability, trace, intelligence);
  };

  it("resolves the live control by what this org actually displays", () => {
    const renamed = build("Sales Stage", "sales_stage").binding;
    expect(renamed).not.toBeNull();
    const stage = renamed!.inputs.find((input) => input.semanticInput === "stage");
    // The contract says `stage`; the page still says "Sales Stage", and the
    // binding must look for what is on screen.
    expect(stage?.semanticInput).toBe("stage");
    expect(stage?.semanticTarget.label).toBe("*Sales Stage");
    expect(stage?.applicationField?.apiName).toBe("StageName");
  });

  it("persists no selector, XPath, or coordinate for either org", () => {
    for (const binding of [build("Stage", "stage").binding, build("Sales Stage", "sales_stage").binding]) {
      expect(binding).not.toBeNull();
      expect(binding!.safety).toEqual({
        noCoordinates: true,
        noXPath: true,
        noPrivateTransportReplay: true,
        noCredentialExtraction: true
      });

      // Scanned without the safety block, whose own flag names legitimately
      // contain the words being searched for.
      const { safety, ...withoutSafetyFlags } = binding!;
      const serialized = JSON.stringify(withoutSafetyFlags);
      expect(serialized).not.toMatch(/queryselector|xpath|\/html\/|nth-child|clientx|offsettop|data-aura-rendered/i);

      // A target is only ever things a human or a screen reader could use.
      for (const input of binding!.inputs) {
        expect(Object.keys(input.semanticTarget).every((key) =>
          ["role", "label", "applicationIdentifier", "section"].includes(key)
        )).toBe(true);
      }
    }
  });
});

/* =================== 3. live observation becomes tenant knowledge =================== */

describe("3 — what the application showed becomes tenant knowledge, at observation strength", () => {
  const trace = traceLabelled("Sales Stage");
  const intelligence = withTenant(snapshotLabelled("Sales Stage"));
  const { capability } = canonicalizeCapabilityInputs(proposedFromLabels("sales_stage"), trace, intelligence);
  const binding = proposeBrowserBinding(capability, trace, intelligence).binding!;

  it("records the org's own label and the values the live control offered", () => {
    const snapshot = observedTenantFromBinding(
      binding,
      { stage: ["Prospecting", "Negotiation/Review", "Closed Won"] },
      "2026-09-02T10:00:00.000Z"
    );
    expect(snapshot).toBeDefined();
    const stage = snapshot!.objects[0].fields.find((field) => field.apiName === "StageName");
    expect(stage).toMatchObject({
      apiName: "StageName",
      label: "Sales Stage",
      type: "picklist",
      source: "observed-live",
      observedAt: "2026-09-02T10:00:00.000Z",
      options: ["Prospecting", "Negotiation/Review", "Closed Won"]
    });
    expect(snapshot!.mechanism).toBe("observed-live-application");
  });

  it("never promotes a reading to metadata", () => {
    const snapshot = observedTenantSnapshot({
      platform: PLATFORM,
      objectApiName: "Opportunity",
      observedAt: "2026-09-02T10:00:00.000Z",
      fields: [{ apiName: "StageName", label: "Sales Stage", type: "picklist", options: ["Prospecting"] }]
    });
    const resolved = resolveFieldMapping(capability, trace, withTenant(snapshot));
    // The values are usable, and they are labelled as what they are: read
    // from the running application, not stated by the org's configuration.
    expect(resolved.fields.stage).toMatchObject({
      apiName: "StageName",
      optionsSource: "live-application-state",
      domain: "known-live"
    });
    expect(resolved.fields.stage.optionsSource).not.toBe("tenant");
  });

  it("carries the observed domain into the published contract under the canonical name", () => {
    const published = withResolvedValueDomains(capability, { stage: ["Prospecting", "Negotiation/Review"] });
    const stage = published.inputs.find((input) => input.name === "stage");
    expect(stage?.enum).toEqual(["Prospecting", "Negotiation/Review"]);
  });

  it("contributes nothing when no input is grounded to a field identity", () => {
    const ungrounded = {
      ...binding,
      inputs: binding.inputs.map((input) => ({ ...input, applicationField: undefined }))
    };
    expect(observedTenantFromBinding(ungrounded, { stage: ["Prospecting"] }, "2026-09-02T10:00:00.000Z")).toBeUndefined();
  });
});

/* =================== 4. failing safely =================== */

describe("4 — safe failure, in preference to a weak match", () => {
  it("refuses when two fields could plausibly be the same semantic concept", () => {
    const twoStages: TenantIntelligenceSnapshot = {
      platform: PLATFORM,
      orgId: "00D",
      objects: [
        {
          apiName: "Opportunity",
          fields: [
            { apiName: "StageName", label: "Stage", type: "picklist" },
            { apiName: "Custom_Stage__c", label: "Stage", type: "picklist", custom: true }
          ]
        }
      ]
    };
    const result = resolveFieldMapping(proposedFromLabels("stage"), traceLabelled("Stage"), withTenant(twoStages));
    expect(result.mapping.stage).toBeUndefined();
    expect(result.statuses.stage).toBe("ambiguous");
    // It asks rather than guessing, and it already knows both answers.
    const need = result.needs.find((entry) => entry.knownEvidence.inputName === "stage");
    expect(need?.kind).toBe("field-choice");
    expect(need?.suggestedAnswers?.map((answer) => answer.value).sort()).toEqual(["Custom_Stage__c", "StageName"]);
  });

  it("blocks when the tenant's label has changed and no knowledge explains the new one", () => {
    // The honest case: the org renamed Stage and nothing available says so.
    // Guessing that "Sales Stage" must be StageName is exactly the weak
    // match this refuses to make.
    const result = resolveFieldMapping(proposedFromLabels("stage"), traceLabelled("Sales Stage"), STANDARD_ONLY);
    expect(result.mapping.stage).toBeUndefined();
    expect(result.ambiguities.join(" ")).toMatch(/no observed field identifier or visible label matches "stage"/i);
  });

  it("proposes no binding at all while an input cannot be grounded", () => {
    const trace = traceLabelled("Sales Stage");
    const proposal = proposeBrowserBinding(proposedFromLabels("stage"), trace, STANDARD_ONLY);
    expect(proposal.binding).toBeNull();
    expect(proposal.warnings.join(" ")).toMatch(/not every capability input could be grounded/i);
  });

  it("rejects a requested value the live control does not currently offer", () => {
    const trace = traceLabelled("Stage");
    const intelligence = withTenant(snapshotLabelled("Stage"));
    const { capability } = canonicalizeCapabilityInputs(proposedFromLabels("stage"), trace, intelligence);
    const binding = proposeBrowserBinding(capability, trace, intelligence).binding!;
    const fields = buildTestFormFields(capability, binding, { stage: ["Prospecting", "Negotiation/Review"] });

    // "Closed Won" is a real Salesforce stage, and this record type does not
    // currently offer it. The form says what IS allowed rather than
    // accepting a plausible-looking value the application would reject.
    const rejected = validateTestInputs(fields, { stage: "Closed Won", close_date: "2027-03-01" });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected the unavailable value to be rejected");
    expect(rejected.errors.join(" ")).toMatch(/must be one of: Prospecting, Negotiation\/Review/);

    const accepted = validateTestInputs(fields, { stage: "Negotiation/Review", close_date: "2027-03-01" });
    expect(accepted.ok).toBe(true);
  });

  it("reports an observation that has aged out rather than trusting it", () => {
    const snapshot = observedTenantSnapshot({
      platform: PLATFORM,
      objectApiName: "Opportunity",
      observedAt: "2026-09-02T10:00:00.000Z",
      fields: [{ apiName: "StageName", label: "Stage", type: "picklist", options: ["Prospecting"] }]
    });
    const anHourLater = Date.parse("2026-09-02T11:00:00.000Z");
    expect(staleObservedFields(snapshot, anHourLater, 30 * 60_000)).toEqual([
      { objectApiName: "Opportunity", apiName: "StageName", ageMs: 3_600_000 }
    ]);
    // Fresh, and therefore nothing to report.
    expect(staleObservedFields(snapshot, Date.parse("2026-09-02T10:05:00.000Z"), 30 * 60_000)).toEqual([]);
  });

  it("never calls installed metadata stale — only readings expire", () => {
    expect(staleObservedFields(snapshotLabelled("Stage", ["Prospecting"]), Date.now(), 1)).toEqual([]);
  });

  it("surfaces a disagreement between org metadata and the running application", () => {
    const metadata = snapshotLabelled("Stage", ["Prospecting", "Negotiation/Review", "Closed Won"]);
    const observed = observedTenantSnapshot({
      platform: PLATFORM,
      objectApiName: "Opportunity",
      observedAt: "2026-09-02T10:00:00.000Z",
      // The org renamed the field and this record type offers fewer values.
      fields: [{ apiName: "StageName", label: "Sales Stage", type: "picklist", options: ["Prospecting"] }]
    });
    const merged = mergeTenantSnapshots(metadata, observed);

    expect(merged.conflicts.map((conflict) => conflict.fact).sort()).toEqual(["label", "options"]);
    const stage = merged.snapshot.objects[0].fields.find((field) => field.apiName === "StageName");
    // Metadata keeps identity and label; the live reading governs the domain
    // for this execution, and is marked as a reading.
    expect(stage).toMatchObject({ label: "Stage", options: ["Prospecting"], source: "observed-live" });
  });

  it("takes the observation whole when no metadata is installed", () => {
    const observed = observedTenantSnapshot({
      platform: PLATFORM,
      objectApiName: "Opportunity",
      observedAt: "2026-09-02T10:00:00.000Z",
      fields: [{ apiName: "StageName", label: "Sales Stage", type: "picklist" }]
    });
    const merged = mergeTenantSnapshots(undefined, observed);
    expect(merged.conflicts).toEqual([]);
    expect(merged.snapshot).toBe(observed);
  });

  it("declines to determine a date representation it cannot establish", () => {
    // Every sample ambiguous: nothing is learned, and nothing is assumed.
    const undetermined = inferDateRepresentation(["01/02/2026", "03/04/2027"]);
    expect(undetermined.order).toBeUndefined();
    expect(undetermined.source).toBe("no-evidence");

    // Nothing to go on at all.
    expect(inferDateRepresentation([]).order).toBeUndefined();

    // Contradictory samples are a refusal, not a majority vote.
    expect(inferDateRepresentation(["25/12/2026", "12/25/2026"])).toMatchObject({ source: "conflicting" });
    expect(inferDateRepresentation(["25/12/2026", "12/25/2026"]).order).toBeUndefined();
  });
});

/* =================== 5. what a human answered stays what it was =================== */

describe("5 — canonicalization only renames what the vendor's model grounds", () => {
  it("leaves a custom field's input name alone, and says so", () => {
    const customOnly: TenantIntelligenceSnapshot = {
      platform: PLATFORM,
      orgId: "00D",
      objects: [
        {
          apiName: "Opportunity",
          fields: [
            { apiName: "CloseDate", label: "Close Date", type: "date" },
            { apiName: "Deal_Phase__c", label: "Deal Phase", type: "picklist", custom: true }
          ]
        }
      ]
    };
    const result = canonicalizeCapabilityInputs(
      proposedFromLabels("deal_phase"),
      traceLabelled("Deal Phase"),
      withTenant(customOnly)
    );
    // No vendor name exists for a field the vendor never shipped, so the
    // observed name stands rather than being renamed to something invented.
    expect(result.capability.inputs.map((input) => input.name).sort()).toEqual(["close_date", "deal_phase"]);
    expect(result.renames).toEqual([]);
    expect(result.tenantDerived).toContain("deal_phase");
  });

  it("never renames one input onto a name another input already holds", () => {
    const collision = proposedFromLabels("sales_stage");
    const withStageToo: SemanticCapability = {
      ...collision,
      inputs: [
        ...collision.inputs,
        { name: "stage", description: "something else entirely", type: "string", required: false }
      ]
    };
    const result = canonicalizeCapabilityInputs(
      withStageToo,
      traceLabelled("Sales Stage"),
      withTenant(snapshotLabelled("Sales Stage"))
    );
    expect(result.capability.inputs.filter((input) => input.name === "stage")).toHaveLength(1);
    expect(result.capability.inputs.map((input) => input.name)).toContain("sales_stage");
    expect(result.renames).toEqual([]);
  });
});
