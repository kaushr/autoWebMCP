import { record } from "@rrweb/record";
import {
  controlKindFor,
  detectPlatform,
  pagePath,
  safeValueChange,
  type FieldDescriptor
} from "../../src/capture/policy";
import { replaceMessageListener, STUDIO_BRIDGE_PROTOCOL } from "./protocol";
import type {
  CaptureApplicationContext,
  CaptureEvent,
  CaptureEventKind,
  CaptureFieldContext,
  CapturePageContext,
  CaptureReaction,
  SafeElementContext
} from "../../src/capture/types";
import type {
  BrowserBindingExecuteRequest,
  BrowserBindingInspectRequest,
  BrowserBindingInspectResponse,
  BrowserBindingExecuteResponse,
  CaptureFlush,
  CaptureSettings,
  ToContentMessage
} from "./protocol";
import { executeConfirmed, inspectValueDomains } from "../../src/binding/browserExecution/execute";
import {
  resolutionProvenanceForPlatform,
  resolverAdapterForPlatform
} from "../../src/binding/browserExecution/adapters";

/**
 * Teach Mode sensor.
 *
 * rrweb records the page as the raw substrate, but its events never leave
 * this script: only a count, and derived "did the application react" signal,
 * cross the boundary. Everything sent to the service worker is safe element
 * and value metadata produced by the shared capture policy.
 *
 * This is deliberately not a recorder for replay: no selectors, coordinates,
 * or key sequences are captured.
 */

declare global {
  interface Window {
    __autoWebMcpCapture?: { stop: () => CaptureFlush };
    /**
     * The message listener this document currently has installed, kept so a
     * re-injection can remove it before installing its own. A boolean
     * "already installed" flag cannot do that job — see the install block.
     */
    __autoWebMcpListener?: ContentMessageListener;
    /** Set while a read-only inspection is running, so a second one cannot start on top of it. */
    __autoWebMcpInspecting?: true;
  }
}

const FLUSH_INTERVAL_MS = 800;
const REACTION_WINDOW_MS = 1_200;
const NAVIGATION_POLL_MS = 400;
const MAX_LABEL_LENGTH = 80;

const ACTIONABLE =
  "button, a[href], [role=button], [role=link], [role=option], [role=menuitem], [role=tab], [role=checkbox], [role=switch], input[type=submit], input[type=button], summary, label";

/** Elements whose own text is their name. Containers are excluded on purpose. */
const NAMED_BY_CONTENT =
  "button, a, [role=button], [role=link], [role=option], [role=menuitem], [role=tab], summary, legend, h1, h2, h3, h4, h5, h6";

const SECTION =
  "[role=dialog], [role=region], [role=tabpanel], form, fieldset, section, article, .slds-card, .slds-form-element__group, .panel";

const HEADING = "[role=heading], h1, h2, h3, h4, h5, h6, legend, .slds-card__header-title, .panel-heading h2";

const VALIDATION = '[role=alert], [aria-invalid="true"], .slds-has-error, .error, .invalid-feedback';
const DIALOG = '[role=dialog], [aria-modal="true"], dialog[open]';
const TOAST = "[role=status], .slds-notify, .toast, .snackbar";
const FIELDS = "input, select, textarea, [role=combobox], [contenteditable=true]";

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function compact(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > MAX_LABEL_LENGTH ? `${normalized.slice(0, MAX_LABEL_LENGTH)}…` : normalized;
}

function page(): CapturePageContext {
  return {
    host: location.host,
    path: pagePath(location),
    ...(compact(document.title) ? { title: compact(document.title)! } : {})
  };
}

/* --------------------------- page semantics -------------------------- */

function labelledByText(element: Element): string | undefined {
  const ids = element.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
  const text = ids
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
  return compact(text);
}

/**
 * The text a label contributes, excluding any control it wraps. Without this a
 * `<label>Function<select>…</select></label>` reads as its own option list.
 */
function labelText(label: Element | null | undefined): string | undefined {
  if (!label) return undefined;
  const clone = label.cloneNode(true) as Element;
  for (const control of clone.querySelectorAll("input, select, textarea, option, button")) control.remove();
  return compact(clone.textContent);
}

function accessibleLabel(element: Element): string | undefined {
  const explicitId = element.getAttribute("id");
  const forLabel = explicitId ? document.querySelector(`label[for="${CSS.escape(explicitId)}"]`) : null;

  return (
    compact(element.getAttribute("aria-label")) ??
    labelledByText(element) ??
    labelText(forLabel) ??
    labelText(element.closest("label")) ??
    compact(element.closest(".slds-form-element")?.querySelector(".slds-form-element__label")?.textContent) ??
    compact(element.getAttribute("placeholder")) ??
    compact(element.getAttribute("title")) ??
    (element.matches(NAMED_BY_CONTENT) ? compact(element.textContent) : undefined) ??
    compact(element.getAttribute("name"))
  );
}

function sectionContext(element: Element): string | undefined {
  let section = element.closest(SECTION);
  while (section) {
    const named =
      compact(section.getAttribute("aria-label")) ?? compact(section.querySelector(HEADING)?.textContent);
    if (named) return named;
    section = section.parentElement?.closest(SECTION) ?? null;
  }
  return undefined;
}

function elementContext(element: Element): SafeElementContext {
  const label = accessibleLabel(element);
  const role = element.getAttribute("role");
  const name = element.getAttribute("name");
  const testId = element.getAttribute("data-testid");
  return {
    tag: element.tagName.toLowerCase(),
    ...(label ? { label } : {}),
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(testId ? { testId } : {})
  };
}

/**
 * Whether an element is actually on screen.
 *
 * Component libraries keep empty live regions, collapsed dialogs, and toast
 * containers in the DOM permanently. Counting elements rather than *visible*
 * ones turns any of them appearing or being replaced into "a toast was shown",
 * which is how a click on Search came to report a confirmation.
 */
function isVisible(element: Element): boolean {
  if (element.getAttribute("aria-hidden") === "true") return false;
  if (element instanceof HTMLElement && element.hidden) return false;
  return element.getClientRects().length > 0;
}

function countVisible(selector: string, extra?: (element: Element) => boolean): number {
  let visible = 0;
  for (const element of document.querySelectorAll(selector)) {
    if (!isVisible(element)) continue;
    if (extra && !extra(element)) continue;
    visible += 1;
  }
  return visible;
}

function descriptorFor(element: Element): FieldDescriptor {
  const tag = element.tagName.toLowerCase();
  const type =
    element instanceof HTMLInputElement ? element.type : element.getAttribute("role") === "combobox" ? "combobox" : tag;
  return {
    type,
    ...(element.getAttribute("name") ? { name: element.getAttribute("name")! } : {}),
    ...(element.getAttribute("id") ? { id: element.getAttribute("id")! } : {}),
    ...(accessibleLabel(element) ? { label: accessibleLabel(element)! } : {}),
    ...(element.getAttribute("autocomplete") ? { autocomplete: element.getAttribute("autocomplete")! } : {})
  };
}

/**
 * The element that actually holds the value.
 *
 * A change event crossing a shadow boundary is retargeted to the host, so on a
 * component library the target is the custom element rather than the control
 * the human typed into. The composed path still starts at the real one.
 */
function valueSource(event: Event): Element | undefined {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const entry of path) {
    if (entry instanceof HTMLInputElement || entry instanceof HTMLSelectElement || entry instanceof HTMLTextAreaElement) {
      return entry;
    }
  }
  return event.target instanceof Element ? event.target : undefined;
}

/**
 * A value, or nothing.
 *
 * Never an element's text. A compound control's text is its entire widget —
 * "*Close DateSelect a date for Close DatePrevious MonthOctober…" — which is a
 * description of the control, not what the human entered. Recording that as a
 * value teaches the semanticizer nonsense, so an unreadable control reports no
 * value at all and the interaction is still captured.
 */
function readableValue(element: Element): string | undefined {
  if (element instanceof HTMLSelectElement) {
    return compact(element.selectedOptions[0]?.textContent ?? element.value);
  }
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") return element.checked ? "checked" : "unchecked";
    return element.value === "" ? undefined : element.value;
  }
  if (element instanceof HTMLTextAreaElement) return element.value === "" ? undefined : element.value;
  if (element.getAttribute("contenteditable") === "true") return compact(element.textContent);

  // Many components mirror their control's value onto the host element.
  const hosted = (element as Element & { value?: unknown }).value;
  if (typeof hosted === "string") return hosted === "" ? undefined : hosted;
  if (typeof hosted === "number" || typeof hosted === "boolean") return String(hosted);
  return undefined;
}

function fieldContext(element: Element): CaptureFieldContext {
  const descriptor = descriptorFor(element);
  return {
    ...(descriptor.label ? { label: descriptor.label } : {}),
    ...(sectionContext(element) ? { section: sectionContext(element)! } : {}),
    control: controlKindFor(descriptor)
  };
}

function applicationContext(): CaptureApplicationContext {
  const lightning = Boolean(
    document.querySelector("one-record-home-flexipage2, [data-aura-rendered-by], .slds-scope, .oneHeader")
  );
  const prospect = Boolean(
    document.querySelector(
      "[data-app='prospect-intelligence'], .training-studio"
    )
  );
  return {
    host: location.host,
    platform: detectPlatform(location.host, { lightning, prospect }),
    ...(compact(document.title) ? { title: compact(document.title)! } : {})
  };
}

/* ------------------------------ capture ------------------------------ */

function start(sessionId: string, startedAt: number, settings: CaptureSettings): { stop: () => CaptureFlush } {
  const queue: CaptureEvent[] = [];
  const previousValues = new WeakMap<Element, string | undefined>();
  let rrwebEvents = 0;
  let mutationEvents = 0;
  let lastUrl = location.href;

  interface PendingReaction {
    actionId: string;
    timer: number;
    marks: ReturnType<typeof markPage>;
    mutationsAt: number;
  }

  // Several windows may be open at once: a human often acts again before the
  // application has finished responding to the previous action, and closing
  // the earlier window early would under-report what the application did.
  const pending: PendingReaction[] = [];
  const MAX_PENDING = 4;

  function markPage() {
    return {
      url: location.href,
      validation: countVisible(VALIDATION),
      dialog: countVisible(DIALOG),
      toast: countVisible(TOAST, (element) => Boolean(compact(element.textContent))),
      fields: document.querySelectorAll(FIELDS).length,
      content: document.body.textContent?.length ?? 0
    };
  }

  function push(kind: CaptureEventKind, event: Partial<CaptureEvent>): CaptureEvent {
    const captured: CaptureEvent = {
      id: newId(kind),
      kind,
      t: Math.max(0, Date.now() - startedAt),
      page: page(),
      ...event
    };
    queue.push(captured);
    return captured;
  }

  function closeReaction(entry: PendingReaction): void {
    const index = pending.indexOf(entry);
    if (index === -1) return;
    pending.splice(index, 1);
    window.clearTimeout(entry.timer);

    const now = markPage();
    const reaction: CaptureReaction = {
      domMutations: mutationEvents - entry.mutationsAt,
      urlChanged: now.url !== entry.marks.url,
      validationShown: now.validation > entry.marks.validation,
      fieldsAppeared: now.fields > entry.marks.fields,
      dialogShown: now.dialog > entry.marks.dialog,
      toastShown: now.toast > entry.marks.toast,
      contentChanged: now.content !== entry.marks.content
    };
    push("reaction", { correlatesWith: entry.actionId, reaction });
  }

  function closeAllReactions(): void {
    for (const entry of [...pending]) closeReaction(entry);
  }

  /** Opens a short window in which the application's response to `actionId` is summarized. */
  function watchReaction(actionId: string): void {
    if (pending.length >= MAX_PENDING) closeReaction(pending[0]!);
    const entry: PendingReaction = {
      actionId,
      marks: markPage(),
      mutationsAt: mutationEvents,
      timer: 0
    };
    entry.timer = window.setTimeout(() => closeReaction(entry), REACTION_WINDOW_MS);
    pending.push(entry);
  }

  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionable = target.closest(ACTIONABLE) ?? target;
    const context = elementContext(actionable);
    const captured = push("click", {
      element: context,
      ...(context.label ? { actionLabel: context.label } : {}),
      ...(sectionContext(actionable) ? { field: { section: sectionContext(actionable)!, control: "other" } } : {})
    });
    watchReaction(captured.id);
  };

  const onFocus = (event: Event): void => {
    const source = valueSource(event);
    if (source) previousValues.set(source, readableValue(source));
  };

  const onChange = (event: Event): void => {
    const target = valueSource(event);
    if (!target) return;
    const descriptor = descriptorFor(target);
    const next = readableValue(target);
    const previous = previousValues.get(target);
    previousValues.set(target, next);

    const change = settings.captureValues
      ? safeValueChange(descriptor, previous, next)
      : { masked: true as const };

    const captured = push("field_change", {
      element: elementContext(target),
      field: fieldContext(target),
      value: change
    });
    watchReaction(captured.id);
  };

  const onSubmit = (event: Event): void => {
    const target = event.target;
    const label = target instanceof Element ? accessibleLabel(target) : undefined;
    const captured = push("submit", { ...(label ? { actionLabel: label } : {}) });
    watchReaction(captured.id);
  };

  const listeners: Array<[keyof DocumentEventMap, EventListener]> = [
    ["click", onClick],
    ["focusin", onFocus],
    ["change", onChange],
    ["submit", onSubmit]
  ];
  for (const [type, listener] of listeners) document.addEventListener(type, listener, true);

  const stopRrweb = record({
    emit(event: { type?: number }) {
      rrwebEvents += 1;
      if (event.type === 3) mutationEvents += 1;
    },
    maskAllInputs: true,
    maskInputOptions: { password: true },
    blockSelector: "[data-automcp-block], input[type=password]",
    maskTextSelector: "[data-automcp-mask]",
    recordCanvas: false,
    inlineImages: false,
    collectFonts: false,
    sampling: { mousemove: false, scroll: 500, input: "last" }
  });

  const navigationTimer = window.setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    push("navigate", {});
  }, NAVIGATION_POLL_MS);

  const flushTimer = window.setInterval(() => void flush(), FLUSH_INTERVAL_MS);

  async function flush(): Promise<void> {
    if (queue.length === 0) return;
    const events = queue.splice(0, queue.length);
    try {
      await chrome.runtime.sendMessage({ type: "capture:events", sessionId, events, rrwebEvents });
    } catch {
      // The service worker went away; stop losing cycles on this batch.
    }
  }

  push("navigate", {});
  void chrome.runtime
    .sendMessage({ type: "capture:context", sessionId, application: applicationContext() })
    .catch(() => undefined);

  return {
    stop(): CaptureFlush {
      closeAllReactions();
      window.clearInterval(navigationTimer);
      window.clearInterval(flushTimer);
      stopRrweb?.();
      for (const [type, listener] of listeners) document.removeEventListener(type, listener, true);
      return { events: queue.splice(0, queue.length), rrwebEvents };
    }
  };
}

/**
 * Runs one browser execution binding against this tab's live DOM. The
 * confirmation is re-checked here, at the boundary that actually touches the
 * page, rather than trusted from the message that carried it — the same
 * defense `executeConfirmed` itself applies, kept even though the sender
 * (the Studio-bridge) already required it once.
 */
async function runExecuteRequest(request: BrowserBindingExecuteRequest): Promise<BrowserBindingExecuteResponse> {
  if (request.confirmed !== true) {
    return { ok: false, error: "Execution refused: no explicit confirmation was supplied." };
  }
  try {
    const result = await executeConfirmed({
      root: document,
      binding: request.binding,
      inputs: request.inputs,
      adapter: resolverAdapterForPlatform(request.binding.platform),
      confirmed: true,
      ...(request.requireTarget ? { requireTarget: true } : {})
    });
    // Which pack knowledge governed this run, recorded alongside the result
    // so an execution can be audited back to the platform facts that shaped it.
    const provenance = resolutionProvenanceForPlatform(request.binding.platform);
    return {
      ok: true,
      protocol: STUDIO_BRIDGE_PROTOCOL,
      result: provenance ? { ...result, evidence: [provenance, ...result.evidence] } : result
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Reads what this tab's closed-domain controls currently offer. Writes
 * nothing and never saves, so unlike execution it carries no confirmation
 * — there is no business change here for a person to authorize.
 */
async function runInspectRequest(request: BrowserBindingInspectRequest): Promise<BrowserBindingInspectResponse> {
  // An inspection is read-only but not side-effect free: it enters edit
  // mode, opens a control, and puts both back. Two of them on one record
  // interleave those steps, so the second is refused rather than allowed to
  // dismiss a modal the first is still reading.
  if (window.__autoWebMcpInspecting) {
    return {
      ok: false,
      reason: "introspection-failed",
      error:
        "An inspection of this page is already running. Wait for it to finish before starting another — two at " +
        "once would interfere with each other on the same record."
    };
  }
  window.__autoWebMcpInspecting = true;
  console.debug("[AutoWebMCP] content: inspecting value domains on", window.location.href);
  try {
    // Bounded on purpose. Left to their defaults these waits add up to
    // roughly twenty seconds — edit-state poll, settle, read, cancel poll,
    // settle again — which is close enough to the caller's patience that a
    // slow-but-working inspection gets reported as an unresponsive
    // extension. The work must always finish before the caller gives up.
    const inspection = await inspectValueDomains({
      root: document,
      binding: request.binding,
      adapter: resolverAdapterForPlatform(request.binding.platform),
      reaction: { quietMs: 200, timeoutMs: 1_500 },
      restoreTimeoutMs: 3_000,
      editWaitMs: 3_000
    });
    console.debug("[AutoWebMCP] content: inspection finished", inspection);
    // Which pack knowledge governed this read, recorded alongside the
    // result — execution already carried this; introspection silently
    // didn't, so a failed domain acquisition carried no indication of
    // which pack, version, or rule was even in force.
    const provenance = resolutionProvenanceForPlatform(request.binding.platform);
    return {
      ok: true,
      inspection: provenance ? { ...inspection, evidence: [provenance, ...inspection.evidence] } : inspection
    };
  } catch (error) {
    return {
      ok: false,
      reason: "introspection-failed",
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    // Released whatever happened: a failed inspection that never cleared
    // this would lock the page out of every later attempt.
    window.__autoWebMcpInspecting = undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Exactly one LIVE listener per document.
 *
 * Two failures pull in opposite directions here, and only replacement
 * satisfies both.
 *
 * The service worker injects this file before every operation, and each
 * injection used to register another listener. One `inspect:domains`
 * message then ran N inspections at once — observed live as five
 * completions 400ms apart from a single request — and since an inspection
 * enters edit mode, opens a control, dismisses it and cancels the edit,
 * those N runs competed over the same record.
 *
 * Guarding that with a boolean then broke starting a recording, because
 * the flag outlives the context that set it. Reloading the extension
 * invalidates the old content script — its listener is dead — while the
 * flag stays `true` on the page's isolated world, so the next injection
 * skipped installing a listener and the document was left with none. A
 * boolean cannot tell "a live listener exists" from "a dead one used to".
 *
 * So the listener itself is remembered and replaced. Re-injection into a
 * live context removes the previous listener before adding its own, and
 * re-injection after an extension reload installs a working one; the dead
 * listener it cannot remove is inert anyway.
 * ------------------------------------------------------------------ */
type ContentMessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];

window.__autoWebMcpListener = replaceMessageListener(
  chrome.runtime.onMessage,
  window.__autoWebMcpListener,
  contentMessageListener
);

function contentMessageListener(...[message, _sender, sendResponse]: Parameters<ContentMessageListener>) {
  const request = message as ToContentMessage;
  if (request.type === "capture:begin") {
    window.__autoWebMcpCapture?.stop();
    window.__autoWebMcpCapture = start(request.sessionId, request.startedAt, request.settings);
    sendResponse({ ok: true });
    return true;
  }
  if (request.type === "capture:end") {
    const flush = window.__autoWebMcpCapture?.stop();
    window.__autoWebMcpCapture = undefined;
    sendResponse(flush ?? { events: [], rrwebEvents: 0 });
    return true;
  }
  if (request.type === "execute:run") {
    void runExecuteRequest(request.request).then(sendResponse);
    return true;
  }
  if (request.type === "inspect:domains") {
    void runInspectRequest(request.request).then(sendResponse);
    return true;
  }
  return undefined;
}
