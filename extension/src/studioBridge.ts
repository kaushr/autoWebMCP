import {
  STUDIO_BRIDGE_SOURCE,
  type BrowserBindingExecuteResponse,
  type StudioBridgeExecuteRequest,
  type StudioBridgeExecuteResponse
} from "./protocol";

/**
 * The seam between the Studio's own web page and the extension.
 *
 * A plain page has no extension APIs of its own — `chrome.runtime` does not
 * exist there. This content script does, because it is injected into the
 * Studio's origin declaratively (see `manifest.json`), and its only job is
 * to relay: a `window.postMessage` the Studio page sends becomes a
 * `chrome.runtime.sendMessage` to the background service worker, and the
 * response makes the same trip back. It never touches the DOM of the page
 * it relays for, and it never runs on any other origin.
 */

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as Partial<StudioBridgeExecuteRequest> | undefined;
  if (data?.source !== STUDIO_BRIDGE_SOURCE || data.direction !== "request") return;
  if (typeof data.requestId !== "string" || !data.binding || data.confirmed !== true) return;

  const requestId = data.requestId;
  const respond = (response: Omit<StudioBridgeExecuteResponse, "source" | "direction" | "requestId">): void => {
    window.postMessage(
      { source: STUDIO_BRIDGE_SOURCE, direction: "response", requestId, ...response } satisfies StudioBridgeExecuteResponse,
      window.location.origin
    );
  };

  chrome.runtime
    .sendMessage({
      type: "browser-binding:execute",
      request: { binding: data.binding, inputs: data.inputs ?? {}, confirmed: true }
    })
    .then((response: unknown) => respond(response as BrowserBindingExecuteResponse))
    .catch((error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));
});
