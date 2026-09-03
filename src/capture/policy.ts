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

/** No page should be able to make a capture unboundedly large. */
const MAX_OPTIONS = 60;
const MAX_OPTION_LENGTH = 80;

/**
 * The choices a closed-set control was offering, as text.
 *
 * Read from whatever the application had on screen: a native `<select>`'s
 * own options, or the listbox a custom combobox declares it controls.
 * Nothing is opened, nothing is clicked, and a control that is not showing
 * its choices simply yields none — an absent set is honest, while a
 * fabricated one would put values into a published contract that the
 * application never offered.
 *
 * Masked fields yield nothing regardless: a set of choices for a sensitive
 * control is still content from a sensitive control.
 */
export function optionsInListbox(listbox: Element): string[] | undefined {
  const texts: string[] = [];
  for (const option of Array.from(listbox.querySelectorAll('[role="option"]'))) {
    const text = (option.getAttribute("title") ?? option.textContent)?.replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_OPTION_LENGTH || texts.includes(text)) continue;
    texts.push(text);
  }
  return texts.length > 0 ? texts.slice(0, MAX_OPTIONS) : undefined;
}

export function optionsFor(element: Element, field: FieldDescriptor): string[] | undefined {
  if (isSensitiveField(field)) return undefined;

  const texts: string[] = [];
  const push = (value: string | null | undefined): void => {
    const text = value?.replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_OPTION_LENGTH || texts.includes(text)) return;
    texts.push(text);
  };

  if (element instanceof HTMLSelectElement) {
    for (const option of Array.from(element.options)) push(option.label || option.textContent);
  } else {
    // A custom combobox names the listbox it owns. Following that
    // declaration is the application's own answer about which choices
    // belong to this control — unlike picking whichever listbox happens to
    // be open, which on a busy page is a different control's.
    const owned = element.getAttribute("aria-controls") ?? element.getAttribute("aria-owns");
    const listbox = owned
      ? (element.ownerDocument?.getElementById(owned) ?? undefined)
      : undefined;
    for (const option of Array.from(listbox?.querySelectorAll('[role="option"]') ?? [])) {
      push(option.getAttribute("title") ?? option.textContent);
    }
  }

  return texts.length > 0 ? texts.slice(0, MAX_OPTIONS) : undefined;
}

/**
 * The key a control's choices are remembered under.
 *
 * One control can present two spellings of its own name: an application
 * marks a required field by rendering an asterisk into the label, and
 * whether that asterisk is included depends on which element the name was
 * read from. A live capture recorded a Salesforce picklist's choices
 * against "Stage" and then looked for them under "*Stage", so all six
 * values were captured and then dropped — while the optional field beside
 * it, having no asterisk to disagree about, worked perfectly.
 *
 * Only for matching. The label itself is stored as the application wrote
 * it, because that is what the binding resolves against.
 */
export function choiceKey(label: string): string {
  return label
    .replace(/^[*\u2022\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
