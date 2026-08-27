import type { BrowserExecutionBinding } from "../binding/browserExecution/model";
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
   */
  inspectDomains(binding: BrowserExecutionBinding): Promise<DomainInspection>;
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

/** One request/response round trip over the Studio bridge. */
function bridgeRequest<T>(
  payload: Record<string, unknown>,
  prefix: string,
  timeoutMs: number,
  take: (data: Record<string, unknown>) => T | undefined
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const requestId = newRequestId(prefix);
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(
        new Error(
          "No response from the Teach Mode extension. Confirm it is installed, enabled, and that this page was reloaded after installing it."
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
      else reject(new Error(typeof data.error === "string" ? data.error : "The request failed."));
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

  inspectDomains(binding) {
    // Shorter budget than execution: this opens a popup, reads it, and
    // closes it. It does not write, commit, or wait for a save.
    return bridgeRequest<DomainInspection>(
      { kind: "inspect", binding },
      "inspect",
      20_000,
      (data) => data.inspection as DomainInspection | undefined
    );
  }
};
