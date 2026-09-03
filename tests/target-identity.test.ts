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
function adapterOnRecord(sequence: (string | undefined)[]): PlatformResolverAdapter {
  const base = resolverAdapterForPlatform("salesforce-lightning")!;
  let call = 0;
  return {
    ...base,
    observeEntityIdentity() {
      const id = sequence[Math.min(call, sequence.length - 1)];
      call += 1;
      return id ? { id, entityType: "Opportunity" } : undefined;
    }
  };
}

const run = (adapter: PlatformResolverAdapter, inputs: Record<string, string>, identityGated = true) =>
  executeConfirmed({
    root: mountEditForm(),
    binding: bindingFor({ identityGated }),
    inputs,
    adapter,
    confirmed: true,
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

  it("refuses without mutating anything when a different record is open", async () => {
    const result = await run(adapterOnRecord([RECORD_B]), { opportunity_id: RECORD_A, stage: "Confirm" });

    expect(result.status).toBe("blocked");
    expect(result.target?.status).toBe("mismatch");
    // Nothing was written, and no edit surface was even opened: the gate
    // sits before page state precisely so a refusal costs nothing.
    expect(stageValue()).toBe("Engage");
    expect(result.transactions).toBeUndefined();
    expect(result.checks.some((check) => check.name === "editable_state")).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/will not write to a record that was not asked for/i);
  });

  it("refuses when the platform cannot say which record is open", async () => {
    // Never infer identity from a name or assume the open record is right.
    const result = await run(adapterOnRecord([undefined]), { opportunity_id: RECORD_A, stage: "Confirm" });
    expect(result.status).toBe("blocked");
    expect(result.target?.status).toBe("unobservable");
    expect(stageValue()).toBe("Engage");
  });

  it("refuses an identity-gated invocation that supplied no identity", async () => {
    const result = await run(adapterOnRecord([RECORD_A]), { stage: "Confirm" });
    expect(result.status).toBe("blocked");
    expect(result.warnings.join(" ")).toMatch(/must say which record it means/i);
    expect(stageValue()).toBe("Engage");
  });
});

/* ================== the human-driven path is unchanged ================== */

describe("the Studio's manual test still operates on the open record", () => {
  it("runs an ungated binding without demanding an identity", async () => {
    // A human testing a binding chose the record by opening it. That path
    // must keep working — the asymmetry with the agent contract is the
    // point, not an oversight.
    const result = await run(adapterOnRecord([RECORD_A]), { stage: "Confirm" }, false);
    expect(result.target?.status).toBe("not-required");
    expect(stageValue()).toBe("Confirm");
    expect(result.status).not.toBe("blocked");
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
      trustworthyForMutation: true,
      routeTemplate: "/browse/{id}"
    };
    expect(identityFromPath("/browse/AUTO-1421", jira)).toEqual({ entityType: "AUTO", id: "AUTO-1421" });

    // A composite identity — repo plus number — carried as one opaque id.
    const github: EntityIdentityPolicy = {
      routePattern: "/(?<entity>[^/]+/[^/]+)/issues/(?<id>\\d+)",
      trustworthyForMutation: true,
      routeTemplate: "/{entity}/issues/{id}"
    };
    expect(identityFromPath("/acme/widgets/issues/42", github)).toEqual({ entityType: "acme/widgets", id: "42" });
  });
});
