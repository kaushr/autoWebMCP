import type { CaptureControlKind, CapturePlatform, CaptureValueChange } from "./types";

/**
 * DOM-free capture policy. The content script describes a control, and this
 * module decides what may leave the page. Keeping it free of `Element`
 * makes the privacy rules directly unit testable.
 */
export interface FieldDescriptor {
  /** `input` type attribute, or the lowercase tag name for non-inputs. */
  type: string;
  name?: string;
  id?: string;
  label?: string;
  autocomplete?: string;
}

const SENSITIVE_TYPES = new Set(["password", "email", "tel", "hidden"]);

const SENSITIVE_AUTOCOMPLETE = /^(cc-|new-password|current-password|one-time-code)/i;

const SENSITIVE_NAME =
  /(pass(word|code)?|secret|token|auth|session|ssn|social[\s_-]?security|credit|card|cvv|cvc|iban|routing|account[\s_-]?number|api[\s_-]?key|otp|pin)\b/i;

const MAX_VALUE_LENGTH = 64;

export function isSensitiveField(field: FieldDescriptor): boolean {
  if (SENSITIVE_TYPES.has(field.type.toLowerCase())) return true;
  if (field.autocomplete && SENSITIVE_AUTOCOMPLETE.test(field.autocomplete)) return true;
  return [field.name, field.id, field.label].some((value) => Boolean(value && SENSITIVE_NAME.test(value)));
}

export function controlKindFor(field: FieldDescriptor): CaptureControlKind {
  const type = field.type.toLowerCase();
  if (isSensitiveField(field)) return "masked";
  switch (type) {
    case "select":
    case "select-one":
    case "select-multiple":
      return "select";
    case "textarea":
      return "textarea";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "date":
    case "datetime-local":
    case "month":
      return "date";
    case "number":
    case "range":
      return "number";
    case "text":
    case "search":
    case "url":
      return "text";
    default:
      return type === "combobox" ? "combobox" : "other";
  }
}

function truncate(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > MAX_VALUE_LENGTH ? `${compact.slice(0, MAX_VALUE_LENGTH)}…` : compact;
}

/**
 * Produces the value transition that may leave the page. Sensitive controls
 * yield a masked change carrying no value at all — never a redacted
 * placeholder built from the real value.
 */
export function safeValueChange(
  field: FieldDescriptor,
  previous: string | undefined,
  next: string | undefined
): CaptureValueChange {
  if (isSensitiveField(field)) return { masked: true };
  return {
    masked: false,
    ...(previous !== undefined ? { from: truncate(previous) } : {}),
    ...(next !== undefined ? { to: truncate(next) } : {})
  };
}

const MAX_PATH_LENGTH = 200;

/**
 * The page identity a navigation observation is deduped on.
 *
 * Hash routes are real navigation: a client-rendered application can move
 * between search, a record, and a filtered view without `pathname` ever
 * changing. Keying page identity on the path alone makes that entire journey
 * look like a single page and silently discards the evidence.
 *
 * The hash is URL data the human navigated to, and on a faceted view it names
 * the filters they applied. It is retained under the same rule as `pathname`;
 * field values remain governed by `safeValueChange`.
 */
export function pagePath(location: { pathname: string; hash: string }): string {
  const hash = location.hash === "#" ? "" : location.hash;
  const path = `${location.pathname}${hash}`;
  return path.length > MAX_PATH_LENGTH ? `${path.slice(0, MAX_PATH_LENGTH)}…` : path;
}

export interface PlatformMarkers {
  /** A Salesforce Lightning host or DOM marker was present. */
  lightning: boolean;
  /** The controlled Prospect Intelligence demo application. */
  prospect: boolean;
}

/**
 * Platform identification exists only so platform-specific augmentation can
 * be isolated behind an adapter. The capture path itself stays generic.
 */
export function detectPlatform(host: string, markers: PlatformMarkers): CapturePlatform {
  if (markers.lightning || /\.(lightning\.force|my\.salesforce)\.com$/i.test(host)) return "salesforce-lightning";
  if (markers.prospect) return "prospect-intelligence";
  return "generic";
}
