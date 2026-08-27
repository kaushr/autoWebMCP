import type { CaptureApplicationContext, CaptureEvent } from "../../src/capture/types";
import type { ObservationTrace } from "../../src/capture/normalize";

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

/** Popup or content script → service worker. */
export type ToBackgroundMessage =
  | { type: "session:start" }
  | { type: "session:stop" }
  | { type: "session:status" }
  | { type: "session:settings"; settings: Partial<CaptureSettings> }
  | { type: "session:trace" }
  | { type: "capture:context"; sessionId: string; application: CaptureApplicationContext }
  | { type: "capture:events"; sessionId: string; events: CaptureEvent[]; rrwebEvents: number };

/** Service worker → content script. */
export type ToContentMessage =
  | { type: "capture:begin"; sessionId: string; startedAt: number; settings: CaptureSettings }
  | { type: "capture:end" };

export interface CaptureFlush {
  events: CaptureEvent[];
  rrwebEvents: number;
}

export type TraceResponse = { trace?: ObservationTrace };
