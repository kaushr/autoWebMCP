/* ------------------------------------------------------------------ *
 * Asynchronous operation state for the Studio.
 *
 * Several Studio actions cross the page → extension → target tab →
 * application path and can take seconds. Without a busy state a click is
 * indistinguishable from a no-op, which is how "Read choices from the
 * application" appeared to do nothing for twenty seconds before failing.
 *
 * Deliberately small: a status, a message, an optional phase, and an id.
 * The id exists for one specific hazard — a slow response arriving after
 * the user has moved to a different trace or capability must not overwrite
 * what they are looking at now.
 *
 * This is not a job framework. There is no queue, no retry, no
 * cancellation, and no persistence.
 * ------------------------------------------------------------------ */

export type OperationStatus = "idle" | "working" | "succeeded" | "failed";

/** Which Studio action this is. One entry per user-visible async button. */
export type OperationKind =
  | "propose-capability"
  | "suggest-binding"
  | "validate-binding"
  | "acquire-domains"
  | "run-browser-test"
  | "publish-capability"
  | "refresh-traces"
  | "clear-traces"
  | "refresh-publications"
  | "unpublish-all"
  | "reset-control-plane"
  | "save-trace-details"
  | "invoke-webmcp"
  | "run-query";

export interface OperationState {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  /** What to show the user right now. */
  message: string;
  /** A coarse step, when the operation can honestly report one. */
  phase?: string;
  startedAt: number;
  /** True when the outcome needs attention rather than merely reporting success. */
  warning?: boolean;
}

export type OperationRegistry = Partial<Record<OperationKind, OperationState>>;

let sequence = 0;

export function beginOperation(kind: OperationKind, message: string, now = Date.now()): OperationState {
  sequence += 1;
  return { id: `${kind}-${sequence}`, kind, status: "working", message, startedAt: now };
}

export function succeeded(state: OperationState, message: string, warning = false): OperationState {
  return { ...state, status: "succeeded", message, ...(warning ? { warning: true } : {}) };
}

export function failed(state: OperationState, message: string): OperationState {
  return { ...state, status: "failed", message, warning: true };
}

/** Whether this operation is currently running, and its button should be disabled. */
export function isWorking(registry: OperationRegistry, kind: OperationKind): boolean {
  return registry[kind]?.status === "working";
}

/**
 * Whether a completed operation still owns the slot it started in.
 *
 * A response from a superseded request — the user clicked again, or moved
 * to another trace — must not overwrite newer state.
 */
export function isCurrent(registry: OperationRegistry, state: OperationState): boolean {
  return registry[state.kind]?.id === state.id;
}
