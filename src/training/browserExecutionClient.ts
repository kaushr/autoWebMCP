import type { BrowserExecutionBinding } from "../binding/browserExecution/model";
import type { AcquisitionFailureReason } from "../../extension/src/protocol";
import type { DomainInspection } from "../binding/browserExecution/execute";
import type { ExecutionResult } from "../binding/browserExecution/result";

/* ------------------------------------------------------------------ *
 * Browser execution client — the seam between the Studio's own page and
 * wherever a browser execution binding actually runs.
 *
 * The Studio's document is not the page a Salesforce binding needs to act
 * on; the Teach Mode extension is the thing with live access to that tab.
 * This module is the one place that knows how to reach it, so the Studio's
 * UI code and the WebMCP invoker below can both call the same `execute()`
 * without knowing that a browser extension is involved at all.
 * ------------------------------------------------------------------ */

export interface BrowserExecutionClient {
  execute(binding: BrowserExecutionBinding, inputs: Record<string, string>): Promise<ExecutionResult>;
  /**
   * Asks the live application which values its closed-domain controls
   * currently offer. Reads only — nothing is written and nothing is saved —
   * so it carries no execution confirmation.
   *
   * Returns a result rather than throwing, because "which hop failed" is
   * information the caller needs: a stale extension, an unregistered target
   * tab, and an unreachable content script all need different things from
   * the user, and a single thrown timeout told them apart from nothing.
   */
  acquireDomains(binding: BrowserExecutionBinding): Promise<DomainAcquisition>;
}

export type DomainAcquisition =
  | { ok: true; inspection: DomainInspection }
  | { ok: false; reason: AcquisitionFailureReason; detail: string };

/** How long to wait for the presence probe. It is answered synchronously by any current bridge. */
const PROBE_TIMEOUT_MS = 1_500;
const ACQUIRE_TIMEOUT_MS = 25_000;

/** What the bridge must speak for the Studio's current requests to be understood. */
const REQUIRED_PROTOCOL = 2;
const BRIDGE_MARKER = "data-autowebmcp-bridge";

/**
 * Is a bridge present, and does it speak our protocol?
 *
 * Checked before the real request because an older bridge answers nothing
 * at all for a request kind it predates — so without this, "the extension
 * needs reloading" is indistinguishable from "the extension is not
 * installed", and both cost a full timeout to discover.
 */
async function probeBridge(): Promise<{ ok: true } | { ok: false; reason: AcquisitionFailureReason; detail: string }> {
  const marker = document.documentElement.getAttribute(BRIDGE_MARKER);
  if (marker !== null) {
    return Number(marker) >= REQUIRED_PROTOCOL
      ? { ok: true }
      : {
          ok: false,
          reason: "studio-bridge-outdated",
          detail: `The Teach Mode extension is installed but out of date (it speaks version ${marker}; this page needs ${REQUIRED_PROTOCOL}). Reload it at chrome://extensions, then reload this page.`
        };
  }

  try {
    await bridgeRequest<number>({ kind: "hello" }, "hello", PROBE_TIMEOUT_MS, (data) =>
      typeof data.protocol === "number" ? data.protocol : undefined
    );
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: "extension-unavailable",
      detail:
        "The Teach Mode extension did not respond. It may not be installed or enabled, or it may be an older version " +
        "that predates this feature. Reload it at chrome://extensions, then reload this page."
    };
  }
}

const STUDIO_BRIDGE_SOURCE = "autowebmcp-studio-bridge";
/**
 * Generous on purpose: a single execution can legitimately spend up to ~8s
 * retrying target resolution alone (see `execute.ts`'s `resolveAllTargets`,
 * added after live Salesforce evidence showed a form settling well after
 * its container first appears), plus separate waits for the edit surface to
 * open and for the page to settle again after committing. Timing this out
 * too eagerly would misreport a slow-but-working execution as an
 * unreachable extension.
 */
const RESPONSE_TIMEOUT_MS = 45_000;

function newRequestId(prefix = "exec"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A failure that knows which hop produced it. */
class BridgeError extends Error {
  constructor(
    message: string,
    readonly reason: AcquisitionFailureReason
  ) {
    super(message);
  }
}

/** One request/response round trip over the Studio bridge. */
function bridgeRequest<T>(
  payload: Record<string, unknown>,
  prefix: string,
  timeoutMs: number,
  take: (data: Record<string, unknown>) => T | undefined,
  reasonOf: (data: Record<string, unknown>) => AcquisitionFailureReason | undefined = () => undefined
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const requestId = newRequestId(prefix);
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(
        new BridgeError(
          `The Teach Mode extension did not respond within ${Math.round(timeoutMs / 1000)}s.`,
          "introspection-timeout"
        )
      );
    }, timeoutMs);

    function onMessage(event: MessageEvent): void {
      if (event.source !== window) return;
      const data = event.data as Record<string, unknown> | undefined;
      if (data?.source !== STUDIO_BRIDGE_SOURCE || data.direction !== "response" || data.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      const value = data.ok ? take(data) : undefined;
      if (value !== undefined) resolve(value);
      else {
        reject(
          new BridgeError(
            typeof data.error === "string" ? data.error : "The request failed.",
            reasonOf(data) ?? "introspection-failed"
          )
        );
      }
    }

    window.addEventListener("message", onMessage);
    window.postMessage(
      { source: STUDIO_BRIDGE_SOURCE, direction: "request", requestId, ...payload },
      window.location.origin
    );
  });
}

/**
 * Sends an execution request to the Teach Mode extension's Studio-bridge
 * content script via `window.postMessage`, and waits for its response.
 * Requires the extension to be installed and its content script present on
 * this origin — see `extension/manifest.json` — which is exactly the "no
 * generic MCP server, no parallel Salesforce-only runtime" seam this task
 * asked for: the extension already has live tab access; this only reaches it.
 */
export const extensionBridgeExecutionClient: BrowserExecutionClient = {
  execute(binding, inputs) {
    return bridgeRequest<ExecutionResult>(
      { binding, inputs, confirmed: true },
      "exec",
      RESPONSE_TIMEOUT_MS,
      (data) => data.result as ExecutionResult | undefined
    );
  },

  async acquireDomains(binding) {
    const probe = await probeBridge();
    if (!probe.ok) return probe;

    try {
      // Shorter budget than execution: this opens a popup, reads it, and
      // closes it. It does not write, commit, or wait for a save.
      const inspection = await bridgeRequest<DomainInspection>(
        { kind: "inspect", binding },
        "inspect",
        ACQUIRE_TIMEOUT_MS,
        (data) => data.inspection as DomainInspection | undefined,
        (data) => data.reason as AcquisitionFailureReason | undefined
      );
      return { ok: true, inspection };
    } catch (error) {
      const reason = error instanceof BridgeError ? error.reason : "introspection-failed";
      return { ok: false, reason, detail: error instanceof Error ? error.message : String(error) };
    }
  }
};
