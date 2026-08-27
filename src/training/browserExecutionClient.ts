import type { BrowserExecutionBinding } from "../binding/browserExecution/model";
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
}

const STUDIO_BRIDGE_SOURCE = "autowebmcp-studio-bridge";
const RESPONSE_TIMEOUT_MS = 15_000;

function newRequestId(): string {
  return `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    return new Promise<ExecutionResult>((resolve, reject) => {
      const requestId = newRequestId();
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(
          new Error(
            "No response from the Teach Mode extension. Confirm it is installed, enabled, and that this page was reloaded after installing it."
          )
        );
      }, RESPONSE_TIMEOUT_MS);

      function onMessage(event: MessageEvent): void {
        if (event.source !== window) return;
        const data = event.data as Record<string, unknown> | undefined;
        if (
          data?.source !== STUDIO_BRIDGE_SOURCE ||
          data.direction !== "response" ||
          data.requestId !== requestId
        ) {
          return;
        }
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        if (data.ok && data.result) resolve(data.result as ExecutionResult);
        else reject(new Error(typeof data.error === "string" ? data.error : "Execution failed."));
      }

      window.addEventListener("message", onMessage);
      window.postMessage(
        { source: STUDIO_BRIDGE_SOURCE, direction: "request", requestId, binding, inputs, confirmed: true },
        window.location.origin
      );
    });
  }
};
