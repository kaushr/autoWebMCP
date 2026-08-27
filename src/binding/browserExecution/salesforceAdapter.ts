import type { FieldValueKind, SemanticTarget } from "./model";
import {
  accessibleName,
  normalizeLabel,
  type FieldWriteOutcome,
  type PlatformResolverAdapter,
  type ResolvedTarget
} from "./engine";

/* ------------------------------------------------------------------ *
 * Salesforce Lightning resolver adapter.
 *
 * Adds exactly what Lightning's own component library needs beyond generic
 * accessible-name matching, and nothing else. It never replaces the generic
 * engine — it augments it, and every method here may decline (return
 * `undefined`) to let the generic engine try instead.
 *
 * The known hard case is the date control. A standard Lightning date field
 * (`lightning-input type="date"`, `lightning-datepicker`) does not behave
 * like a plain `<input type="date">`:
 *
 *   - The visible, shadow-internal `<input>` often carries a *formatted
 *     display string* ("12/15/2026"), not the field's real value.
 *   - The component's actual committed value is a mirrored JS property on
 *     the custom element host (`element.value`, an LWC `@api` property),
 *     reliably readable and writable as a plain property — the same
 *     assumption the capture policy's own comment in `fieldMapping.ts`
 *     documents: the click on the host named the field; the shadow-internal
 *     change event did not.
 *
 * This adapter tries, in order: the host's mirrored `value` property, a
 * reachable native date input inside the component's shadow root, and only
 * then the calendar popover — resolved by its own accessible date labels
 * (e.g. "Tuesday, December 15, 2026"), never by which grid cell happens to
 * be in a given screen position.
 * ------------------------------------------------------------------ */

const SLDS_VALIDATION_SELECTOR = '[role="alert"], [aria-invalid="true"], .slds-has-error, .error';
const SLDS_EDIT_SURFACE_SELECTOR = '[role="dialog"], [aria-modal="true"], lightning-record-edit-form';
const DATE_PICKER_TRIGGER_SELECTOR =
  'button[aria-label*="date picker" i], button[aria-label*="calendar" i], button[title*="date picker" i]';
const DATE_PICKER_SURFACE_SELECTOR = '[role="dialog"], [role="application"], [role="grid"]';
const MONTH_NAV_MAX_CLICKS = 24;

function isCustomElement(element: Element): boolean {
  return element.tagName.includes("-");
}

/** Whether the host exposes a plain, mirrored `value` property — the LWC `@api value` contract. */
function hasMirroredValueProperty(element: Element): element is Element & { value?: unknown } {
  return isCustomElement(element) && "value" in element;
}

/**
 * A Lightning field is usually a custom element host, not a native form
 * control — `lightning-input`, `lightning-datepicker`, and similar all
 * render their real `<input>` inside a shadow root the generic engine's
 * `input, select, textarea` search never reaches by tag name alone. A host
 * counts as a field candidate when it either mirrors its own `value`
 * property or visibly wraps a native form control in its shadow root.
 */
function isPotentialFieldHost(element: Element): boolean {
  if (!isCustomElement(element)) return false;
  return hasMirroredValueProperty(element) || Boolean(element.shadowRoot?.querySelector("input, select, textarea"));
}

function nativeDateInputWithin(root: Element): HTMLInputElement | undefined {
  const shadow = root.shadowRoot;
  if (!shadow) return undefined;
  const native = shadow.querySelector('input[type="date"]');
  return native instanceof HTMLInputElement ? native : undefined;
}

function anyNativeInputWithin(root: Element): HTMLInputElement | undefined {
  const shadow = root.shadowRoot;
  if (!shadow) return undefined;
  const native = shadow.querySelector("input");
  return native instanceof HTMLInputElement ? native : undefined;
}

function writeNativeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

/** `2026-12-15` → `{ year: 2026, month: 12, day: 15 }`. Returns undefined for anything else, on purpose. */
function parseIsoDate(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

/** Matches an accessible day-cell label like "Tuesday, December 15, 2026" against a target ISO date. */
function dayLabelMatches(label: string, date: { year: number; month: number; day: number }): boolean {
  const normalized = label.toLowerCase();
  const monthName = MONTH_NAMES[date.month - 1];
  if (!normalized.includes(monthName)) return false;
  if (!normalized.includes(String(date.year))) return false;
  // The day number must appear as its own token, not inside the year (e.g. day "20" inside "2026").
  const dayPattern = new RegExp(`\\b0*${date.day}\\b(?!\\d)`);
  return dayPattern.test(normalized.replace(String(date.year), ""));
}

function currentMonthOf(surface: Element): { year: number; month: number } | undefined {
  const heading = surface.querySelector('[role="heading"], h2, h1');
  const text = heading?.textContent?.trim().toLowerCase();
  if (!text) return undefined;
  const monthIndex = MONTH_NAMES.findIndex((name) => text.includes(name));
  const yearMatch = /\d{4}/.exec(text);
  if (monthIndex === -1 || !yearMatch) return undefined;
  return { year: Number(yearMatch[0]), month: monthIndex + 1 };
}

/**
 * Opens the date picker popover, semantically navigates to the target
 * month via labelled prior/next-month controls (never a click count derived
 * from screen position), and clicks the day cell whose own accessible label
 * names the target date.
 */
function setDateViaPicker(
  resolved: ResolvedTarget,
  target: { year: number; month: number; day: number }
): FieldWriteOutcome {
  const root: ParentNode = resolved.element.ownerDocument ?? resolved.element;
  const trigger =
    resolved.element.querySelector(DATE_PICKER_TRIGGER_SELECTOR) ??
    resolved.element.parentElement?.querySelector(DATE_PICKER_TRIGGER_SELECTOR) ??
    (resolved.element.shadowRoot?.querySelector(DATE_PICKER_TRIGGER_SELECTOR) ?? null);
  if (!(trigger instanceof HTMLElement)) {
    return { ok: false, detail: "No date-picker trigger control was found near the field." };
  }
  trigger.click();

  const surface = root.querySelector(DATE_PICKER_SURFACE_SELECTOR);
  if (!surface) return { ok: false, detail: "The date-picker trigger did not open a recognizable calendar surface." };

  for (let clicks = 0; clicks < MONTH_NAV_MAX_CLICKS; clicks++) {
    const shown = currentMonthOf(surface);
    if (shown && shown.year === target.year && shown.month === target.month) break;

    const wantsLater =
      !shown || shown.year < target.year || (shown.year === target.year && shown.month < target.month);
    const navButton = surface.querySelector(
      wantsLater ? 'button[aria-label*="next month" i]' : 'button[aria-label*="previous month" i]'
    );
    if (!(navButton instanceof HTMLElement)) {
      return { ok: false, detail: "The calendar has no accessible month-navigation control." };
    }
    navButton.click();
    if (clicks === MONTH_NAV_MAX_CLICKS - 1) {
      return { ok: false, detail: "Could not reach the target month within a bounded number of navigation clicks." };
    }
  }

  const dayButtons = [...surface.querySelectorAll('td button, [role="gridcell"] button, button[aria-label]')];
  const dayButton = dayButtons.find((button) => dayLabelMatches(button.getAttribute("aria-label") ?? button.textContent ?? "", target));
  if (!(dayButton instanceof HTMLElement)) {
    return { ok: false, detail: `No day cell labelled for ${target.year}-${target.month}-${target.day} was found in the calendar.` };
  }
  dayButton.click();
  return { ok: true, detail: "Value set by selecting the labelled day in the date-picker calendar." };
}

function setDateValue(resolved: ResolvedTarget, value: string): FieldWriteOutcome {
  const element = resolved.element;

  // 1. The host's own mirrored value property — the most reliable path when
  //    the component exposes one, and the one that avoids display-format
  //    guessing entirely.
  if (hasMirroredValueProperty(element)) {
    try {
      (element as unknown as { value: string }).value = value;
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { ok: true, detail: "Value set via the component's mirrored value property." };
    } catch {
      // Falls through — some hosts expose `value` as read-only.
    }
  }

  // 2. A native `<input type="date">` reachable through the shadow root.
  const nativeDate = nativeDateInputWithin(element);
  if (nativeDate) {
    writeNativeInput(nativeDate, value);
    return { ok: true, detail: "Value set via the native date input inside the component's shadow root." };
  }

  // 3. Any native input inside the shadow root — accepts a formatted string.
  const anyNative = anyNativeInputWithin(element);
  if (anyNative) {
    const parsed = parseIsoDate(value);
    const formatted = parsed ? `${parsed.month}/${parsed.day}/${parsed.year}` : value;
    writeNativeInput(anyNative, formatted);
    return { ok: true, detail: "Value set via the shadow-internal input's formatted display value." };
  }

  // 4. The date-picker UI itself, semantically.
  const parsed = parseIsoDate(value);
  if (!parsed) return { ok: false, detail: `"${value}" is not a recognized ISO date (yyyy-mm-dd).` };
  return setDateViaPicker(resolved, parsed);
}

export function createSalesforceResolverAdapter(): PlatformResolverAdapter {
  return {
    id: "salesforce-lightning",

    /**
     * Only field-role targets get special handling here: a Lightning field
     * is typically a custom element host the generic tag-based search never
     * matches. Buttons and other actions are ordinary native elements
     * (or expose themselves as `[role="button"]`), so this declines for
     * anything else and lets the generic engine's accessible-name search
     * run, unmodified.
     */
    resolveTarget(root: ParentNode, target: SemanticTarget): ResolvedTarget | undefined {
      if (target.role !== "field") return undefined;

      const wanted = normalizeLabel(target.label);
      const candidates = [...root.querySelectorAll("*")].filter(isPotentialFieldHost);
      let matches = candidates.filter((element) => {
        const name = accessibleName(element, root);
        return name !== undefined && normalizeLabel(name) === wanted;
      });

      if (matches.length === 0 && target.applicationIdentifier) {
        matches = candidates.filter(
          (element) =>
            element.getAttribute("name") === target.applicationIdentifier ||
            element.getAttribute("id") === target.applicationIdentifier
        );
      }

      // Zero or an unresolved tie both decline rather than guess; the
      // generic engine gets a chance to try its own (also honest) search.
      if (matches.length !== 1) return undefined;
      return { element: matches[0], strategy: "salesforce-field-host" };
    },

    setFieldValue(resolved: ResolvedTarget, value: string, valueKind: FieldValueKind): FieldWriteOutcome | undefined {
      if (valueKind !== "date") return undefined;
      return setDateValue(resolved, value);
    },

    hasValidationError(root: ParentNode): boolean {
      return [...root.querySelectorAll(SLDS_VALIDATION_SELECTOR)].some((element) => {
        if (!(element instanceof HTMLElement)) return true;
        return !element.hidden;
      });
    },

    isEditStateClosed(root: ParentNode): boolean {
      return root.querySelector(SLDS_EDIT_SURFACE_SELECTOR) === null;
    },

    readFieldValue(root: ParentNode, target: SemanticTarget): string | undefined {
      // Re-resolve via the accessible name search a screen reader would use,
      // then read the same mirrored-property-first order used for writing.
      const candidates = [...root.querySelectorAll("*")].filter(
        (element) => isCustomElement(element) && accessibleName(element, root) === target.label
      );
      const element = candidates[0];
      if (!element) return undefined;

      if (hasMirroredValueProperty(element)) {
        const value = (element as unknown as { value?: unknown }).value;
        if (typeof value === "string") return value;
      }
      const nativeDate = nativeDateInputWithin(element);
      if (nativeDate) return nativeDate.value;
      const anyNative = anyNativeInputWithin(element);
      if (anyNative) return anyNative.value;
      return undefined;
    }
  };
}
