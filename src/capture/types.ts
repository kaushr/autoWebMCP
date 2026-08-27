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

/* ------------------------------------------------------------------ *
 * Teach Mode capture (browser extension)
 *
 * These types describe the *raw sensor* output of the extension: one
 * user action, one application reaction, or one sanitized network
 * observation. They are deliberately value-light and selector-free.
 * `normalize.ts` reduces them to the semantic evidence trace that the
 * Training Studio and semanticizer consume.
 * ------------------------------------------------------------------ */

export type CaptureEventKind = "navigate" | "click" | "field_change" | "submit" | "reaction" | "network";

export interface CapturePageContext {
  host: string;
  /** Path only. Query values are never retained; see `normalizeEndpoint`. */
  path: string;
  title?: string;
}

export type CaptureControlKind =
  | "text"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "date"
  | "number"
  | "combobox"
  | "masked"
  | "other";

export interface CaptureFieldContext {
  label?: string;
  /** Nearest enclosing section/card/fieldset heading, e.g. "Opportunity Details". */
  section?: string;
  control: CaptureControlKind;
}

/** A field value transition. `masked` means the value was withheld by policy. */
export interface CaptureValueChange {
  from?: string;
  to?: string;
  masked: boolean;
}

/** What the application did immediately after a user action. */
export interface CaptureReaction {
  domMutations: number;
  urlChanged: boolean;
  validationShown: boolean;
  fieldsAppeared: boolean;
  dialogShown: boolean;
  toastShown: boolean;
  /** Visible text length changed, which survives frameworks that batch mutations. */
  contentChanged: boolean;
}

export type NetworkCategory = "read" | "mutation" | "document" | "other";

/**
 * Sanitized network metadata. It never contains headers, cookies, tokens,
 * bodies, or query-string values.
 */
export interface CaptureNetworkMetadata {
  method: string;
  /** Path pattern with identifiers replaced, e.g. `/sobjects/Opportunity/:id`. */
  endpoint: string;
  status: number;
  durationMs: number;
  category: NetworkCategory;
}

export interface CaptureEvent {
  id: string;
  kind: CaptureEventKind;
  /** Milliseconds since session start. */
  t: number;
  page: CapturePageContext;
  element?: SafeElementContext;
  field?: CaptureFieldContext;
  value?: CaptureValueChange;
  reaction?: CaptureReaction;
  network?: CaptureNetworkMetadata;
  /** For reactions: the capture event id of the action that preceded it. */
  correlatesWith?: string;
  /** Accessible action label, such as the text of the clicked button. */
  actionLabel?: string;
}

export type CapturePlatform = "salesforce-lightning" | "prospect-intelligence" | "generic";

export interface CaptureApplicationContext {
  host: string;
  platform: CapturePlatform;
  title?: string;
}
