// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { executeConfirmed } from "../src/binding/browserExecution/execute";
import { identityFromPath, sameEntity, type EntityIdentityPolicy } from "../src/binding/browserExecution/entityIdentity";
import { entityIdentityPolicyForPlatform, resolverAdapterForPlatform } from "../src/binding/browserExecution/adapters";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";
import type { PlatformResolverAdapter } from "../src/binding/browserExecution/engine";

/* ------------------------------------------------------------------ *
 * Which record did we actually change?
 *
 * The defect these exist for: a binding knew the object TYPE it was taught
 * on and nothing about WHICH record, so executing meant "change whatever
 * Opportunity is open". That is safe only because a human deliberately
 * opened it — and an agent invoking the published tool has chosen nothing.
 *
 * Field verification cannot catch this. Writing the requested Stage to the
 * wrong Opportunity passes every field check there is: requested, written,
 * saved, and read back, all correct, on a record nobody asked for. Identity
 * is a second dimension and is verified separately, before the write and
 * again after the save.
 * ------------------------------------------------------------------ */

const SALESFORCE = sourceApplicationFor("salesforce-lightning", "nvent-dev-ed.lightning.force.com");
const POLICY = entityIdentityPolicyForPlatform("salesforce-lightning") as EntityIdentityPolicy;

const RECORD_A = "006AAAAAAAAAAAAAAA";
const RECORD_B = "006BBBBBBBBBBBBBBB";

function bindingFor(options: { identityGated: boolean }): BrowserExecutionBinding {
  return {
    id: "browser-update_opportunity-salesforce-lightning",
    capabilityId: "update_opportunity",
    sourceApplication: SALESFORCE,
    platform: "salesforce-lightning",
    context: {
      recordType: "Opportunity",
      pageMode: "edit-or-record",
      ...(options.identityGated ? { target: { inputName: "opportunity_id", entityType: "Opportunity" } } : {})
    },
    inputs: [
      {
        semanticInput: "stage",
        semanticTarget: { role: "field", label: "Stage", applicationIdentifier: "StageName" },
        valueKind: "text",
        required: true
      }
    ],
    commit: { semanticAction: { role: "button", label: "Save" } },
    verification: ["edit-state-closed", "returned-to-record-view", "field-value-observable", "no-validation-error-visible"],
    safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
    evidence: []
  };
}

/**
 * A form that saves correctly and reports whichever record the test says is
 * open. The point of the hard case below is that this form behaves
 * perfectly: the write really happens and really persists — on the wrong
 * record.
 */
function mountEditForm(): HTMLElement {
  document.body.innerHTML = `
    <div role="dialog" aria-modal="true" id="edit-dialog">
      <label for="st">Stage</label>
      <input id="st" name="StageName" type="text" value="Engage" />
      <label for="am">Amount</label>
      <input id="am" name="Amount" value="50000" />
      <button id="save">Save</button><button>Cancel</button>
    </div>
  `;
  document.querySelector("#save")!.addEventListener("click", () => {
    const dialog = document.querySelector("#edit-dialog")!;
    dialog.removeAttribute("role");
    dialog.removeAttribute("aria-modal");
    for (const control of dialog.querySelectorAll("button")) (control as HTMLElement).hidden = true;
  });
  return document.body;
}

/**
 * The real adapter, with only identity observation overridden so a test can
 * say which record is open — and change it mid-execution.
 */
function adapterOnRecord(
  sequence: (string | undefined)[],
  /**
   * What navigating does. Omitted means the platform cannot navigate at
   * all, which is a real case — a platform with no declared route leaves
   * the caller to open the record.
   */
  navigate?: { lands: string | undefined; ok?: boolean }
): PlatformResolverAdapter {
  const base = resolverAdapterForPlatform("salesforce-lightning")!;
  let call = 0;
  let current: string | undefined;
  const next = (): string | undefined => {
    const id = current ?? sequence[Math.min(call, sequence.length - 1)];
    call += 1;
    return id;
  };
  return {
    ...base,
    observeEntityIdentity() {
      const id = next();
      return id ? { id, entityType: "Opportunity" } : undefined;
    },
    ...(navigate
      ? {
          navigateToEntity: async () => {
            // Where the browser actually ended up, which is not necessarily
            // where it was asked to go.
            current = navigate.lands;
            return navigate.ok === false
              ? { ok: false, detail: "Navigation failed." }
              : { ok: true, detail: `Navigated to ${navigate.lands}.` };
          }
        }
      : { navigateToEntity: undefined })
  };
}

/**
 * `requireTarget` is the AGENT path. Defaulted on here because most of
 * these cover autonomous invocation; the manual-test cases pass it false
 * explicitly, which is the distinction the whole gate turns on.
 */
const run = (
  adapter: PlatformResolverAdapter,
  inputs: Record<string, string>,
  options: { identityGated?: boolean; requireTarget?: boolean } = {}
) =>
  executeConfirmed({
    root: mountEditForm(),
    binding: bindingFor({ identityGated: options.identityGated ?? true }),
    inputs,
    adapter,
    confirmed: true,
    ...(options.requireTarget === false ? {} : { requireTarget: true }),
    reaction: { timeoutMs: 40, quietMs: 10 },
    resolveRetryMs: 50
  });

const stageValue = () => (document.querySelector("#st") as HTMLInputElement).value;

/* ===================== the invariant that matters ===================== */

describe("correct values on the wrong record must never read as success", () => {
  it("fails when the record swaps mid-execution, though every field check passes", () => {
    // THE test. The write succeeds, the save succeeds, and the field reads
    // back exactly as requested — on a different record than the one
    // verified before writing. Field-level verification alone would call
    // this a clean success.
    return run(adapterOnRecord([RECORD_A, RECORD_B]), { opportunity_id: RECORD_A, stage: "Confirm" }).then((result) => {
      // The field work genuinely succeeded.
      expect(stageValue()).toBe("Confirm");
      expect(result.checks.find((check) => check.name === "value_set")?.status).toBe("pass");
      expect(result.transactions?.[0]?.verified).toBe("yes");

      // And the execution is still a failure, because of identity alone.
      expect(result.status).toBe("failed");
      const identity = result.checks.filter((check) => check.name === "target_identity");
      expect(identity.at(-1)?.status).toBe("fail");
      expect(result.target?.status).toBe("mismatch");
      expect(result.target).toMatchObject({ requestedId: RECORD_A, beforeId: RECORD_A, afterSaveId: RECORD_B });
    });
  });
});

/* ========================= the pre-write gate ========================= */

describe("the target is established before anything is touched", () => {
  it("proceeds when the requested record is the one open", async () => {
    const result = await run(adapterOnRecord([RECORD_A]), { opportunity_id: RECORD_A, stage: "Confirm" });
    expect(result.target?.status).toBe("verified");
    expect(result.checks.find((check) => check.name === "target_identity")?.status).toBe("pass");
    expect(stageValue()).toBe("Confirm");
  });

  it("refuses without mutating anything when it cannot open the requested record", async () => {
    // No navigation available: the platform declares no route, so the
    // record must already be open and this one is not.
    const result = await run(adapterOnRecord([RECORD_B]), { opportunity_id: RECORD_A, stage: "Confirm" });

    expect(result.status).toBe("blocked");
    expect(result.target?.status).toBe("mismatch");
    // Nothing was written, and no edit surface was even opened: the gate
    // sits before page state precisely so a refusal costs nothing.
    expect(stageValue()).toBe("Engage");
    expect(result.transactions).toBeUndefined();
    expect(result.checks.some((check) => check.name === "editable_state")).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/no way to open a record/i);
  });

  it("refuses when the platform cannot say which record is open", async () => {
    // Never infer identity from a name or assume the open record is right.
    const result = await run(adapterOnRecord([undefined]), { opportunity_id: RECORD_A, stage: "Confirm" });
    expect(result.status).toBe("blocked");
    expect(result.target?.status).toBe("unobservable");
    expect(stageValue()).toBe("Engage");
  });

  it("refuses an autonomous invocation that supplied no identity", async () => {
    const result = await run(adapterOnRecord([RECORD_A]), { stage: "Confirm" });
    expect(result.status).toBe("blocked");
    expect(result.warnings.join(" ")).toMatch(/must say which record it means/i);
    expect(stageValue()).toBe("Engage");
  });
});

describe("the execution opens the record it was asked for", () => {
  it("navigates when a different record is showing, then writes", async () => {
    // The gap that made this unusable by an agent: it had opened nothing
    // and could open nothing, so a capability that only acts on what is
    // already showing could never be called.
    const result = await run(adapterOnRecord([RECORD_B], { lands: RECORD_A }), {
      opportunity_id: RECORD_A,
      stage: "Confirm"
    });

    expect(result.target?.status).toBe("verified");
    expect(result.checks.find((check) => check.name === "target_identity")?.status).toBe("pass");
    expect(result.evidence.join(" ")).toMatch(/navigated to/i);
    expect(stageValue()).toBe("Confirm");
  });

  it("refuses when navigation lands somewhere else", async () => {
    // Navigating is not arriving. A route that redirects — a deleted
    // record, a permission failure — lands elsewhere, and writing there is
    // exactly the failure this gate exists to stop.
    const result = await run(adapterOnRecord([RECORD_B], { lands: "006CCCCCCCCCCCCCCC" }), {
      opportunity_id: RECORD_A,
      stage: "Confirm"
    });

    expect(result.status).toBe("blocked");
    expect(result.target?.status).toBe("mismatch");
    expect(stageValue()).toBe("Engage");
    expect(result.warnings.join(" ")).toMatch(/could not reach/i);
  });

  it("refuses when navigation itself fails", async () => {
    const result = await run(adapterOnRecord([RECORD_B], { lands: RECORD_B, ok: false }), {
      opportunity_id: RECORD_A,
      stage: "Confirm"
    });
    expect(result.status).toBe("blocked");
    expect(stageValue()).toBe("Engage");
  });
});

/* ================== the human-driven path is unchanged ================== */

describe("the Studio's manual test still operates on the open record", () => {
  it("runs an ungated binding without demanding an identity", async () => {
    // A human testing a binding chose the record by opening it. That path
    // must keep working — the asymmetry with the agent contract is the
    // point, not an oversight.
    const result = await run(adapterOnRecord([RECORD_A]), { stage: "Confirm" }, {
      identityGated: false,
      requireTarget: false
    });
    expect(result.target?.status).toBe("not-required");
    expect(stageValue()).toBe("Confirm");
    expect(result.status).not.toBe("blocked");
  });

  it("runs a GATED binding manually, on the record the human opened", async () => {
    // The combination a live run caught and this suite had missed: gated
    // binding, manual invocation. Whether an identity is required is the
    // CALLER's question — a binding declaring a target says what would
    // identify the entity, not that every invocation must name one.
    // Reading those as the same thing made the Studio's own test refuse
    // itself the moment proposals began declaring targets.
    const result = await run(adapterOnRecord([RECORD_A]), { stage: "Confirm" }, { requireTarget: false });
    expect(result.target?.status).toBe("not-required");
    expect(result.status).not.toBe("blocked");
    expect(stageValue()).toBe("Confirm");
  });

  it("verifies an identity supplied manually, rather than ignoring it", async () => {
    // Supplying one without being asked is still a claim about which record
    // this is, and a wrong one must not be waved through just because the
    // caller was a human.
    const result = await run(adapterOnRecord([RECORD_B]), { opportunity_id: RECORD_A, stage: "Confirm" }, {
      requireTarget: false
    });
    expect(result.status).toBe("blocked");
    expect(result.target?.status).toBe("mismatch");
    expect(stageValue()).toBe("Engage");
  });
});

/* ===================== the generic identity model ===================== */

describe("identity is read from declared platform knowledge, not from code", () => {
  it("extracts object and id from the route pattern the pack declares", () => {
    expect(identityFromPath(`/lightning/r/Opportunity/${RECORD_A}/view`, POLICY)).toEqual({
      entityType: "Opportunity",
      id: RECORD_A
    });
    expect(identityFromPath(`/lightning/r/Account/${RECORD_B}/edit`, POLICY)).toEqual({
      entityType: "Account",
      id: RECORD_B
    });
  });

  it("reports no identity for a page that encodes none", () => {
    expect(identityFromPath("/lightning/o/Opportunity/list", POLICY)).toBeUndefined();
    expect(identityFromPath("/", POLICY)).toBeUndefined();
  });

  it("treats a malformed declared pattern as unobservable rather than throwing", () => {
    // A bad pack entry must make mutation refuse, not crash an execution
    // halfway through one.
    const broken: EntityIdentityPolicy = { ...POLICY, routePattern: "(?<id>[" };
    expect(identityFromPath("/lightning/r/Opportunity/006/view", broken)).toBeUndefined();
  });

  it("compares ids exactly, with no normalization", () => {
    // Salesforce's 15- and 18-character ids are the classic temptation.
    // Treating unequal strings as equal is how a write reaches the wrong
    // record; any such equivalence must be declared knowledge, not assumed.
    expect(sameEntity({ id: RECORD_A }, { id: RECORD_A })).toBe(true);
    expect(sameEntity({ id: RECORD_A }, { id: RECORD_A.slice(0, 15) })).toBe(false);
    expect(sameEntity({ id: RECORD_A }, { id: RECORD_A.toLowerCase() })).toBe(false);
  });

  it("holds entity type against entity type only when both state one", () => {
    expect(sameEntity({ id: RECORD_A, entityType: "Opportunity" }, { id: RECORD_A })).toBe(true);
    expect(
      sameEntity({ id: RECORD_A, entityType: "Opportunity" }, { id: RECORD_A, entityType: "Account" })
    ).toBe(false);
  });

  it("reads identities for platforms that look nothing like Salesforce", () => {
    // The real proof of genericity is behavioural, not a text search: the
    // same reader handles other identity schemes purely from a declared
    // pattern, which is what lets a second platform arrive as a pack entry
    // rather than an engine change.
    const jira: EntityIdentityPolicy = {
      routePattern: "/browse/(?<id>(?<entity>[A-Z]+)-\\d+)",
      canonicalRoutePattern: "^/browse/(?<id>(?<entity>[A-Z]+)-\\d+)$",
      trustworthyForMutation: true,
      routeTemplate: "/browse/{id}"
    };
    expect(identityFromPath("/browse/AUTO-1421", jira)).toEqual({ entityType: "AUTO", id: "AUTO-1421" });

    // A composite identity — repo plus number — carried as one opaque id.
    const github: EntityIdentityPolicy = {
      routePattern: "/(?<entity>[^/]+/[^/]+)/issues/(?<id>\\d+)",
      canonicalRoutePattern: "^/(?<entity>[^/]+/[^/]+)/issues/(?<id>\\d+)$",
      trustworthyForMutation: true,
      routeTemplate: "/{entity}/issues/{id}"
    };
    expect(identityFromPath("/acme/widgets/issues/42", github)).toEqual({ entityType: "acme/widgets", id: "42" });
  });
});

/* ============ the real adapter reads the real location ============ */

describe("the Salesforce adapter observes identity from the live page", () => {
  it("reads the open record from the document's own path", () => {
    // Closes the seam between "the pattern parses a path" and "the adapter
    // actually asks the document for one" — every other test here stubs
    // observation, so nothing else would catch this being unwired.
    window.history.pushState({}, "", `/lightning/r/Opportunity/${RECORD_A}/view`);
    const adapter = resolverAdapterForPlatform("salesforce-lightning")!;
    expect(adapter.observeEntityIdentity?.(document, adapter.resolutionPolicy!)).toEqual({
      entityType: "Opportunity",
      id: RECORD_A
    });
  });

  it("reports no identity on a page that is not a record", () => {
    window.history.pushState({}, "", "/lightning/o/Opportunity/list");
    const adapter = resolverAdapterForPlatform("salesforce-lightning")!;
    expect(adapter.observeEntityIdentity?.(document, adapter.resolutionPolicy!)).toBeUndefined();
  });
});

/* ================= the published contract requires it ================= */

describe("the agent-facing contract carries the targeting parameter", () => {
  it("adds an identity input the human never demonstrated, before confirmation", async () => {
    const { groundCapability } = await import("../src/training/semanticGrounding");
    const { applicationIntelligenceForPlatform } = await import("../src/binding/browserExecution/adapters");
    const { emptyTenantIntelligence } = await import("../src/applicationIntelligence/tenant");
    const { CaptureSession } = await import("../src/capture/session");

    const page = { host: "x.lightning.force.com", path: `/lightning/r/Opportunity/${RECORD_A}/view` };
    const session = new CaptureSession("s", 0, { host: page.host, platform: "salesforce-lightning", title: "Opp" });
    session.addMany([
      { id: "n", kind: "navigate", t: 1, page },
      {
        id: "c",
        kind: "field_change",
        t: 2,
        page,
        element: { tag: "input", name: "CloseDate", label: "*Close Date" },
        field: { label: "*Close Date", section: "D", control: "date" },
        value: { masked: false, to: "2027-03-25" }
      },
      { id: "s", kind: "click", t: 3, page, actionLabel: "Save" }
    ]);
    session.stop(4);

    const grounded = groundCapability(
      {
        id: "update_opportunity",
        name: "Update opportunity",
        description: "d",
        inputs: [{ name: "close_date", description: "The close date", type: "date", required: true }],
        outputs: [],
        provenance: { source: "inferred", observationIds: [], confirmedByHuman: false, sourceApplication: SALESFORCE },
        safety: { readOnly: false, requiresConfirmation: true }
      },
      session.toTrace(),
      applicationIntelligenceForPlatform("salesforce-lightning", emptyTenantIntelligence())
    );

    const identity = grounded.capability.inputs.find((input) => input.role === "target-identity");
    expect(identity).toMatchObject({ name: "opportunity_id", required: true, type: "string" });
    expect(grounded.targetIdentity?.entityType).toBe("Opportunity");
    // Contributed by the system, so it must be visible before approval —
    // and the confirmation it invalidates is a separate question the
    // grounding lifecycle already answers.
    expect(grounded.capability.provenance.confirmedByHuman).toBe(false);
  });

  it("publishes it as a required parameter an agent must supply", async () => {
    const { compileCapability } = await import("../src/webmcp/compiler");
    const tool = compileCapability(
      {
        id: "update_opportunity",
        name: "u",
        description: "d",
        inputs: [
          {
            name: "opportunity_id",
            description: "Which Opportunity to act on",
            type: "string",
            required: true,
            role: "target-identity"
          },
          { name: "stage", description: "The stage", type: "string", required: false }
        ],
        outputs: [],
        provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true },
        safety: { readOnly: false, requiresConfirmation: true }
      },
      () => ({})
    );
    expect(tool.inputSchema.required).toContain("opportunity_id");
    expect(tool.inputSchema.properties["opportunity_id"]).toBeDefined();
  });

  it("derives the parameter name from the entity, for entities that are not Opportunities", async () => {
    // Nothing about this is Opportunity-specific: the convention is
    // agent-facing vocabulary applied to whatever entity the application
    // says the capability acts on.
    const { identityInputNameFor } = await import("../src/applicationIntelligence/targetIdentity");
    expect(identityInputNameFor("Opportunity")).toBe("opportunity_id");
    expect(identityInputNameFor("Account")).toBe("account_id");
    expect(identityInputNameFor("Custom_Object__c")).toBe("custom_object_id");
    expect(identityInputNameFor("WorkOrderLineItem")).toBe("work_order_line_item_id");
  });

  it("requires nothing when the platform declares no identity scheme", async () => {
    // An application whose pages expose nothing stable gets no invented
    // parameter — a requirement nothing could verify would be theatre.
    const { targetIdentityFor } = await import("../src/applicationIntelligence/targetIdentity");
    expect(targetIdentityFor("some-unknown-platform", "Widget")).toBeUndefined();
    expect(targetIdentityFor("salesforce-lightning", undefined)).toBeUndefined();
  });
});
