// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionBridgeExecutionClient } from "../src/training/browserExecutionClient";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { BrowserExecutionBinding } from "../src/binding/browserExecution/model";

/* ------------------------------------------------------------------ *
 * Which hop failed, and saying so.
 *
 * A live run reported "No response from the Teach Mode extension" after a
 * twenty-second wait. The real cause was an installed-but-older bridge
 * that returned early on any request kind it did not recognize — so a
 * stale extension, an absent one, an unregistered target tab, and a dead
 * content script all produced the same unhelpful sentence.
 *
 * These cases drive the Studio's own client against a scripted bridge, so
 * each hop's failure is proven distinguishable.
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

let detach: (() => void) | undefined;

/** Installs a scripted stand-in for the extension's bridge content script. */
function bridge(
  answer: (request: Record<string, unknown>) => Record<string, unknown> | undefined,
  protocol: number | null = 3
): void {
  if (protocol !== null) document.documentElement.setAttribute(MARKER, String(protocol));
  const listener = (event: MessageEvent): void => {
    const data = event.data as Record<string, unknown> | undefined;
    if (data?.source !== SOURCE || data.direction !== "request") return;
    const reply = answer(data);
    if (!reply) return; // a bridge that drops the request, as the old one did
    // Dispatched rather than posted: jsdom's postMessage does not set
    // `event.source`, and the client rightly refuses messages that did not
    // come from its own window.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: SOURCE, direction: "response", requestId: data.requestId, ...reply },
        source: window as unknown as MessageEventSource
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
  vi.useRealTimers();
});

describe("A — the whole path works and the options come back", () => {
  it("returns the inspection", async () => {
    bridge((request) =>
      request.kind === "inspect"
        ? {
            ok: true,
            inspection: {
              options: { stage: ["Prospecting", "Closed Won"] },
              unresolved: {},
              initialPageState: "record-view",
              finalPageState: "record-view",
              ownership: { enteredEditMode: true, openedControls: ["stage"] },
              restoration: { control: "proven", page: "proven" },
              evidence: []
            }
          }
        : { ok: true, protocol: 3 }
    );

    const result = await extensionBridgeExecutionClient.acquireDomains(binding);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inspection.options.stage).toEqual(["Prospecting", "Closed Won"]);
  });
});

describe("B — no extension at all", () => {
  it("reports extension-unavailable without waiting out the full request budget", async () => {
    // No marker, no listener: nothing answers.
    const result = await extensionBridgeExecutionClient.acquireDomains(binding);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("extension-unavailable");
    expect(result.detail).toMatch(/not be installed or enabled|older version/i);
  });
});

describe("the exact live failure — an installed bridge that predates this request", () => {
  it("is reported as out of date, not as a missing extension", async () => {
    // An older protocol announced: installed, enabled, and too old to
    // understand the request this page is about to send.
    bridge(() => undefined, 2);
    const result = await extensionBridgeExecutionClient.acquireDomains(binding);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("studio-bridge-outdated");
    expect(result.detail).toMatch(/out of date/i);
    expect(result.detail).toMatch(/chrome:\/\/extensions/);
  });

  it("an old bridge that answers nothing at all still fails fast, with actionable wording", async () => {
    bridge(() => undefined, null);
    const started = Date.now();
    const result = await extensionBridgeExecutionClient.acquireDomains(binding);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The probe's budget, not the request's: the user is not made to wait
    // 25 seconds to be told the extension never answered.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.detail).toMatch(/older version that predates this feature/i);
  });
});

describe("C & D — failures inside the extension name their own hop", () => {
  it("C — the target tab is not registered", async () => {
    bridge((request) =>
      request.kind === "inspect"
        ? {
            ok: false,
            reason: "target-tab-not-registered",
            error: "No target tab is known. Start a Teach Mode session on the target application first."
          }
        : { ok: true, protocol: 3 }
    );
    const result = await extensionBridgeExecutionClient.acquireDomains(binding);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("target-tab-not-registered");
    expect(result.detail).toMatch(/Start a Teach Mode session/);
  });

  it("D — the content script could not be reached, which is a different thing", async () => {
    bridge((request) =>
      request.kind === "inspect"
        ? { ok: false, reason: "content-script-unavailable", error: "The content script could not be injected." }
        : { ok: true, protocol: 3 }
    );
    const result = await extensionBridgeExecutionClient.acquireDomains(binding);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("content-script-unavailable");
  });

  it("the target tab itself being unreachable is distinguished again", async () => {
    bridge((request) =>
      request.kind === "inspect"
        ? { ok: false, reason: "target-tab-unreachable", error: "The target tab could not be reached." }
        : { ok: true, protocol: 3 }
    );
    const result = await extensionBridgeExecutionClient.acquireDomains(binding);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("target-tab-unreachable");
  });
});

describe("E — introspection itself failing is its own reason", () => {
  it("reports introspection-failed with the underlying detail", async () => {
    bridge((request) =>
      request.kind === "inspect"
        ? { ok: false, reason: "introspection-failed", error: "the component exploded while opening" }
        : { ok: true, protocol: 3 }
    );
    const result = await extensionBridgeExecutionClient.acquireDomains(binding);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("introspection-failed");
    expect(result.detail).toMatch(/exploded/);
  });
});

describe("H — choices retained alongside an unproven restoration", () => {
  it("returns the options and the restoration state together", async () => {
    bridge((request) =>
      request.kind === "inspect"
        ? {
            ok: true,
            inspection: {
              options: { stage: ["Prospecting", "Closed Won"] },
              unresolved: {},
              initialPageState: "record-view",
              finalPageState: "record-edit",
              ownership: { enteredEditMode: true, openedControls: ["stage"] },
              restoration: { control: "proven", page: "unproven", reason: "not observed returning to view mode" },
              evidence: []
            }
          }
        : { ok: true, protocol: 3 }
    );
    const result = await extensionBridgeExecutionClient.acquireDomains(binding);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The findings survive; the safety state travels with them.
    expect(result.inspection.options.stage).toHaveLength(2);
    expect(result.inspection.restoration.page).toBe("unproven");
  });
});

describe("the acquisition request carries no confirmation and no inputs", () => {
  it("cannot be mistaken for an execution by any bridge that receives it", async () => {
    const seen: Record<string, unknown>[] = [];
    bridge((request) => {
      seen.push(request);
      return request.kind === "inspect"
        ? {
            ok: true,
            inspection: {
              options: {},
              unresolved: {},
              initialPageState: "record-view",
              finalPageState: "record-view",
              ownership: { enteredEditMode: false, openedControls: [] },
              restoration: { control: "not-required", page: "not-required" },
              evidence: []
            }
          }
        : { ok: true, protocol: 3 };
    });

    await extensionBridgeExecutionClient.acquireDomains(binding);
    const inspectRequest = seen.find((request) => request.kind === "inspect");
    expect(inspectRequest).toBeDefined();
    expect(inspectRequest?.confirmed).toBeUndefined();
    expect(inspectRequest?.inputs).toBeUndefined();
  });
});
