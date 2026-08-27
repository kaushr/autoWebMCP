import {
  STUDIO_BRIDGE_SOURCE,
  type BrowserBindingExecuteResponse,
  type BrowserBindingInspectResponse,
  type StudioBridgeInspectRequest,
  type StudioBridgeInspectResponse,
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
  const data = event.data as Partial<StudioBridgeExecuteRequest & StudioBridgeInspectRequest> | undefined;
  if (data?.source !== STUDIO_BRIDGE_SOURCE || data.direction !== "request") return;
  if (typeof data.requestId !== "string" || !data.binding) return;

  const requestId = data.requestId;

  // Reading what a control currently offers changes nothing, so it carries
  // no confirmation. Execution still requires the literal `true`, checked
  // here and again at the boundary that touches the page.
  if (data.kind === "inspect") {
    const binding = data.binding;
    chrome.runtime
      .sendMessage({ type: "browser-binding:inspect", request: { binding } })
      .then((response: unknown) => {
        const inspection = response as BrowserBindingInspectResponse;
        window.postMessage(
          { source: STUDIO_BRIDGE_SOURCE, direction: "response", requestId, ...inspection } satisfies StudioBridgeInspectResponse,
          window.location.origin
        );
      })
      .catch((error: unknown) => {
        window.postMessage(
          {
            source: STUDIO_BRIDGE_SOURCE,
            direction: "response",
            requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          } satisfies StudioBridgeInspectResponse,
          window.location.origin
        );
      });
    return;
  }
  if (data.confirmed !== true) return;
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
