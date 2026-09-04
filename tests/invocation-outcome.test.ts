// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  judgeInvocation,
  mayHavePersisted,
  memoryJournal,
  runOnce,
  type ExecutionPhase
} from "../src/binding/browserExecution/dispatch";
import type { ExecutionResult } from "../src/binding/browserExecution/result";
import { extensionBridgeExecutionClient } from "../src/training/browserExecutionClient";
import { nothingWasDispatched } from "../extension/src/protocol";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import { EXECUTION_TIMEOUTS, STUDIO_BRIDGE_PROTOCOL } from "../extension/src/protocol";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";

/* ------------------------------------------------------------------ *
 * A dispatched write that never answers.
 *
 * From a live Codex → WebMCP → AutoWebMCP → Salesforce run. The agent
 * invoked `update_opportunity`, the caller timed out, and the failure was
 * reported as a failure. The Opportunity had in fact been changed to
 * exactly what was asked for — so the agent, told the write had not
 * happened, ran it again.
 *
 * Both halves of that are defects. The caller cannot know an outcome it
 * never received, so it must not claim one; and a write whose outcome is
 * unknown must not be repeated on the assumption that it did not happen.
 * ------------------------------------------------------------------ */

const SOURCE = "autowebmcp-studio-bridge";
const MARKER = "data-autowebmcp-bridge";
const SALESFORCE = sourceApplicationFor("salesforce-lightning", "example.lightning.force.com");

const binding: BrowserExecutionBinding = {
  id: "browser-update_opportunity",
  capabilityId: "update_opportunity",
  sourceApplication: SALESFORCE,
  platform: "salesforce-lightning",
  context: { recordType: "Opportunity", pageMode: "edit-or-record" },
  inputs: [{ semanticInput: "stage", semanticTarget: { role: "field", label: "*Stage" }, valueKind: "select" }],
  commit: { semanticAction: { role: "button", label: "Save" } },
  verification: ["no-validation-error-visible"],
  safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
  evidence: []
};

const verified: ExecutionResult = {
  status: "succeeded",
  checks: [{ name: "target_identity", status: "pass", detail: "Same record throughout." }],
  transactions: [
    {
      name: "stage",
      beforeValue: "Establish",
      requestedValue: "Collaborate",
      afterWriteValue: "Collaborate",
      afterSaveValue: "Collaborate",
      verified: "yes",
      detail: "Value set."
    }
  ],
  evidence: [],
  warnings: [],
  target: { requestedId: "006A", beforeId: "006A", afterSaveId: "006A", status: "verified", detail: "" },
  executedAt: "2026-09-02T00:00:00.000Z"
};

let detach: (() => void) | undefined;

/**
 * A scripted stand-in for the extension's bridge content script.
 *
 * `answer` returning `undefined` is the case that matters most: a bridge
 * that takes the request and never replies, which is what a destroyed
 * content script looks like from here.
 */
function bridge(answer: (request: Record<string, unknown>) => Record<string, unknown> | undefined): void {
  document.documentElement.setAttribute(MARKER, String(STUDIO_BRIDGE_PROTOCOL));
  const listener = (event: MessageEvent): void => {
    const data = event.data as Record<string, unknown> | undefined;
    if (data?.source !== SOURCE || data.direction !== "request") return;
    const reply = answer(data);
    if (!reply) return;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: SOURCE, direction: "response", requestId: data.requestId, ...reply },
        source: window
      })
    );
  };
  window.addEventListener("message", listener);
  detach = () => window.removeEventListener("message", listener);
}

afterEach(() => {
  detach?.();
  detach = undefined;
  document.documentElement.removeAttribute(MARKER);
});

/* =============== the round trip, when nothing goes wrong =============== */

describe("a successful execution returns its verification evidence", () => {
  it("resolves with the four facts and the identity intact", async () => {
    let seen: Record<string, unknown> | undefined;
    bridge((request) => {
      seen = request;
      return { ok: true, protocol: STUDIO_BRIDGE_PROTOCOL, result: verified };
    });

    const result = await extensionBridgeExecutionClient.execute(binding, { stage: "Collaborate" }, {
      requireTarget: true
    });

    expect(result.status).toBe("succeeded");
    expect(result.transactions?.[0]).toMatchObject({
      beforeValue: "Establish",
      requestedValue: "Collaborate",
      afterWriteValue: "Collaborate",
      afterSaveValue: "Collaborate"
    });
    expect(result.target).toMatchObject({ requestedId: "006A", beforeId: "006A", afterSaveId: "006A" });
    // The agent path still demands a named record, and the attempt is
    // correlated end to end.
    expect(seen?.requireTarget).toBe(true);
    expect(typeof seen?.invocationId).toBe("string");
  });
});

/* ============ dispatched, and then nobody heard anything ============ */

describe("a lost answer is not a failed write", () => {
  it("reports an unknown outcome, never a known failure", async () => {
    // The live case exactly: the mutation succeeded and the response never
    // came back. Anything that reads as "it did not happen" here is the
    // sentence that sent an agent to do it twice.
    bridge(() => undefined);

    const result = await extensionBridgeExecutionClient.execute(binding, { stage: "Collaborate" }, {
      requireTarget: true
    });

    expect(result.status).toBe("unknown");
    expect(result.status).not.toBe("failed");
    expect(result.dispatch?.mayHavePersisted).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/not established/i);
    expect(result.warnings.join(" ")).toMatch(/read the record/i);
    // Waits out the real STUDIO budget of 50s, so 60s left ten seconds of
    // headroom and a busy machine took it — the test failed while asserting
    // exactly the behaviour it was asserting correctly, at 50004ms. The
    // budget being waited on is unchanged; only the harness's patience is.
  }, 90_000);

  it("says so when the extension reported the loss itself, rather than waiting it out", async () => {
    // The hop that actually gave up gets to name itself; the caller does
    // not have to spend its whole budget to learn nothing.
    bridge(() => ({
      ok: false,
      reason: "outcome-unknown",
      error: "The target tab accepted this execution and did not answer within 42s."
    }));

    const result = await extensionBridgeExecutionClient.execute(binding, { stage: "Collaborate" });
    expect(result.status).toBe("unknown");
    expect(result.warnings.join(" ")).toMatch(/did not answer within 42s/);
  });

  it("still calls it blocked when nothing could have been dispatched at all", async () => {
    // The other half of the distinction. A request that never reached a
    // page cannot have changed anything, and saying "unknown" about it
    // would be its own kind of dishonesty.
    bridge(() => ({
      ok: false,
      reason: "target-tab-not-registered",
      error: "No target tab is known."
    }));

    const result = await extensionBridgeExecutionClient.execute(binding, { stage: "Collaborate" });
    expect(result.status).toBe("blocked");
    expect(result.dispatch?.mayHavePersisted).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/nothing was changed/i);
  });
});

/* ================= where it got to decides what is safe ================= */

describe("how far an execution got is what makes a repeat safe or not", () => {
  const phases: ExecutionPhase[] = ["received", "target-opening", "editable", "resolved", "writing", "written"];

  it("treats everything up to the commit as having changed nothing", () => {
    // Values typed into an unsaved form are not a change to the record;
    // abandoning them leaves it as it was found.
    for (const phase of phases) expect(mayHavePersisted(phase)).toBe(false);
  });

  it("treats the commit and everything after it as possibly persisted", () => {
    for (const phase of ["saving", "saved", "verified", "reported"] as ExecutionPhase[]) {
      expect(mayHavePersisted(phase)).toBe(true);
    }
  });
});

/* ===================== one transaction, one mutation ===================== */

describe("the same invocation delivered twice performs one mutation", () => {
  const request = { invocationId: "inv-1", capabilityId: "update_opportunity", inputs: { stage: "Collaborate" } };

  it("replays the recorded outcome instead of executing again", async () => {
    const journal = memoryJournal();
    let mutations = 0;
    const execute = async (): Promise<ExecutionResult> => {
      mutations += 1;
      return verified;
    };

    const first = await runOnce(journal, request, execute);
    const second = await runOnce(journal, request, execute);

    expect(mutations).toBe(1);
    expect(second).toEqual(first);
  });

  it("does NOT collapse two different invocations that ask for the same thing", async () => {
    // The distinction the task turned on. Two calls asking for the same
    // close date are two transactions that happen to agree — and for a
    // capability like `create_task`, treating them as one would silently
    // drop work the caller asked for.
    const journal = memoryJournal();
    let mutations = 0;
    const execute = async (): Promise<ExecutionResult> => {
      mutations += 1;
      return verified;
    };

    await runOnce(journal, { ...request, invocationId: "inv-1" }, execute);
    await runOnce(journal, { ...request, invocationId: "inv-2" }, execute);
    expect(mutations).toBe(2);
  });
});

/* ================= never run an unknown write again ================= */

describe("a write whose outcome is unknown is not simply run again", () => {
  it("refuses a fresh invocation while an earlier one may have saved", async () => {
    const journal = memoryJournal();
    let mutations = 0;

    // An invocation that got as far as the commit and never reported —
    // the context that was running it is gone, so nothing will ever
    // complete this record.
    journal.write({
      invocationId: "inv-lost",
      capabilityId: "update_opportunity",
      inputs: { stage: "Collaborate" },
      startedAt: "2026-09-02T00:00:00.000Z",
      phase: "saving"
    });

    const result = await runOnce(
      journal,
      { invocationId: "inv-next", capabilityId: "update_opportunity", inputs: { stage: "Collaborate" } },
      async () => {
        mutations += 1;
        return verified;
      }
    );

    expect(mutations).toBe(0);
    expect(result.status).toBe("blocked");
    expect(result.warnings.join(" ")).toMatch(/may already have saved/i);
    expect(result.evidence.join(" ")).toMatch(/inv-lost/);

    // The refusal names what is blocking it in a form a caller can act on,
    // not only in a sentence. The Studio's acknowledgement control needs
    // this id, and recovering it by parsing the prose meant that rewording
    // the sentence would silently remove the only remedy for a refusal
    // that exists to be resolvable.
    expect(result.blockedBy).toEqual({
      invocationId: "inv-lost",
      startedAt: "2026-09-02T00:00:00.000Z",
      phase: "saving"
    });
    // And it is about the OTHER invocation. `dispatch` still describes this
    // attempt, which got nowhere.
    expect(result.dispatch?.invocationId).toBe("inv-next");
    expect(result.dispatch?.mayHavePersisted).toBe(false);
  });

  it("names nothing as blocking when nothing is", async () => {
    // `blockedBy` must not become a field that is always set: a result that
    // carried one when no earlier invocation was outstanding would offer an
    // acknowledgement for a transaction that does not exist.
    const journal = memoryJournal();
    const result = await runOnce(
      journal,
      { invocationId: "inv-only", capabilityId: "update_opportunity", inputs: {} },
      async () => verified
    );
    expect(result.blockedBy).toBeUndefined();
  });

  it("lets a fresh invocation through when the earlier one stopped before writing", async () => {
    // Opening the requested record stops the execution having touched
    // nothing at all, so invoking again is not merely permitted — it is
    // the documented next step.
    const journal = memoryJournal();
    journal.write({
      invocationId: "inv-opened",
      capabilityId: "update_opportunity",
      inputs: { stage: "Collaborate" },
      startedAt: "2026-09-02T00:00:00.000Z",
      phase: "target-opening"
    });

    let mutations = 0;
    const result = await runOnce(
      journal,
      { invocationId: "inv-next", capabilityId: "update_opportunity", inputs: { stage: "Collaborate" } },
      async () => {
        mutations += 1;
        return verified;
      }
    );

    expect(mutations).toBe(1);
    expect(result.status).toBe("succeeded");
  });

  it("does not let one capability's outstanding write block a different capability", () => {
    const journal = memoryJournal();
    journal.write({
      invocationId: "inv-lost",
      capabilityId: "update_opportunity",
      inputs: {},
      startedAt: "2026-09-02T00:00:00.000Z",
      phase: "saving"
    });
    expect(judgeInvocation(journal, "inv-other", "find_opportunity").action).toBe("proceed");
  });
});

/* ============ the journal has to outlive the thing it records ============ */

describe("progress is recorded as it happens, not when the run ends", () => {
  it("leaves the last reached phase behind even if the execution never returns", async () => {
    // The whole reason the phase is published outward: the context that
    // knows how far it got is the one being destroyed.
    const journal = memoryJournal();
    let reportedPhase: ((phase: ExecutionPhase) => void) | undefined;

    const running = runOnce(
      journal,
      { invocationId: "inv-1", capabilityId: "update_opportunity", inputs: {} },
      (report) =>
        new Promise<ExecutionResult>(() => {
          reportedPhase = report;
        })
    );
    void running;

    await Promise.resolve();
    reportedPhase?.("saving");

    const record = journal.read("inv-1");
    expect(record?.phase).toBe("saving");
    // Still unfinished, which is exactly what makes it blocking.
    expect(record?.outcome).toBeUndefined();
    expect(mayHavePersisted(record!.phase)).toBe(true);
  });
});

/* ==================== the ladder has to stay ordered ==================== */

describe("every hop waits longer than the hop inside it", () => {
  it("is ordered from the execution outward", () => {
    // The inversion this guards against is not hypothetical: execution was
    // bounded ONLY at the outermost step, so the account of a lost write
    // came from the hop that knew least about it. An outer step that ever
    // dips below an inner one reintroduces exactly that.
    const { EXECUTION, CONTENT_SCRIPT, BACKGROUND, STUDIO } = EXECUTION_TIMEOUTS;
    expect(EXECUTION).toBeLessThan(CONTENT_SCRIPT);
    expect(CONTENT_SCRIPT).toBeLessThan(BACKGROUND);
    expect(BACKGROUND).toBeLessThan(STUDIO);
  });
});

/* ========= a verified execution whose answer never got delivered ========= */

describe("execution evidence survives a delivery failure", () => {
  it("hands back the recorded verification when the same invocation is redelivered", async () => {
    // The live shape, and the reason the outcome is journalled rather than
    // merely returned: the mutation succeeded and was verified, and only
    // the delivery failed. That evidence still exists, and a redelivery of
    // the SAME transaction should hand it over rather than write again.
    const journal = memoryJournal();
    let mutations = 0;

    const lost = await runOnce(
      journal,
      { invocationId: "inv-1", capabilityId: "update_opportunity", inputs: { stage: "Collaborate" } },
      async () => {
        mutations += 1;
        return verified;
      }
    );
    expect(lost.status).toBe("succeeded");

    // …the caller never received that. It asks again with the same id.
    const redelivered = await runOnce(
      journal,
      { invocationId: "inv-1", capabilityId: "update_opportunity", inputs: { stage: "Collaborate" } },
      async () => {
        mutations += 1;
        return verified;
      }
    );

    expect(mutations).toBe(1);
    expect(redelivered.status).toBe("succeeded");
    expect(redelivered.transactions?.[0]).toMatchObject({
      beforeValue: "Establish",
      requestedValue: "Collaborate",
      afterSaveValue: "Collaborate"
    });
  });
});

/* ============ the record is opened from outside the dying page ============ */

describe("opening the requested record never depends on the page surviving", () => {
  /**
   * A stand-in for the hop that opens the record.
   *
   * Deliberately modelled the way the service worker actually behaves: it
   * is holding the answer BEFORE it navigates anything, so the navigation
   * cannot cost the answer. The earlier design had the page navigate
   * itself just after replying, and a live agent invocation waited seventy
   * seconds and got nothing — while the identical tool call against an
   * already-open record passed every check.
   */
  function deliver(result: ExecutionResult, tabUrl: string) {
    const navigations: string[] = [];
    const route = result.dispatch?.openRecordAt;
    let delivered: ExecutionResult | undefined;
    delivered = result; // answer in hand first
    if (route) {
      const target = new URL(route, tabUrl);
      if (target.origin === new URL(tabUrl).origin) navigations.push(target.href);
    }
    return { delivered, navigations };
  }

  const opening: ExecutionResult = {
    status: "blocked",
    dispatch: {
      invocationId: "inv-1",
      phase: "target-opening",
      mayHavePersisted: false,
      openRecordAt: "/lightning/r/Opportunity/0065w00002AZ0GeAAL/view"
    },
    checks: [],
    evidence: [],
    warnings: ["Execution stopped before touching anything. Invoke again."],
    executedAt: "2026-09-03T00:00:00.000Z"
  };

  it("still returns the result it was given, and opens the record too", () => {
    const { delivered, navigations } = deliver(opening, "https://x.lightning.force.com/lightning/o/Opportunity/list");
    // Both, and in that order — the answer is never traded for the navigation.
    expect(delivered?.status).toBe("blocked");
    expect(delivered?.dispatch?.mayHavePersisted).toBe(false);
    expect(navigations).toEqual(["https://x.lightning.force.com/lightning/r/Opportunity/0065w00002AZ0GeAAL/view"]);
  });

  it("navigates nowhere when the execution did not stop for a record", () => {
    const done: ExecutionResult = { ...verified, dispatch: { phase: "verified", mayHavePersisted: true } };
    const { delivered, navigations } = deliver(done, "https://x.lightning.force.com/lightning/r/Opportunity/006A/view");
    expect(delivered?.status).toBe("succeeded");
    expect(navigations).toEqual([]);
  });

  it("refuses to send the tab to another origin", () => {
    // A route is a path from the platform's own pack and means nothing
    // outside the tab it came from. One that somehow carries an origin
    // must not move the tab off the application it belongs to.
    const hostile: ExecutionResult = {
      ...opening,
      dispatch: { ...opening.dispatch!, openRecordAt: "https://elsewhere.example/lightning/r/Opportunity/006A/view" }
    };
    const { delivered, navigations } = deliver(hostile, "https://x.lightning.force.com/lightning/o/Opportunity/list");
    expect(delivered?.status).toBe("blocked");
    expect(navigations).toEqual([]);
  });
});

/* ========== a refusal that cannot be lifted is a deadlock ========== */

describe("an outstanding write can be acknowledged and stops blocking", () => {
  const outstanding = {
    invocationId: "inv-lost",
    capabilityId: "update_opportunity",
    inputs: { stage: "Collaborate" },
    startedAt: "2026-09-03T18:22:26.611Z",
    phase: "verified" as ExecutionPhase
  };

  it("blocks until someone says they established what it did", async () => {
    // The live deadlock: an entry left at a phase past the commit blocked
    // its capability permanently, while the message told the reader to
    // establish what happened and offered no way to say that they had.
    const journal = memoryJournal();
    journal.write(outstanding);

    let mutations = 0;
    const run = async (): Promise<ExecutionResult> => {
      mutations += 1;
      return verified;
    };
    const request = { invocationId: "inv-next", capabilityId: "update_opportunity", inputs: {} };

    expect((await runOnce(journal, request, run)).status).toBe("blocked");
    expect(mutations).toBe(0);

    // Someone reads the record and says so.
    const after = await runOnce(journal, { ...request, acknowledges: "inv-lost" }, run);
    expect(after.status).toBe("succeeded");
    expect(mutations).toBe(1);
  });

  it("does not have to be acknowledged twice", async () => {
    // The acknowledgement is a fact about the OLD transaction, so it
    // outlives the attempt that carried it — including one that also loses
    // its answer.
    const journal = memoryJournal();
    journal.write(outstanding);
    await runOnce(journal, { invocationId: "a", capabilityId: "update_opportunity", inputs: {}, acknowledges: "inv-lost" }, async () => verified);

    const later = await runOnce(journal, { invocationId: "b", capabilityId: "update_opportunity", inputs: {} }, async () => verified);
    expect(later.status).toBe("succeeded");
  });

  it("acknowledges one transaction, not everything outstanding", async () => {
    // A blanket "force" would wave through a second write nobody has
    // looked at. Naming the id keeps the remaining one blocking.
    const journal = memoryJournal();
    journal.write(outstanding);
    journal.write({ ...outstanding, invocationId: "inv-other", phase: "saving" });

    const result = await runOnce(
      journal,
      { invocationId: "inv-next", capabilityId: "update_opportunity", inputs: {}, acknowledges: "inv-lost" },
      async () => verified
    );
    expect(result.status).toBe("blocked");
    expect(result.evidence.join(" ")).toMatch(/inv-other/);
  });
});

/* ------------------------------------------------------------------ *
 * Which failures prove nothing happened.
 *
 * "Unknown outcome" is this system's most serious signal: it stops an
 * agent loop, refuses a retry, and sends a person to reconcile a record by
 * hand. It is only worth that much if it is reserved for cases that are
 * genuinely unknown — a false alarm teaches people to ignore the real one.
 *
 * A live run produced exactly that false alarm. An extension reload left
 * the Studio tab's bridge disconnected; the bridge declined to send, said
 * so, and the unnamed error was classified as "dispatched, outcome
 * unknown" — telling someone to go and reconcile a Salesforce record
 * against a request that had never left their own browser tab.
 * ------------------------------------------------------------------ */
describe("a failure only means nothing happened when a hop says it refused", () => {
  it("proves nothing was dispatched when a hop reports its own refusal", () => {
    // Each of these is some hop saying "I did not pass this on", before
    // anything downstream was asked.
    expect(nothingWasDispatched("extension-unavailable")).toBe(true);
    expect(nothingWasDispatched("studio-bridge-outdated")).toBe(true);
    expect(nothingWasDispatched("studio-bridge-disconnected")).toBe(true);
    expect(nothingWasDispatched("target-tab-not-registered")).toBe(true);
  });

  it("never assumes it about a silence, or about a reason that names nothing", () => {
    // A tab that stopped answering may still be working; a send may already
    // have landed when it was reported unreachable; and the catch-all names
    // no hop at all. Reading any of these as "nothing happened" is how a
    // write that succeeded gets performed twice.
    expect(nothingWasDispatched("introspection-timeout")).toBe(false);
    expect(nothingWasDispatched("target-tab-unreachable")).toBe(false);
    expect(nothingWasDispatched("content-script-unavailable")).toBe(false);
    expect(nothingWasDispatched("introspection-failed")).toBe(false);
    expect(nothingWasDispatched("outcome-unknown")).toBe(false);
    expect(nothingWasDispatched(undefined)).toBe(false);
  });
});
