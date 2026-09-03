import { CaptureSession, type CaptureSessionSnapshot } from "../../src/capture/session";
import { categorizeRequest, normalizeEndpoint, type ObservationTrace } from "../../src/capture/normalize";
import type { CaptureApplicationContext, CaptureEvent } from "../../src/capture/types";
import {
  DEFAULT_SETTINGS,
  DEFAULT_CONTROL_PLANE_ORIGIN,
  isValidControlPlaneOrigin,
  type BrowserBindingExecuteResponse,
  type BrowserBindingInspectResponse,
  type CaptureSettings,
  type HandoffResult,
  type SessionStatus,
  type ToBackgroundMessage
} from "./protocol";

/**
 * Teach Mode service worker.
 *
 * It owns the session lifecycle, injects the capture content script on
 * explicit user action only, observes sanitized network metadata for the
 * recorded tab, and hands one normalized trace to the Training Studio.
 * It never inspects request headers, bodies, or cookies.
 */

const SESSION_KEY = "autowebmcp.session";
const TAB_KEY = "autowebmcp.tabId";
/**
 * Distinct from `TAB_KEY`: that one is cleared the moment recording stops,
 * because `recordingTabId` means "actively observing this tab". Testing or
 * executing a browser binding happens afterward, back in the Studio, with
 * recording long since stopped — this key is the one thing that survives
 * that stop, so execution still has a tab to reach.
 */
const LAST_TAB_KEY = "autowebmcp.lastTabId";
const TRACE_KEY = "autowebmcp.lastTrace";
const HANDOFF_KEY = "autowebmcp.lastHandoff";
const SETTINGS_KEY = "autowebmcp.settings";
const STUDIO_KEY = "autowebmcp.studioOrigin";

let session: CaptureSession | undefined;
let recordingTabId: number | undefined;
const requestStarts = new Map<string, number>();

/**
 * Distinguishes "the content script never answered" from every other
 * rejection `chrome.tabs.sendMessage` can produce, so the catch block below
 * can name this hop specifically instead of folding it into
 * `target-tab-unreachable`.
 */
class ContentScriptTimeoutError extends Error {}

/**
 * The Studio bridge already waits up to twenty seconds for this service
 * worker to answer at all. Nothing previously bounded the wait one hop
 * further in — for the tab's content script to answer this worker — so a
 * slow or stuck tab exhausted the bridge's own patience before this hop
 * ever got to say which one it was. Kept safely under the bridge's
 * timeout so this attribution wins the race and reaches the Studio UI
 * directly, with no console required to see it.
 */
const CONTENT_SCRIPT_ANSWER_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ContentScriptTimeoutError(`No answer within ${ms}ms.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function loadState(): Promise<void> {
  if (session) return;
  const stored = await chrome.storage.session.get([SESSION_KEY, TAB_KEY]);
  const snapshot = stored[SESSION_KEY] as CaptureSessionSnapshot | undefined;
  if (snapshot) {
    session = CaptureSession.fromSnapshot(snapshot);
    recordingTabId = stored[TAB_KEY] as number | undefined;
    if (session.isRecording()) attachNetworkObserver();
  }
}

async function persistState(): Promise<void> {
  if (!session) {
    await chrome.storage.session.remove([SESSION_KEY, TAB_KEY]);
    return;
  }
  await chrome.storage.session.set({ [SESSION_KEY]: session.toSnapshot(), [TAB_KEY]: recordingTabId });
}

async function getSettings(): Promise<CaptureSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...((stored[SETTINGS_KEY] as Partial<CaptureSettings>) ?? {}) };
}

async function getControlPlaneOrigin(): Promise<string> {
  const stored = await chrome.storage.local.get(STUDIO_KEY);
  return (stored[STUDIO_KEY] as string | undefined) ?? DEFAULT_CONTROL_PLANE_ORIGIN;
}

/**
 * Points the extension at a different control plane.
 *
 * This setting has been readable since the beginning and, until now,
 * writable by nothing at all — no popup field, no options page, no message.
 * A seam built for later that made the origin look configurable while it
 * was effectively hardcoded.
 *
 * An empty value restores the default rather than storing "", so clearing
 * the field is a way back rather than a way to break it.
 */
async function setControlPlaneOrigin(origin: string): Promise<void> {
  const trimmed = origin.trim().replace(/\/+$/, "");
  if (!trimmed) {
    await chrome.storage.local.remove(STUDIO_KEY);
    return;
  }
  if (!isValidControlPlaneOrigin(trimmed)) {
    throw new Error(`"${origin}" is not a valid origin. Use something like http://127.0.0.1:8787.`);
  }
  await chrome.storage.local.set({ [STUDIO_KEY]: trimmed });
}

async function rememberLastTab(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [LAST_TAB_KEY]: tabId });
}

async function lastKnownTabId(): Promise<number | undefined> {
  const stored = await chrome.storage.session.get(LAST_TAB_KEY);
  return stored[LAST_TAB_KEY] as number | undefined;
}

function newSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setBadge(recording: boolean): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: recording ? "#c2261a" : "#00000000" });
  await chrome.action.setBadgeText({ text: recording ? "REC" : "" });
  await chrome.action.setTitle({
    title: recording ? "AutoWebMCP — training in progress" : "AutoWebMCP — not recording"
  });
}

/* ----------------------------- network ----------------------------- */

function onRequestStart(details: chrome.webRequest.RequestDetails): void {
  if (details.tabId !== recordingTabId) return;
  requestStarts.set(details.requestId, details.timeStamp);
}

/**
 * Every request the training tab makes during the session is recorded as
 * metadata, including reads and failures. Deciding which of them look like the
 * application executing the demonstrated action is the normalizer's job, and it
 * cannot tell background polling from a Save without seeing both.
 */
function onRequestFinished(details: chrome.webRequest.RequestDetails): void {
  if (!session?.isRecording() || details.tabId !== recordingTabId) return;
  if (details.type !== "xmlhttprequest" && details.type !== "main_frame") return;

  const started = requestStarts.get(details.requestId);
  requestStarts.delete(details.requestId);

  let origin = "";
  let path = "/";
  let host = "";
  try {
    const url = new URL(details.url);
    origin = url.origin;
    host = url.host;
    path = url.pathname;
  } catch {
    return;
  }

  const completedAt = Math.max(0, details.timeStamp - session.startedAt);
  const startedAt = started ? Math.max(0, started - session.startedAt) : completedAt;
  const status = details.statusCode ?? 0;
  const failed = Boolean(details.error) || status === 0;

  session.add({
    id: `net-${details.requestId}`,
    kind: "network",
    t: completedAt,
    page: { host, path },
    network: {
      requestId: details.requestId,
      method: details.method,
      origin,
      endpoint: normalizeEndpoint(details.url),
      resourceType: details.type,
      status,
      ok: status >= 200 && status < 400,
      failed,
      startedAt,
      completedAt,
      durationMs: started ? Math.round(details.timeStamp - started) : 0,
      category: categorizeRequest(details.method, details.type),
      ...(details.frameId === undefined ? {} : { frameId: details.frameId })
    }
  });
  void persistState();
}

function attachNetworkObserver(): void {
  const filter = { urls: ["http://*/*", "https://*/*"] };
  chrome.webRequest.onBeforeRequest.addListener(onRequestStart, filter);
  chrome.webRequest.onCompleted.addListener(onRequestFinished, filter);
  chrome.webRequest.onErrorOccurred.addListener(onRequestFinished, filter);
}

function detachNetworkObserver(): void {
  chrome.webRequest.onBeforeRequest.removeListener(onRequestStart);
  chrome.webRequest.onCompleted.removeListener(onRequestFinished);
  chrome.webRequest.onErrorOccurred.removeListener(onRequestFinished);
  requestStarts.clear();
}

/* ------------------------- session lifecycle ------------------------ */

function applicationFromTab(tab: chrome.tabs.Tab): CaptureApplicationContext {
  let host = "unknown";
  try {
    host = new URL(tab.url ?? "").host || "unknown";
  } catch {
    host = "unknown";
  }
  return { host, platform: "generic", ...(tab.title ? { title: tab.title } : {}) };
}

async function injectCapture(tabId: number): Promise<void> {
  if (!session) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await chrome.tabs.sendMessage(tabId, {
    type: "capture:begin",
    sessionId: session.id,
    startedAt: session.startedAt,
    settings: await getSettings()
  });
}

async function startSession(recording?: { name?: string; description?: string }): Promise<SessionStatus> {
  await stopSession();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/i.test(tab.url ?? "")) {
    throw new Error("Open the application you want to teach in an http(s) tab first.");
  }

  session = new CaptureSession(newSessionId(), Date.now(), applicationFromTab(tab));
  if (recording) session.describeRecording(recording);
  recordingTabId = tab.id;
  await rememberLastTab(tab.id);
  attachNetworkObserver();
  await chrome.storage.local.remove(HANDOFF_KEY);
  await persistState();
  await setBadge(true);
  await injectCapture(tab.id);
  return status();
}

async function handoff(trace: ObservationTrace): Promise<HandoffResult> {
  const origin = await getControlPlaneOrigin();
  try {
    const response = await fetch(`${origin}/api/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trace)
    });
    if (!response.ok) {
      return { ok: false, message: `The control plane at ${origin} rejected the trace (${response.status}).` };
    }
    return {
      ok: true,
      message: `Recording sent to the Training Studio (${trace.observations.length} observations).`,
      sessionId: trace.sessionId,
      observations: trace.observations.length
    };
  } catch {
    return {
      ok: false,
      // Names the control plane, not "the Training Studio": the Studio UI
      // runs on a different port, and saying otherwise sent someone to
      // check the wrong server while the right one was simply not running.
      message:
        `No control plane is answering at ${origin}. Start it with "npm run dev:semanticizer", then press ` +
        `Retry — the recording is kept here and nothing has been lost.`
    };
  }
}

/**
 * Re-sends the retained trace.
 *
 * A handoff fails for reasons that are usually over in seconds — the
 * control plane was not running, or was pointed at the wrong port — and
 * until now the only way back was copying JSON out of this popup and
 * curling it in by hand. The trace was never lost; it was just unreachable
 * from the UI holding it.
 */
async function resendTrace(): Promise<SessionStatus> {
  const stored = await chrome.storage.local.get(TRACE_KEY);
  const trace = stored[TRACE_KEY] as ObservationTrace | undefined;
  if (!trace) return status();
  const result = await handoff(trace);
  await chrome.storage.local.set({ [HANDOFF_KEY]: result });
  return status();
}

async function stopSession(): Promise<SessionStatus> {
  await loadState();
  if (!session || !session.isRecording()) return status();

  if (recordingTabId !== undefined) {
    try {
      const flush = await chrome.tabs.sendMessage<{ events: CaptureEvent[]; rrwebEvents: number } | undefined>(
        recordingTabId,
        { type: "capture:end" }
      );
      if (flush) {
        session.addMany(flush.events);
        session.noteRrwebEvents(flush.rrwebEvents);
      }
    } catch {
      // The tab may already be gone; the evidence collected so far still stands.
    }
  }

  session.stop(Date.now());
  detachNetworkObserver();
  const trace = session.toTrace();
  const result = await handoff(trace);

  await chrome.storage.local.set({ [TRACE_KEY]: trace, [HANDOFF_KEY]: result });
  session = undefined;
  recordingTabId = undefined;
  await persistState();
  await setBadge(false);
  return status();
}

async function status(): Promise<SessionStatus> {
  await loadState();
  const stored = await chrome.storage.local.get([HANDOFF_KEY, TRACE_KEY]);
  return {
    recording: Boolean(session?.isRecording()),
    ...(session ? { sessionId: session.id, application: session.application, startedAt: session.startedAt } : {}),
    ...(recordingTabId !== undefined ? { tabId: recordingTabId } : {}),
    captureEvents: session?.count() ?? 0,
    settings: await getSettings(),
    studioOrigin: await getControlPlaneOrigin(),
    ...(stored[HANDOFF_KEY] ? { lastHandoff: stored[HANDOFF_KEY] as HandoffResult } : {}),
    hasTrace: Boolean(stored[TRACE_KEY])
  };
}

/* ------------------------------ wiring ------------------------------ */

async function handle(message: ToBackgroundMessage, senderTabId?: number): Promise<unknown> {
  switch (message.type) {
    case "session:start":
      return startSession(message.recording);
    case "session:stop":
      return stopSession();
    case "session:status":
      return status();
    case "session:settings": {
      const settings = { ...(await getSettings()), ...message.settings };
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      return status();
    }
    case "session:trace": {
      const stored = await chrome.storage.local.get(TRACE_KEY);
      return { trace: stored[TRACE_KEY] as ObservationTrace | undefined };
    }
    case "session:resend":
      return resendTrace();
    case "session:origin": {
      try {
        await setControlPlaneOrigin(message.origin);
      } catch (error) {
        // Reported through the same channel as a failed handoff, so the
        // popup has one place to show what went wrong.
        await chrome.storage.local.set({
          [HANDOFF_KEY]: { ok: false, message: error instanceof Error ? error.message : String(error) }
        });
      }
      return status();
    }
    case "capture:context": {
      await loadState();
      if (session?.id === message.sessionId) {
        session.describeApplication(message.application);
        await persistState();
      }
      return { ok: true };
    }
    case "capture:events": {
      await loadState();
      if (!session || session.id !== message.sessionId || senderTabId !== recordingTabId) return { ok: false };
      session.addMany(message.events);
      session.noteRrwebEvents(message.rrwebEvents);
      await persistState();
      return { ok: true, captureEvents: session.count() };
    }
    case "browser-binding:inspect": {
      await loadState();
      const tabId = recordingTabId ?? (await lastKnownTabId());
      console.debug("[AutoWebMCP] background: inspect request; target tab =", tabId);
      if (tabId === undefined) {
        return {
          ok: false,
          reason: "target-tab-not-registered",
          error:
            "No target tab is known. Start a Teach Mode session on the target application first, then try again. " +
            "Reloading the extension clears this registration."
        } satisfies BrowserBindingInspectResponse;
      }
      // Each hop reports itself, so a failure names the thing that actually
      // broke rather than collapsing into one unhelpful timeout.
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      } catch (error) {
        return {
          ok: false,
          reason: "content-script-unavailable",
          error: `The Teach Mode content script could not be injected into the target tab: ${
            error instanceof Error ? error.message : String(error)
          }`
        } satisfies BrowserBindingInspectResponse;
      }
      try {
        const response = (await withTimeout(
          chrome.tabs.sendMessage(tabId, {
            type: "inspect:domains",
            request: message.request
          }),
          CONTENT_SCRIPT_ANSWER_TIMEOUT_MS
        )) as BrowserBindingInspectResponse | undefined;
        console.debug("[AutoWebMCP] background: target tab answered", response);
        return (
          response ?? {
            ok: false,
            reason: "content-script-unavailable",
            error: "The target tab's content script returned no response."
          }
        );
      } catch (error) {
        if (error instanceof ContentScriptTimeoutError) {
          console.warn("[AutoWebMCP] background: target tab accepted the inspect request but never answered it.");
          return {
            ok: false,
            reason: "introspection-timeout",
            error:
              `The target tab accepted the inspection request but did not answer within ` +
              `${CONTENT_SCRIPT_ANSWER_TIMEOUT_MS / 1000}s. The page may still be busy, or it may have ` +
              `navigated away while AutoWebMCP was reading it — reloading the page and trying again is ` +
              `usually enough; if it keeps happening, that navigation is worth reporting.`
          } satisfies BrowserBindingInspectResponse;
        }
        return {
          ok: false,
          reason: "target-tab-unreachable",
          error: `The target tab could not be reached: ${error instanceof Error ? error.message : String(error)}`
        } satisfies BrowserBindingInspectResponse;
      }
    }

    case "browser-binding:execute": {
      await loadState();
      const tabId = recordingTabId ?? (await lastKnownTabId());
      if (tabId === undefined) {
        return {
          ok: false,
          error: "No target tab is known. Start a Teach Mode session on the target application first, then try again."
        } satisfies BrowserBindingExecuteResponse;
      }
      try {
        // Idempotent: content.js declines to attach a second capture probe
        // if one is already present, and the execute handler here has no
        // session state to duplicate.
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        return (await chrome.tabs.sendMessage(tabId, {
          type: "execute:run",
          request: message.request
        })) as BrowserBindingExecuteResponse;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies BrowserBindingExecuteResponse;
      }
    }
    default:
      return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message as ToBackgroundMessage, sender.tab?.id)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== recordingTabId || change.status !== "complete") return;
  void loadState().then(() => {
    if (session?.isRecording()) void injectCapture(tabId).catch(() => undefined);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === recordingTabId) void stopSession();
  void lastKnownTabId().then((last) => {
    if (last === tabId) void chrome.storage.session.remove(LAST_TAB_KEY);
  });
});

chrome.runtime.onStartup.addListener(() => void setBadge(false));
chrome.runtime.onInstalled.addListener(() => void setBadge(false));
