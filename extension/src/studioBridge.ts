import {
  EXECUTION_TIMEOUTS,
  STUDIO_BRIDGE_MARKER,
  STUDIO_BRIDGE_PROTOCOL,
  STUDIO_BRIDGE_SOURCE,
  type BrowserBindingExecuteResponse,
  type StudioBridgeExecuteRequest,
  type StudioBridgeExecuteResponse,
  type StudioBridgeHelloResponse,
  type StudioBridgeInspectRequest,
  type StudioBridgeQueryRequest
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

/**
 * The same idea for a write, which had no watchdog at all.
 *
 * Above the background's own 42s ceiling so that hop reports first when it
 * can, and below the Studio's patience so silence here is still attributed
 * to the right place rather than arriving as an anonymous timeout.
 */
const EXECUTE_BACKGROUND_TIMEOUT_MS = EXECUTION_TIMEOUTS.BACKGROUND;

type AnyRequest = Omit<
  Partial<StudioBridgeExecuteRequest & StudioBridgeInspectRequest & StudioBridgeQueryRequest>,
  "kind"
> & { kind?: string };

function post(message: Record<string, unknown>): void {
  window.postMessage({ source: STUDIO_BRIDGE_SOURCE, direction: "response", ...message }, window.location.origin);
}

/**
 * Whether this bridge's own connection to the extension is still alive.
 *
 * A page that keeps its Studio tab open across an extension reload (or a
 * disable/re-enable) keeps running this exact script instance, but the
 * `chrome.runtime` it captured no longer refers to anything real —
 * `chrome.runtime` itself can go fully `undefined`, not just throw when
 * called. A live run hit exactly that: the bridge threw synchronously on
 * `chrome.runtime.sendMessage(...)`, after the 20-second watchdog below
 * was already armed, so the real cause sat invisible in
 * `chrome://extensions`'s error log while the Studio UI waited out the
 * full watchdog to report a generic, misattributed timeout. Checked
 * before every call so the actual cause reaches the Studio immediately.
 */
function bridgeConnectionLost(): boolean {
  return typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function";
}

const STALE_BRIDGE_MESSAGE =
  "This tab's connection to the Teach Mode extension was reset — most likely by an extension reload or " +
  "update while this tab stayed open. Reload this tab (not just the extension) to reconnect.";

/** `chrome.runtime.sendMessage`, but a torn-down context rejects instead of throwing synchronously. */
function callBackground(message: Record<string, unknown>): Promise<unknown> {
  if (bridgeConnectionLost()) return Promise.reject(new Error(STALE_BRIDGE_MESSAGE));
  try {
    return chrome.runtime.sendMessage(message);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
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
    callBackground({ type: "browser-binding:inspect", request: { binding } })
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

  if (data.kind === "query" && data.queryBinding) {
    callBackground({
      type: "browser-binding:query",
      request: { binding: data.queryBinding, inputs: data.inputs ?? {} }
    })
      .then((response) => {
        const answer = response as { ok?: boolean; outcome?: unknown; error?: string };
        post(
          answer?.ok
            ? { requestId, ok: true, outcome: answer.outcome }
            : { requestId, ok: false, error: answer?.error ?? "The search could not be run." }
        );
      })
      .catch((error) => post({ requestId, ok: false, error: String(error) }));
    return;
  }

  if (data.binding && data.confirmed === true) {
    const invocationId = typeof data.invocationId === "string" ? data.invocationId : undefined;
    let answered = false;
    const respond = (response: Omit<StudioBridgeExecuteResponse, "source" | "direction" | "requestId">): void => {
      if (answered) return;
      answered = true;
      clearTimeout(watchdog);
      post({ requestId, ...(invocationId ? { invocationId } : {}), ...response });
    };

    // The failure this path could not report was silence, and a write is
    // the worst thing to be silent about: an execution that was dispatched
    // and never answered may already have saved. Saying so is the whole
    // point — the caller can then read the record instead of guessing, and
    // must not simply run it again.
    const watchdog = setTimeout(() => {
      respond({
        ok: false,
        reason: "outcome-unknown",
        error:
          "The execution was dispatched to the extension and no answer came back within " +
          `${EXECUTE_BACKGROUND_TIMEOUT_MS / 1000}s. Whether it changed anything is not known from here.`
      });
    }, EXECUTE_BACKGROUND_TIMEOUT_MS);

    callBackground({
      type: "browser-binding:execute",
      request: {
        binding: data.binding,
        inputs: data.inputs ?? {},
        confirmed: true,
        ...(invocationId ? { invocationId } : {}),
        // Relayed rather than decided here: only the caller knows whether
        // this is an autonomous invocation or a human's own test.
        ...(data.requireTarget === true ? { requireTarget: true } : {})
      }
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
