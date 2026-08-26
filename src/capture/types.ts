export type SafeInteractionKind = "click" | "field_change" | "focus" | "navigation";

export interface SafeElementContext {
  tag: string;
  label?: string;
  role?: string;
  name?: string;
  testId?: string;
}

/**
 * Deliberately contains no typed value, DOM HTML, selector, credential, or
 * network payload. Raw rrweb data remains local capture evidence only.
 */
export interface SafeInteraction {
  id: string;
  kind: SafeInteractionKind;
  timestamp: number;
  element?: SafeElementContext;
}

export interface RawEventSummary {
  total: number;
  byType: Record<string, number>;
}

export interface CaptureProbeSnapshot {
  active: boolean;
  raw: RawEventSummary;
  interactions: SafeInteraction[];
}
