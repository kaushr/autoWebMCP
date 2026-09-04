import type { BrowserExecutionBinding } from "../binding/browserExecution/model";
import type { BrowserQueryBinding, QueryOutcome } from "../binding/browserExecution/query";
import {
  EXECUTION_TIMEOUTS,
  nothingWasDispatched,
  type AcquisitionFailureReason
} from "../../extension/src/protocol";
import type { DomainInspection } from "../binding/browserExecution/execute";
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
  /**
   * `requireTarget` demands an explicit record identity — set by the
   * published tool, never by the Studio's manual test. A human testing a
   * binding chose the record by opening it; an agent has chosen nothing,
   * and the agent-facing contract must not inherit "whatever is open".
   */
  execute(
    binding: BrowserExecutionBinding,
    inputs: Record<string, string>,
    options?: { requireTarget?: boolean; acknowledgesInvocationId?: string }
  ): Promise<ExecutionResult>;
  /**
   * Asks the live application which values its closed-domain controls
   * currently offer. Reads only — nothing is written and nothing is saved —
   * so it carries no execution confirmation.
   *
   * Returns a result rather than throwing, because "which hop failed" is
   * information the caller needs: a stale extension, an unregistered target
   * tab, and an unreachable content script all need different things from
   * the user, and a single thrown timeout told them apart from nothing.
   */
  acquireDomains(binding: BrowserExecutionBinding): Promise<DomainAcquisition>;
  /**
   * Runs a taught entity search and returns the candidates it found.
   *
   * Carries no confirmation, unlike `execute`: a search types into the
   * application's own query UI and reads links. Nothing is written, so
   * there is no mutation for a human to have approved.
   */
  query(binding: BrowserQueryBinding, inputs: Record<string, string>): Promise<QueryOutcome>;
}

export type DomainAcquisition =
  | { ok: true; inspection: DomainInspection }
  | { ok: false; reason: AcquisitionFailureReason; detail: string };

/** How long to wait for the presence probe. It is answered synchronously by any current bridge. */
const PROBE_TIMEOUT_MS = 1_500;
/**
 * Deliberately longer than the work it waits on.
 *
 * The inspection's own budget is bounded in the content script; this must
 * stay above it, or a slow-but-working operation is reported as an
 * unresponsive extension — which is exactly the misdiagnosis this whole
 * path has produced twice.
 */
const ACQUIRE_TIMEOUT_MS = 35_000;

/** What the bridge must speak for the Studio's current requests to be understood. */
const REQUIRED_PROTOCOL = 4;
const BRIDGE_MARKER = "data-autowebmcp-bridge";

/**
 * Is a bridge present, and does it speak our protocol?
 *
 * Checked before the real request because an older bridge answers nothing
 * at all for a request kind it predates — so without this, "the extension
 * needs reloading" is indistinguishable from "the extension is not
 * installed", and both cost a full timeout to discover.
 */
async function probeBridge(): Promise<{ ok: true } | { ok: false; reason: AcquisitionFailureReason; detail: string }> {
  const marker = document.documentElement.getAttribute(BRIDGE_MARKER);
  if (marker !== null) {
    return Number(marker) >= REQUIRED_PROTOCOL
      ? { ok: true }
      : {
          ok: false,
          reason: "studio-bridge-outdated",
          detail: `The Teach Mode extension is installed but out of date (it speaks version ${marker}; this page needs ${REQUIRED_PROTOCOL}). Reload it at chrome://extensions, then reload this page.`
        };
  }

  try {
    await bridgeRequest<number>({ kind: "hello" }, "hello", PROBE_TIMEOUT_MS, (data) =>
      typeof data.protocol === "number" ? data.protocol : undefined
    );
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: "extension-unavailable",
      detail:
        "The Teach Mode extension did not respond. It may not be installed or enabled, or it may be an older version " +
        "that predates this feature. Reload it at chrome://extensions, then reload this page."
    };
  }
}

const STUDIO_BRIDGE_SOURCE = "autowebmcp-studio-bridge";
/**
 * Generous on purpose: a single execution can legitimately spend up to ~8s
 * retrying target resolution alone (see `execute.ts`'s `resolveAllTargets`,
 * added after live Salesforce evidence showed a form settling well after
 * its container first appears), plus separate waits for the edit surface to
 * open and for the page to settle again after committing. Timing this out
 * too eagerly would misreport a slow-but-working execution as an
 * unreachable extension.
 */
const RESPONSE_TIMEOUT_MS = EXECUTION_TIMEOUTS.STUDIO;

/**
 * The outermost step of a deliberately ordered ladder, so that whichever
 * hop actually stopped is the one that gets to say so:
 *
 *   38s  the execution's own ceiling, in the content script — the only
 *        context that knows how far it got
 *   42s  the service worker waiting on that tab
 *   46s  the bridge waiting on the service worker
 *   50s  here
 *
 * Before this, execution had a bound only at this outermost step. Every
 * hop below was unbounded, so a content script destroyed mid-run — which
 * is what opening a record does — produced silence that travelled the
 * whole way out and arrived, 45 seconds later, as "the extension did not
 * respond": a sentence about the wrong component, describing a write that
 * had in fact been dispatched.
 */

function newRequestId(prefix = "exec"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A failure that knows which hop produced it. */
class BridgeError extends Error {
  constructor(
    message: string,
    readonly reason: AcquisitionFailureReason
  ) {
    super(message);
  }
}

/** One request/response round trip over the Studio bridge. */
function bridgeRequest<T>(
  payload: Record<string, unknown>,
  prefix: string,
  timeoutMs: number,
  take: (data: Record<string, unknown>) => T | undefined,
  reasonOf: (data: Record<string, unknown>) => AcquisitionFailureReason | undefined = () => undefined
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const requestId = newRequestId(prefix);
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(
        new BridgeError(
          `The Teach Mode extension did not respond within ${Math.round(timeoutMs / 1000)}s.`,
          "introspection-timeout"
        )
      );
    }, timeoutMs);

    function onMessage(event: MessageEvent): void {
      if (event.source !== window) return;
      const data = event.data as Record<string, unknown> | undefined;
      if (data?.source !== STUDIO_BRIDGE_SOURCE || data.direction !== "response" || data.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      const value = data.ok ? take(data) : undefined;
      if (value !== undefined) resolve(value);
      else {
        reject(
          new BridgeError(
            typeof data.error === "string" ? data.error : "The request failed.",
            reasonOf(data) ?? "introspection-failed"
          )
        );
      }
    }

    window.addEventListener("message", onMessage);
    window.postMessage(
      { source: STUDIO_BRIDGE_SOURCE, direction: "request", requestId, ...payload },
      window.location.origin
    );
  });
}

/**
 * Sends an execution request to the Teach Mode extension's Studio-bridge
 * content script via `window.postMessage`, and waits for its response.
 * Requires the extension to be installed and its content script present on
 * this origin — see `extension/manifest.json` — which is exactly the "no
 * generic MCP server, no parallel Salesforce-only runtime" seam this task
 * asked for: the extension already has live tab access; this only reaches it.
 */
/**
 * A search that never ran, in the shape a search answers in.
 *
 * `blocked` rather than `no-results`: nothing was searched, and an empty
 * candidate list is a claim about the application's data that a page which
 * never reached the application is in no position to make.
 *
 * The detail goes in `warnings` because that is where the agent loop reads
 * a blocked search's reason from — see `observation.ts`. Putting it in
 * `evidence` would preserve it for a human reading the trace and lose it
 * for the caller that has to decide what to do next.
 */
function searchThatNeverRan(detail: string): QueryOutcome {
  return {
    status: "blocked",
    candidates: [],
    evidence: [],
    warnings: [detail],
    executedAt: new Date().toISOString()
  };
}

export const extensionBridgeExecutionClient: BrowserExecutionClient = {
  async execute(binding, inputs, options) {
    // One id for this attempt, carried to the page and back. A redelivery
    // of THIS id is the same transaction and must not run twice; a fresh
    // call with identical arguments is a different transaction and must.
    const invocationId = newRequestId("inv");
    try {
      return await bridgeRequest<ExecutionResult>(
        {
          binding,
          inputs,
          confirmed: true,
          invocationId,
          ...(options?.acknowledgesInvocationId
            ? { acknowledgesInvocationId: options.acknowledgesInvocationId }
            : {}),
          ...(options?.requireTarget ? { requireTarget: true } : {})
        },
        "exec",
        RESPONSE_TIMEOUT_MS,
        (data) => {
          const result = data.result as ExecutionResult | undefined;
          if (!result) return undefined;
          // A result produced by an older extension than this page expects is
          // evidence about the wrong code. Three live runs were analysed that
          // way before anything reported the mismatch.
          const ran = typeof data.protocol === "number" ? data.protocol : 0;
          if (ran >= REQUIRED_PROTOCOL) return result;
          return {
            ...result,
            warnings: [
              `This result came from an older Teach Mode extension (version ${ran || "unknown"}; this page expects ` +
                `${REQUIRED_PROTOCOL}). Reload the extension at chrome://extensions, reload this page, then re-run — ` +
                "the findings below may describe code that is no longer current.",
              ...result.warnings
            ]
          };
        },
        (data) => data.reason as AcquisitionFailureReason | undefined
      );
    } catch (error) {
      return executionWithoutAnswer(invocationId, error);
    }
  },

  async query(binding, inputs) {
    // A search reaches the taught application over the same hops an
    // execution does, so it fails the same ways: no extension, an
    // outdated bridge, no registered target tab. `execute` reports each of
    // those as a result a caller can read. This did not, and the cost was
    // paid in a live run — a rejected promise leaving a WebMCP tool is
    // replaced by the browser with "the invocation failed", which names
    // neither the hop that failed nor what to do about it, and an evening
    // went into guessing which of three unrelated causes it was.
    const probe = await probeBridge();
    if (!probe.ok) return searchThatNeverRan(probe.detail);

    try {
      return await bridgeRequest<QueryOutcome>(
        { kind: "query", queryBinding: binding, inputs },
        "query",
        RESPONSE_TIMEOUT_MS,
        (data) => data.outcome as QueryOutcome | undefined,
        (data) => data.reason as AcquisitionFailureReason | undefined
      );
    } catch (error) {
      return searchThatNeverRan(error instanceof Error ? error.message : String(error));
    }
  },

  async acquireDomains(binding) {
    const probe = await probeBridge();
    if (!probe.ok) return probe;

    try {
      // Shorter budget than execution: this opens a popup, reads it, and
      // closes it. It does not write, commit, or wait for a save.
      const inspection = await bridgeRequest<DomainInspection>(
        { kind: "inspect", binding },
        "inspect",
        ACQUIRE_TIMEOUT_MS,
        (data) => data.inspection as DomainInspection | undefined,
        (data) => data.reason as AcquisitionFailureReason | undefined
      );
      return { ok: true, inspection };
    } catch (error) {
      const reason = error instanceof BridgeError ? error.reason : "introspection-failed";
      return { ok: false, reason, detail: error instanceof Error ? error.message : String(error) };
    }
  }
};

/**
 * What to report when a dispatched execution produced no result.
 *
 * The distinction this exists to preserve: an execution that never left
 * this page did not happen, and one that was handed to the extension and
 * then went quiet MIGHT have. A live run made the difference concrete — a
 * Salesforce Opportunity was updated exactly as requested while the caller
 * was told the write had failed, and the agent, believing that, ran it
 * again.
 *
 * `blocked` is used only where nothing could have been dispatched at all.
 * Everything else is `unknown`, which says the honest thing: read the
 * record before running this again.
 */
function executionWithoutAnswer(invocationId: string, error: unknown): ExecutionResult {
  const reason = error instanceof BridgeError ? error.reason : undefined;
  const detail = error instanceof Error ? error.message : String(error);
  // These are refusals to dispatch, not lost answers: the request never
  // reached a page, so nothing can have been written.
  const neverDispatched = nothingWasDispatched(reason);

  if (neverDispatched) {
    return {
      status: "blocked",
      dispatch: { invocationId, phase: "received", mayHavePersisted: false },
      checks: [],
      evidence: [],
      warnings: [`${detail} Nothing was dispatched, so nothing was changed.`],
      executedAt: new Date().toISOString()
    };
  }

  return {
    status: "unknown",
    // No phase, because this layer observed none: the context that knew is
    // gone. Conservative on the one thing that matters — the save COULD
    // have been issued — without inventing a position in the sequence it
    // never saw.
    dispatch: { invocationId, mayHavePersisted: true },
    checks: [],
    evidence: [`Invocation ${invocationId} was dispatched and produced no result.`],
    warnings: [
      `${detail} The execution was dispatched, so whether it changed anything is not established. Do not simply ` +
        "invoke this again: read the record first, and treat a repeat as a new transaction, not a retry."
    ],
    executedAt: new Date().toISOString()
  };
}
