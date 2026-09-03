import type { CaptureApplicationContext, CaptureEvent } from "../../src/capture/types";
import type { ObservationTrace, RecordingMetadata } from "../../src/capture/normalize";
import type { BrowserExecutionBinding } from "../../src/binding/browserExecution/model";
import type { DomainInspection } from "../../src/binding/browserExecution/execute";
import type { ExecutionResult } from "../../src/binding/browserExecution/result";

/**
 * Where the extension POSTs its normalized trace.
 *
 * This is the CONTROL PLANE's origin, not the Studio UI's — the Studio
 * page runs on Vite (5173) and proxies `/api` here, while the extension
 * posts to the API directly so a handoff works whether or not the UI is
 * running. Naming it "studio" cost real debugging time once: a failed
 * handoff said "Training Studio unreachable at …:8787", which names one
 * thing and shows another's port, and sent someone to check the wrong
 * server.
 *
 * Overridable at runtime — see `session:origin`.
 */
export const DEFAULT_CONTROL_PLANE_ORIGIN = "http://127.0.0.1:8787";

/**
 * Whether a string is usable as a control-plane origin.
 *
 * Deliberately strict: this value decides where a recording of the user's
 * own application is sent, so it must be an origin and nothing more — no
 * path, no query, and http/https only.
 */
export function isValidControlPlaneOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export interface CaptureSettings {
  /**
   * Whether ordinary (non-sensitive) field values may leave the page.
   * Sensitive controls are masked regardless of this setting.
   */
  captureValues: boolean;
}

export const DEFAULT_SETTINGS: CaptureSettings = { captureValues: true };

export interface HandoffResult {
  ok: boolean;
  message: string;
  sessionId?: string;
  observations?: number;
}

export interface SessionStatus {
  recording: boolean;
  sessionId?: string;
  tabId?: number;
  application?: CaptureApplicationContext;
  startedAt?: number;
  captureEvents: number;
  settings: CaptureSettings;
  lastHandoff?: HandoffResult;
  hasTrace: boolean;
  /** Where traces are sent, so the popup can show and change it. */
  studioOrigin: string;
}

/**
 * A live-DOM execution request: a declarative browser execution binding, the
 * input values to write, and an explicit confirmation. This is a write
 * operation on the user's own authenticated session — every hop of this
 * protocol carries `confirmed: true` literally, never a variable that could
 * quietly be false, and each handler re-checks it before touching the DOM.
 */
export interface BrowserBindingExecuteRequest {
  binding: BrowserExecutionBinding;
  inputs: Record<string, string>;
  confirmed: true;
  /**
   * Demand an explicit record identity before writing.
   *
   * Set by the published WebMCP tool and never by the Studio's manual test.
   * The asymmetry is the safety property: a human testing a binding chose
   * the record by opening it, while an agent has chosen nothing, so an
   * autonomous write must name the record it means rather than acting on
   * whichever one happens to be open.
   */
  requireTarget?: boolean;
}

/**
 * A read-only inspection of the live page's closed-domain controls.
 *
 * Deliberately a separate message from execution, with no `confirmed`
 * field, because it writes nothing: it reads what a picklist currently
 * offers and dismisses it. Keeping it distinct means the confirmation
 * gate on execution stays exactly as narrow as it was.
 */
export interface BrowserBindingInspectRequest {
  binding: BrowserExecutionBinding;
}

export interface BrowserBindingInspectResponse {
  ok: boolean;
  inspection?: DomainInspection;
  /** Which hop failed, so the Studio can say something actionable. */
  reason?: AcquisitionFailureReason;
  error?: string;
}

/**
 * Where a live acquisition stopped.
 *
 * A single "no response" covered all of these, which made a stale
 * extension indistinguishable from an uninstalled one and from a missing
 * target tab. Each hop now names itself.
 */
export type AcquisitionFailureReason =
  | "extension-unavailable"
  | "studio-bridge-outdated"
  | "target-tab-not-registered"
  | "target-tab-unreachable"
  | "content-script-unavailable"
  | "introspection-failed"
  | "introspection-timeout";

export interface BrowserBindingExecuteResponse {
  ok: boolean;
  result?: ExecutionResult;
  /**
   * The protocol version of the extension that actually ran this.
   *
   * Three live runs were analysed against source the browser was not
   * running, because a reloaded page and a reloaded extension are separate
   * acts and nothing reported the difference. A result now carries the
   * version of the code that produced it.
   */
  protocol?: number;
  error?: string;
}

/** Popup, content script, or the Studio bridge → service worker. */
export type ToBackgroundMessage =
  | { type: "session:start"; recording?: RecordingMetadata }
  | { type: "session:stop" }
  | { type: "session:status" }
  | { type: "session:settings"; settings: Partial<CaptureSettings> }
  | { type: "session:trace" }
  /** Re-send the retained trace, after a failed handoff or a corrected origin. */
  | { type: "session:resend" }
  /** Point the extension at a different control plane. `origin` empty restores the default. */
  | { type: "session:origin"; origin: string }
  | { type: "capture:context"; sessionId: string; application: CaptureApplicationContext }
  | { type: "capture:events"; sessionId: string; events: CaptureEvent[]; rrwebEvents: number }
  | { type: "browser-binding:execute"; request: BrowserBindingExecuteRequest }
  | { type: "browser-binding:inspect"; request: BrowserBindingInspectRequest };

/** Service worker → content script. */
export type ToContentMessage =
  | { type: "capture:begin"; sessionId: string; startedAt: number; settings: CaptureSettings }
  | { type: "capture:end" }
  | { type: "execute:run"; request: BrowserBindingExecuteRequest }
  | { type: "inspect:domains"; request: BrowserBindingInspectRequest };

export interface CaptureFlush {
  events: CaptureEvent[];
  rrwebEvents: number;
}

export type TraceResponse = { trace?: ObservationTrace };

/**
 * Studio page (`window.postMessage`) ↔ the Studio-bridge content script.
 * A separate, narrower envelope from the extension's own internal messages:
 * `window.postMessage` is visible to anything sharing the page, so every
 * message is tagged and every request carries the `requestId` its response
 * must echo back — a plain web page has no other way to correlate them.
 */
/**
 * What the Studio page and the bridge agree they can say to each other.
 *
 * Bumped whenever a new request kind is added. The Studio checks it before
 * sending, because an extension that predates a request kind drops it
 * silently — which is exactly how a stale install came to look like an
 * uninstalled one.
 */
export const STUDIO_BRIDGE_PROTOCOL = 3;

/** The attribute the bridge stamps on the page so its presence is detectable without a round trip. */
export const STUDIO_BRIDGE_MARKER = "data-autowebmcp-bridge";

export const STUDIO_BRIDGE_SOURCE = "autowebmcp-studio-bridge";

/** Studio page → bridge, asking the taught tab what its controls currently offer. */
export interface StudioBridgeInspectRequest {
  source: typeof STUDIO_BRIDGE_SOURCE;
  direction: "request";
  kind: "inspect";
  requestId: string;
  binding: BrowserExecutionBinding;
}

export interface StudioBridgeInspectResponse {
  source: typeof STUDIO_BRIDGE_SOURCE;
  direction: "response";
  requestId: string;
  ok: boolean;
  inspection?: DomainInspection;
  reason?: AcquisitionFailureReason;
  error?: string;
}

/** A liveness/version probe. Cheap, side-effect free, and answered by any current bridge. */
export interface StudioBridgeHelloRequest {
  source: typeof STUDIO_BRIDGE_SOURCE;
  direction: "request";
  kind: "hello";
  requestId: string;
}

export interface StudioBridgeHelloResponse {
  source: typeof STUDIO_BRIDGE_SOURCE;
  direction: "response";
  requestId: string;
  ok: true;
  protocol: number;
}

export interface StudioBridgeExecuteRequest {
  source: typeof STUDIO_BRIDGE_SOURCE;
  direction: "request";
  requestId: string;
  binding: BrowserExecutionBinding;
  inputs: Record<string, string>;
  confirmed: true;
  /** See `BrowserBindingExecuteRequest.requireTarget`. */
  requireTarget?: boolean;
}

export interface StudioBridgeExecuteResponse {
  source: typeof STUDIO_BRIDGE_SOURCE;
  direction: "response";
  requestId: string;
  ok: boolean;
  result?: ExecutionResult;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Keeping exactly one LIVE message listener on a document.
 *
 * The service worker injects the content script before every operation,
 * so the same document can be asked to install a listener many times. Two
 * opposite failures have both happened here for real:
 *
 *   Registering unconditionally left N listeners, and one message ran N
 *   inspections concurrently against the same live record — each entering
 *   edit mode, opening a control and dismissing it while the others were
 *   still reading.
 *
 *   Guarding with a boolean then left a document with NO listener.
 *   Reloading the extension invalidates the old content script, so its
 *   listener is dead, while the flag it set survives on the page's
 *   isolated world — the next injection saw the flag and installed
 *   nothing. Starting a recording silently did nothing at all.
 *
 * A boolean cannot distinguish "a live listener exists" from "a dead one
 * used to". Replacement can: remove whatever this document last installed,
 * then install a working one. A listener from an invalidated context
 * cannot be removed and does not need to be, because it can no longer
 * fire.
 * ------------------------------------------------------------------ */

/** The part of `chrome.runtime.onMessage` this needs. */
export interface MessageListenerHost<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/**
 * Installs `next` as the document's only live listener, returning it so the
 * caller can record what to replace next time.
 *
 * Removal failure is deliberately swallowed: it means the previous listener
 * belonged to a context that no longer exists, which is precisely the case
 * where installing a fresh one matters most.
 */
export function replaceMessageListener<Listener>(
  host: MessageListenerHost<Listener>,
  previous: Listener | undefined,
  next: Listener
): Listener {
  if (previous) {
    try {
      host.removeListener(previous);
    } catch {
      // An invalidated context's listener is already inert.
    }
  }
  host.addListener(next);
  return next;
}
