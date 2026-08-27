import {
  STUDIO_BRIDGE_MARKER,
  STUDIO_BRIDGE_PROTOCOL,
  STUDIO_BRIDGE_SOURCE,
  type BrowserBindingExecuteResponse,
  type StudioBridgeExecuteRequest,
  type StudioBridgeExecuteResponse,
  type StudioBridgeHelloResponse,
  type StudioBridgeInspectRequest
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
 * it relays for beyond the presence marker below, and it never runs on any
 * other origin.
 *
 * Two properties here exist because of a live failure. An earlier bridge
 * returned early on any request it did not recognize, so when the Studio
 * gained a new request kind the older installed bridge dropped it in
 * silence — indistinguishable, from the page's side, from having no
 * extension at all, and reported after a 20-second wait as "no response".
 * So this bridge **always answers**, even to say it cannot help, and it
 * **announces its protocol version** both as a page marker and on request.
 */

// Detectable without a round trip: the Studio can tell instantly whether a
// current bridge is present, rather than inferring it from a timeout.
document.documentElement.setAttribute(STUDIO_BRIDGE_MARKER, String(STUDIO_BRIDGE_PROTOCOL));

/** Shorter than the Studio's own patience, so the bridge reports first. */
const BACKGROUND_ANSWER_TIMEOUT_MS = 20_000;

type AnyRequest = Omit<Partial<StudioBridgeExecuteRequest & StudioBridgeInspectRequest>, "kind"> & { kind?: string };

function post(message: Record<string, unknown>): void {
  window.postMessage({ source: STUDIO_BRIDGE_SOURCE, direction: "response", ...message }, window.location.origin);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as AnyRequest | undefined;
  if (data?.source !== STUDIO_BRIDGE_SOURCE || data.direction !== "request") return;
  if (typeof data.requestId !== "string") return;
  const requestId = data.requestId;

  // A liveness and version probe. Side-effect free, and the answer is what
  // lets the Studio distinguish "no extension" from "an extension too old
  // to understand what I am about to ask".
  if (data.kind === "hello") {
    post({ requestId, ok: true, protocol: STUDIO_BRIDGE_PROTOCOL } satisfies Omit<
      StudioBridgeHelloResponse,
      "source" | "direction"
    >);
    return;
  }

  // Reading what a control currently offers changes nothing, so it carries
  // no confirmation. Execution still requires the literal `true`, checked
  // here and again at the boundary that touches the page.
  if (data.kind === "inspect") {
    const binding = data.binding;
    if (!binding) {
      post({ requestId, ok: false, reason: "introspection-failed", error: "No binding was supplied." });
      return;
    }

    // A watchdog, because the one failure this path could not report was
    // silence. `chrome.runtime.sendMessage` neither resolves nor rejects if
    // the service worker accepts the message and never answers, and the
    // caller then blames "the extension" without knowing which hop stopped.
    let answered = false;
    const watchdog = setTimeout(() => {
      if (answered) return;
      answered = true;
      console.warn("[AutoWebMCP] bridge: the background service worker did not answer the inspect request.");
      post({
        requestId,
        ok: false,
        reason: "extension-unavailable",
        error:
          "The extension's background service worker accepted the request but never answered it. " +
          "Reload the extension at chrome://extensions, then reload this page."
      });
    }, BACKGROUND_ANSWER_TIMEOUT_MS);

    const settle = (payload: Record<string, unknown>): void => {
      if (answered) return;
      answered = true;
      clearTimeout(watchdog);
      post({ requestId, ...payload });
    };

    console.debug("[AutoWebMCP] bridge: forwarding inspect request to the service worker.");
    chrome.runtime
      .sendMessage({ type: "browser-binding:inspect", request: { binding } })
      .then((response: unknown) => {
        console.debug("[AutoWebMCP] bridge: service worker answered", response);
        settle(
          (response ?? {
            ok: false,
            reason: "extension-unavailable",
            error: "The extension's background service worker returned no response."
          }) as unknown as Record<string, unknown>
        );
      })
      .catch((error: unknown) => {
        console.warn("[AutoWebMCP] bridge: service worker call failed", error);
        settle({
          ok: false,
          reason: "extension-unavailable",
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return;
  }

  if (data.binding && data.confirmed === true) {
    const respond = (response: Omit<StudioBridgeExecuteResponse, "source" | "direction" | "requestId">): void => {
      post({ requestId, ...response });
    };
    chrome.runtime
      .sendMessage({
        type: "browser-binding:execute",
        request: { binding: data.binding, inputs: data.inputs ?? {}, confirmed: true }
      })
      .then((response: unknown) => respond(response as BrowserBindingExecuteResponse))
      .catch((error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return;
  }

  // Never drop a request in silence: an unanswered message is impossible to
  // tell apart from an absent extension, and costs the caller its whole
  // timeout budget to discover.
  post({
    requestId,
    ok: false,
    reason: "studio-bridge-outdated",
    error: `This request was not understood by the Teach Mode extension (bridge protocol ${STUDIO_BRIDGE_PROTOCOL}).`
  });
});
