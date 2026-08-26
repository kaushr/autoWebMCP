import { record } from "@rrweb/record";
import type { CaptureProbeSnapshot, RawEventSummary, SafeElementContext, SafeInteraction, SafeInteractionKind } from "./types";

type RawRrwebEvent = { type?: number };

function compactText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= 80 ? normalized : undefined;
}

function elementContext(target: EventTarget | null): SafeElementContext | undefined {
  if (!(target instanceof Element)) return undefined;
  const labelledBy = target.getAttribute("aria-labelledby");
  const labelledNode = labelledBy ? document.getElementById(labelledBy) : undefined;
  const label =
    compactText(target.getAttribute("aria-label")) ??
    compactText(labelledNode?.textContent) ??
    compactText(target.closest("label")?.textContent) ??
    compactText(target.getAttribute("title"));

  return {
    tag: target.tagName.toLowerCase(),
    ...(label ? { label } : {}),
    ...(target.getAttribute("role") ? { role: target.getAttribute("role")! } : {}),
    ...(target.getAttribute("name") ? { name: target.getAttribute("name")! } : {}),
    ...(target.getAttribute("data-testid") ? { testId: target.getAttribute("data-testid")! } : {})
  };
}

function toRawSummary(events: RawRrwebEvent[]): RawEventSummary {
  const byType: Record<string, number> = {};
  for (const event of events) {
    const type = String(event.type ?? "unknown");
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return { total: events.length, byType };
}

/**
 * P0-2 only: validates rrweb event quality in a controlled page. It keeps raw
 * events in memory and separately records safe interaction metadata. It does
 * not persist, replay, transmit, or inspect network traffic.
 */
export function startRrwebCaptureProbe(onChange: (snapshot: CaptureProbeSnapshot) => void): () => CaptureProbeSnapshot {
  const rawEvents: RawRrwebEvent[] = [];
  const interactions: SafeInteraction[] = [];
  let active = true;

  const snapshot = (): CaptureProbeSnapshot => ({ active, raw: toRawSummary(rawEvents), interactions: [...interactions] });
  const publish = () => onChange(snapshot());
  const observe = (kind: SafeInteractionKind) => (event: Event) => {
    interactions.push({
      id: crypto.randomUUID(),
      kind,
      timestamp: Date.now(),
      ...(elementContext(event.target) ? { element: elementContext(event.target) } : {})
    });
    publish();
  };

  const stopRrweb = record({
    emit(event) {
      rawEvents.push(event);
      publish();
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

  const listeners: Array<[keyof DocumentEventMap, EventListener]> = [
    ["click", observe("click")],
    ["change", observe("field_change")],
    ["focusin", observe("focus")]
  ];
  for (const [event, listener] of listeners) document.addEventListener(event, listener, true);
  publish();

  return () => {
    if (!active) return snapshot();
    active = false;
    stopRrweb?.();
    for (const [event, listener] of listeners) document.removeEventListener(event, listener, true);
    publish();
    return snapshot();
  };
}
