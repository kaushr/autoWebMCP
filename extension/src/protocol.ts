import type { CaptureApplicationContext, CaptureEvent } from "../../src/capture/types";
import type { ObservationTrace, RecordingMetadata } from "../../src/capture/normalize";
import type { BrowserExecutionBinding } from "../../src/binding/browserExecution/model";
import type { DomainInspection } from "../../src/binding/browserExecution/execute";
import type { ExecutionResult } from "../../src/binding/browserExecution/result";

/** Where the extension hands its normalized trace to the Training Studio. */
export const DEFAULT_STUDIO_ORIGIN = "http://127.0.0.1:8787";

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
  error?: string;
}

export interface BrowserBindingExecuteResponse {
  ok: boolean;
  result?: ExecutionResult;
  error?: string;
}

/** Popup, content script, or the Studio bridge → service worker. */
export type ToBackgroundMessage =
  | { type: "session:start"; recording?: RecordingMetadata }
  | { type: "session:stop" }
  | { type: "session:status" }
  | { type: "session:settings"; settings: Partial<CaptureSettings> }
  | { type: "session:trace" }
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
  error?: string;
}

export interface StudioBridgeExecuteRequest {
  source: typeof STUDIO_BRIDGE_SOURCE;
  direction: "request";
  requestId: string;
  binding: BrowserExecutionBinding;
  inputs: Record<string, string>;
  confirmed: true;
}

export interface StudioBridgeExecuteResponse {
  source: typeof STUDIO_BRIDGE_SOURCE;
  direction: "response";
  requestId: string;
  ok: boolean;
  result?: ExecutionResult;
  error?: string;
}
