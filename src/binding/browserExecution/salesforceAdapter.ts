import type { FieldValueKind, SemanticTarget } from "./model";
import {
  accessibleName,
  isVisible,
  normalizeLabel,
  type FieldWriteOutcome,
  type PlatformResolverAdapter,
  type ResolvedTarget
} from "./engine";
import { queryComposedTree, queryComposedTreeFirst } from "./composedTree";
import type { ResolutionPolicy } from "./resolutionPolicy";

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
 * This adapter tries, in order: a reachable native date input inside the
 * component's shadow root, any other native input (writing the locale
 * display format a human would type — a live Salesforce org proved that
 * the mirrored `value` property does not always reformat a raw ISO string
 * the way a genuine `lightning-input type="date"` would, so it is tried
 * only once no native input is reachable), and only then the calendar
 * popover — resolved by its own accessible date labels (e.g. "Tuesday,
 * December 15, 2026"), never by which grid cell happens to be in a given
 * screen position.
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
function isPotentialFieldHost(element: Element, policy: ResolutionPolicy): boolean {
  if (!isCustomElement(element)) return false;
  return hasMirroredValueProperty(element) || Boolean(nativeControlWithin(element, "input, select, textarea", policy));
}

/**
 * A native control anywhere inside a component, at any depth.
 *
 * Depth matters and one level is not enough: Lightning composes components
 * out of other components, so a `lightning-input` renders a
 * `lightning-primitive-input-*`, which renders the real `<input>` — two
 * boundaries down from the host a semantic target resolves to. Looking only
 * at `host.shadowRoot` finds nothing and silently falls through to a weaker
 * strategy.
 */
function nativeControlWithin(
  host: Element,
  selector: string,
  policy: ResolutionPolicy
): HTMLInputElement | undefined {
  const shadow = host.shadowRoot;
  if (!shadow) return undefined;
  const native = queryComposedTreeFirst(shadow, selector, policy);
  return native instanceof HTMLInputElement ? native : undefined;
}

function nativeDateInputWithin(root: Element, policy: ResolutionPolicy): HTMLInputElement | undefined {
  return nativeControlWithin(root, 'input[type="date"]', policy);
}

function anyNativeInputWithin(root: Element, policy: ResolutionPolicy): HTMLInputElement | undefined {
  return nativeControlWithin(root, "input", policy);
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

function currentMonthOf(surface: Element, policy: ResolutionPolicy): { year: number; month: number } | undefined {
  const heading = queryComposedTreeFirst(surface, '[role="heading"], h2, h1', policy);
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
  target: { year: number; month: number; day: number },
  policy: ResolutionPolicy
): FieldWriteOutcome {
  const root: ParentNode = resolved.element.ownerDocument ?? resolved.element;
  // The trigger may be in the host's own subtree, inside its shadow root,
  // or a sibling in the enclosing form — one composed search covers all
  // three without three separate lookups that each miss a different case.
  const trigger =
    queryComposedTreeFirst(resolved.element, DATE_PICKER_TRIGGER_SELECTOR, policy) ??
    (resolved.element.parentElement
      ? queryComposedTreeFirst(resolved.element.parentElement, DATE_PICKER_TRIGGER_SELECTOR, policy)
      : undefined);
  if (!(trigger instanceof HTMLElement)) {
    return { ok: false, detail: "No date-picker trigger control was found near the field." };
  }
  trigger.click();

  const surface = queryComposedTreeFirst(root, DATE_PICKER_SURFACE_SELECTOR, policy);
  if (!surface) return { ok: false, detail: "The date-picker trigger did not open a recognizable calendar surface." };

  for (let clicks = 0; clicks < MONTH_NAV_MAX_CLICKS; clicks++) {
    const shown = currentMonthOf(surface, policy);
    if (shown && shown.year === target.year && shown.month === target.month) break;

    const wantsLater =
      !shown || shown.year < target.year || (shown.year === target.year && shown.month < target.month);
    const navButton = queryComposedTreeFirst(
      surface,
      wantsLater ? 'button[aria-label*="next month" i]' : 'button[aria-label*="previous month" i]',
      policy
    );
    if (!(navButton instanceof HTMLElement)) {
      return { ok: false, detail: "The calendar has no accessible month-navigation control." };
    }
    navButton.click();
    if (clicks === MONTH_NAV_MAX_CLICKS - 1) {
      return { ok: false, detail: "Could not reach the target month within a bounded number of navigation clicks." };
    }
  }

  const dayButtons = queryComposedTree(surface, 'td button, [role="gridcell"] button, button[aria-label]', policy);
  const dayButton = dayButtons.find((button) => dayLabelMatches(button.getAttribute("aria-label") ?? button.textContent ?? "", target));
  if (!(dayButton instanceof HTMLElement)) {
    return { ok: false, detail: `No day cell labelled for ${target.year}-${target.month}-${target.day} was found in the calendar.` };
  }
  dayButton.click();
  return { ok: true, detail: "Value set by selecting the labelled day in the date-picker calendar." };
}

function setDateValue(resolved: ResolvedTarget, value: string, policy: ResolutionPolicy): FieldWriteOutcome {
  const element = resolved.element;

  // 1. A native `<input type="date">` reachable through the shadow root —
  //    genuinely expects ISO, and writing to the real control a human would
  //    type into is more trustworthy than a component property whose
  //    contract we cannot see.
  const nativeDate = nativeDateInputWithin(element, policy);
  if (nativeDate) {
    writeNativeInput(nativeDate, value);
    return { ok: true, detail: "Value set via the native date input inside the component's shadow root." };
  }

  // 2. Any other native input inside the shadow root — a live Salesforce
  //    field proved this one the hard way: writing raw ISO through a
  //    mirrored `value` property landed as literal unparsed text ("Your
  //    entry does not match the allowed format 12/31/2024"), because this
  //    component's `value` setter does not do the ISO→display reformatting
  //    a genuine `lightning-input type="date"` would. Its underlying text
  //    input expects what a human would actually type — the locale display
  //    format — so that is what this strategy writes.
  const anyNative = anyNativeInputWithin(element, policy);
  if (anyNative) {
    const parsed = parseIsoDate(value);
    const formatted = parsed ? `${parsed.month}/${parsed.day}/${parsed.year}` : value;
    writeNativeInput(anyNative, formatted);
    return { ok: true, detail: "Value set via the shadow-internal input's formatted display value." };
  }

  // 3. The host's own mirrored value property — a real mechanism for
  //    components that keep their shadow root closed, but tried only after
  //    a reachable native input, per the evidence above: this path cannot
  //    be trusted to reformat what it is given.
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

  // 4. The date-picker UI itself, semantically.
  const parsed = parseIsoDate(value);
  if (!parsed) return { ok: false, detail: `"${value}" is not a recognized ISO date (yyyy-mm-dd).` };
  return setDateViaPicker(resolved, parsed, policy);
}

const EDIT_WAIT_TIMEOUT_MS = 5_000;
const EDIT_WAIT_POLL_MS = 100;

/**
 * Whether an edit surface is genuinely open right now — present in the DOM
 * *and visible*. Presence alone is not enough: Lightning, like most UI
 * frameworks, pre-renders dialog containers and keeps them hidden until
 * triggered, so an unrelated hidden dialog elsewhere on a plain record-view
 * page can otherwise look identical to a real open edit form. Shadow-
 * piercing, since a hidden dialog belonging to some other component is not
 * guaranteed to be in the light DOM either.
 */
function isEditSurfacePresent(root: ParentNode, policy: ResolutionPolicy): boolean {
  return queryComposedTree(root, SLDS_EDIT_SURFACE_SELECTOR, policy).some(isVisible);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens the record's edit surface if it is not already open, by finding and
 * clicking an accessible "Edit" control — never a fixed screen position —
 * then polling for the edit surface to actually appear. Not a data write:
 * this only changes which form is showing, which is why it is safe to run
 * automatically as part of an already-confirmed execution, without asking
 * for a second approval to do it.
 */
async function ensureSalesforceEditable(root: ParentNode, policy: ResolutionPolicy): Promise<boolean> {
  if (isEditSurfacePresent(root, policy)) return true;

  const editButton = queryComposedTree(root, 'button, [role="button"], a', policy)
    .filter(isVisible)
    .find((element) => normalizeLabel(accessibleName(element) ?? "") === "edit");
  if (!(editButton instanceof HTMLElement)) return false;
  editButton.click();

  const deadline = Date.now() + EDIT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isEditSurfacePresent(root, policy)) return true;
    await sleep(EDIT_WAIT_POLL_MS);
  }
  return false;
}

/**
 * The one place a Lightning field host is located, shared by resolution and
 * read-back so the two can never disagree about which element a semantic
 * target means. Narrows by the platform's declared identity priority —
 * for Lightning that is the application identifier first, because a
 * capture recorded `name="CloseDate"` straight from the application and
 * that is stronger evidence than any visible label.
 */
function findFieldHost(
  root: ParentNode,
  target: SemanticTarget,
  policy: ResolutionPolicy
): Element | undefined {
  const candidates = queryComposedTree(root, "*", policy).filter((element) =>
    isPotentialFieldHost(element, policy)
  );

  for (const signal of policy.identityPriority) {
    let narrowed: Element[] | undefined;
    if (signal === "applicationIdentifier" && target.applicationIdentifier) {
      const identifier = target.applicationIdentifier;
      narrowed = candidates.filter(
        (element) =>
          element.getAttribute("name") === identifier || element.getAttribute("id") === identifier
      );
    } else if (signal === "accessibleName") {
      const wanted = normalizeLabel(target.label);
      narrowed = candidates.filter((element) => {
        const name = accessibleName(element);
        return name !== undefined && normalizeLabel(name) === wanted;
      });
    }
    if (narrowed?.length === 1) return narrowed[0];
  }
  return undefined;
}

export function createSalesforceResolverAdapter(): PlatformResolverAdapter {
  return {
    id: "salesforce-lightning",

    ensureEditable(root: ParentNode, policy: ResolutionPolicy): Promise<boolean> {
      return ensureSalesforceEditable(root, policy);
    },

    /**
     * Only field-role targets get special handling here: a Lightning field
     * is typically a custom element host the generic tag-based search never
     * matches. Buttons and other actions are ordinary native elements
     * (or expose themselves as `[role="button"]`), so this declines for
     * anything else and lets the generic engine's accessible-name search
     * run, unmodified.
     */
    resolveTarget(root: ParentNode, target: SemanticTarget, policy: ResolutionPolicy): ResolvedTarget | undefined {
      if (target.role !== "field") return undefined;
      const match = findFieldHost(root, target, policy);
      // Zero or an unresolved tie both decline rather than guess; the
      // generic engine gets a chance to try its own (also honest) search.
      return match ? { element: match, strategy: "salesforce-field-host" } : undefined;
    },

    setFieldValue(
      resolved: ResolvedTarget,
      value: string,
      valueKind: FieldValueKind,
      policy: ResolutionPolicy
    ): FieldWriteOutcome | undefined {
      if (valueKind !== "date") return undefined;
      return setDateValue(resolved, value, policy);
    },

    hasValidationError(root: ParentNode, policy: ResolutionPolicy): boolean {
      return queryComposedTree(root, SLDS_VALIDATION_SELECTOR, policy).some(isVisible);
    },

    isEditStateClosed(root: ParentNode, policy: ResolutionPolicy): boolean {
      return !isEditSurfacePresent(root, policy);
    },

    readFieldValue(root: ParentNode, target: SemanticTarget, policy: ResolutionPolicy): string | undefined {
      // Re-resolved through the very same field-host search that wrote the
      // value, then read back in the same native-input-first order, so a
      // value is never read from a different source than the one written.
      const element = findFieldHost(root, target, policy);
      if (!element) return undefined;

      const nativeDate = nativeDateInputWithin(element, policy);
      if (nativeDate) return nativeDate.value;
      const anyNative = anyNativeInputWithin(element, policy);
      if (anyNative) return anyNative.value;
      if (hasMirroredValueProperty(element)) {
        const value = (element as unknown as { value?: unknown }).value;
        if (typeof value === "string") return value;
      }
      return undefined;
    }
  };
}
