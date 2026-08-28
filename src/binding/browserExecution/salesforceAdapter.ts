import type { FieldValueKind, SemanticTarget } from "./model";
import {
  accessibleName,
  isVisible,
  normalizeLabel,
  waitForApplicationReaction,
  type FieldWriteOutcome,
  type OptionReadOutcome,
  type PlatformResolverAdapter,
  type ResolvedTarget
} from "./engine";
import {
  COMBOBOX_TRIGGER_SELECTOR,
  composedContains,
  composedMatchWithin,
  hasMirroredValueProperty,
  isPotentialFieldHost,
  nativeControlWithin,
  queryComposedTree,
  queryComposedTreeFirst
} from "./composedTree";
import { observeSurfaces, type SurfaceObservation } from "./surfaceObservation";
import type { ResolutionPolicy } from "./resolutionPolicy";
import {
  DEFAULT_PAGE_STATE_POLICY,
  type EditRestoration,
  type EditableTransition,
  type PageState,
  type PageStateAssessment,
  type PageStateEvidence,
  type PageStatePolicy
} from "./pageState";
import {
  DEFAULT_VERIFICATION_POLICY,
  type ValidationAssessment,
  type VerificationPolicy
} from "./verificationPolicy";

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
const DATE_PICKER_TRIGGER_SELECTOR =
  'button[aria-label*="date picker" i], button[aria-label*="calendar" i], button[title*="date picker" i]';
const DATE_PICKER_SURFACE_SELECTOR = '[role="dialog"], [role="application"], [role="grid"]';
const MONTH_NAV_MAX_CLICKS = 24;

/* --------------------------- picklist controls --------------------------- */

/**
 * A Lightning picklist is not a `<select>`. It renders as a combobox
 * trigger plus a listbox of option elements, all inside nested shadow
 * roots, and a live capture of a Stage change exposed no `name` on any
 * event it produced.
 *
 * Everything below is ARIA: `role="combobox"`, `role="listbox"`,
 * `role="option"`, and the option's own accessible name. That is the same
 * contract a screen-reader user relies on, which is exactly why it is
 * allowed here — no recorded selector, no XPath, no coordinate, and no
 * position-in-list assumption. Options are re-resolved live on every
 * execution.
 */
// COMBOBOX_TRIGGER_SELECTOR now lives in composedTree.ts — the ARIA
// combobox pattern itself, not a Salesforce identity.
const LISTBOX_SELECTOR = '[role="listbox"]';
/** How long to let a picklist settle after a choice before reading it back. */
const SELECTION_QUIET_MS = 40;
const SELECTION_TIMEOUT_MS = 2_000;
const SELECTION_POLL_MS = 40;
const OPTION_SELECTOR = '[role="option"]';

// isCustomElement, hasMirroredValueProperty, isPotentialFieldHost,
// nativeControlWithin, and controlWithin now live in composedTree.ts —
// they were never Salesforce-specific, and generic surface observation
// (surfaceObservation.ts) needs to count fields exactly the way execution's
// own field resolution does, using the same function, not a second
// definition of "editable field" that could silently drift from this one.

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

/** A required field's label carries a leading asterisk; the value never does. */
function stripRequiredMarker(label: string): string {
  return label.replace(/^\*/, "").trim();
}

/**
 * A label used inside a constructed pattern must be escaped.
 *
 * Without this, a required field — whose label begins with `*` — built an
 * invalid expression and threw, which took down record-view read-back for
 * exactly the fields most likely to be verified.
 */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The option's own label, as a human reads it in the list.
 *
 * Whitespace-collapsed, because a live picklist produced
 * `"stage completeEngage"` — a run-together blob from an element whose
 * `textContent` swept up a label and several sibling options. That string
 * then travelled all the way into an execution request as if it were a
 * business value.
 */
function optionLabel(option: Element): string {
  const aria = option.getAttribute("aria-label")?.trim();
  if (aria) return aria.replace(/\s+/g, " ");
  // Deliberately NOT the generic accessible name. That computation falls
  // back to an ancestor `<label>`, which describes the FIELD — so an option
  // rendered inside the field's label inherits it. The live capture
  // recorded exactly that: a `lightning-base-combobox-item` whose label
  // came back as "*Stage", and the same inheritance turns a wrapper's text
  // into "stage completeEngage". An option's name is its own content.
  return (option.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The options a listbox actually offers, as opposed to every element
 * carrying the option role.
 *
 * A container that itself claims `role="option"` while holding more
 * options is not something a human can choose; reading its text yields the
 * concatenation of everything beneath it. Selectability is therefore
 * checked structurally — an option that contains another option is a
 * wrapper — rather than by trusting the role attribute alone.
 */
function selectableOptions(listbox: Element, policy: ResolutionPolicy): Element[] {
  const all = queryComposedTree(listbox, OPTION_SELECTOR, policy).filter(isVisible);
  return all.filter((option) => !all.some((other) => other !== option && composedContains(option, other)));
}

/**
 * Whether a discovered domain is structurally believable.
 *
 * The last line of defence for the same defect: if extraction still
 * produced a value that reads as several other values run together, the
 * whole domain is suspect, and presenting it as a set of choices would
 * hand the user a business value the application never offered. Better to
 * report the domain as unresolved than to be confidently wrong about it.
 */
export function suspiciousDomain(values: readonly string[]): string | undefined {
  const clean = values.map((value) => value.trim()).filter(Boolean);
  if (clean.length !== values.length) return "some options had no readable label";

  for (const value of clean) {
    const contained = clean.filter((other) => other !== value && value.toLowerCase().includes(other.toLowerCase()));
    // Containing one other option is ordinary ("Closed Won" inside "Closed
    // Won - Renewal"). Containing two or more is a concatenation.
    if (contained.length >= 2) {
      return `"${value}" appears to be several options run together (${contained.join(", ")})`;
    }
  }
  return undefined;
}

/**
 * The combobox trigger for a resolved field.
 *
 * The resolved element may BE the trigger rather than contain one: a
 * Lightning picklist's control is a plain `<button role="combobox">`, and
 * the generic field search resolves it directly. A composed-tree query
 * only ever looks at descendants, so without this the field would resolve
 * successfully and then report having no combobox inside it.
 */
function comboboxTriggerFor(host: Element, policy: ResolutionPolicy): Element | undefined {
  return composedMatchWithin(host, COMBOBOX_TRIGGER_SELECTOR, policy);
}

/** What the combobox currently displays, for read-back after selecting. */
function readComboboxDisplayValue(host: Element, policy: ResolutionPolicy): string | undefined {
  const trigger = comboboxTriggerFor(host, policy);
  if (!trigger) return undefined;
  if (trigger instanceof HTMLInputElement) return trigger.value || undefined;
  const text = (trigger.textContent ?? "").trim();
  return text || undefined;
}

/**
 * Selects a picklist value by the option's visible name.
 *
 * Opens the combobox, finds the one option whose accessible name matches,
 * and activates it. An option that is not offered is a refusal, not a
 * near-miss to force: the list the application is currently rendering is
 * the authority on what is legal for this record right now, which may be
 * narrower than any metadata said.
 */
async function setPicklistValue(
  resolved: ResolvedTarget,
  value: string,
  policy: ResolutionPolicy
): Promise<FieldWriteOutcome> {
  const host = resolved.element;
  const root: ParentNode = host.ownerDocument ?? host;

  const trigger = comboboxTriggerFor(host, policy);
  if (!(trigger instanceof HTMLElement)) {
    return { ok: false, detail: "No combobox control was found for this field." };
  }
  trigger.click();

  // The listbox is often portalled out of the field's own subtree, so a
  // miss inside the host is not a failure until the document also has none.
  const listbox =
    queryComposedTreeFirst(host, LISTBOX_SELECTOR, policy) ?? queryComposedTreeFirst(root, LISTBOX_SELECTOR, policy);
  if (!listbox) {
    return { ok: false, detail: "Activating the combobox did not open a recognizable option list." };
  }

  const options = selectableOptions(listbox, policy);
  const wanted = normalizeLabel(value);
  const matches = options.filter((option) => normalizeLabel(optionLabel(option)) === wanted);

  if (matches.length === 0) {
    // The live list is the authority on what is legal for this record right
    // now, whatever any metadata claimed. A near miss is not coerced: a
    // business value is either offered or it is not.
    const offered = options.map(optionLabel).filter(Boolean);
    return {
      ok: false,
      detail:
        `The option "${value}" is not currently offered by this picklist.` +
        (offered.length > 0 ? ` Offered values: ${offered.join(", ")}.` : "")
    };
  }
  if (matches.length > 1) {
    return { ok: false, detail: `Several options are labelled "${value}"; a unique choice could not be made.` };
  }
  if (!(matches[0] instanceof HTMLElement)) {
    return { ok: false, detail: `The option "${value}" is not activatable.` };
  }
  matches[0].click();

  // Lightning repaints the control asynchronously, so reading it back in
  // the same tick reports the value it had a moment ago — a live run failed
  // exactly that way, reporting "still shows Collaborate" after a correct
  // selection.
  //
  // The document-level application-reaction primitive is not enough on its
  // own here: a MutationObserver watching the document does not see
  // mutations inside a shadow root, and this component repaints inside two.
  // So the value is re-read until it settles, exactly as `ensureEditable`
  // polls for its page state. This is a bounded wait for an observable
  // condition, not a fixed sleep: it returns the instant the value appears.
  await waitForApplicationReaction({
    root: host.ownerDocument ?? host,
    quietMs: SELECTION_QUIET_MS,
    timeoutMs: SELECTION_TIMEOUT_MS
  });

  const deadline = Date.now() + SELECTION_TIMEOUT_MS;
  let shown = readComboboxDisplayValue(host, policy);
  while (shown !== undefined && normalizeLabel(shown) !== wanted && Date.now() < deadline) {
    await sleep(SELECTION_POLL_MS);
    shown = readComboboxDisplayValue(host, policy);
  }
  if (shown && normalizeLabel(shown) !== wanted) {
    return { ok: false, detail: `The picklist still shows "${shown}" after selecting "${value}".` };
  }
  return {
    ok: true,
    detail: shown
      ? `Selected the option labelled "${value}"; the picklist now shows "${shown}".`
      : `Selected the option labelled "${value}".`
  };
}

/**
 * Reads the values a picklist is currently offering, and changes nothing.
 *
 * The live control is the most accurate source there is for what is legal
 * *now*: record type, dependent picklists, and field-level permissions all
 * narrow the set in ways no static snapshot captures. Asking the
 * application is therefore better than asking a person, and far better
 * than pretending an unknown domain means an unconstrained one.
 *
 * Read-only by construction: it opens the popup, reads accessible names,
 * and dismisses it. No option is activated, no value is written, and
 * nothing is committed.
 */
function readPicklistOptions(host: Element, policy: ResolutionPolicy): OptionReadOutcome {
  const root: ParentNode = host.ownerDocument ?? host;
  const trigger = comboboxTriggerFor(host, policy);
  if (!(trigger instanceof HTMLElement)) {
    return {
      openedByUs: false,
      dismissAttempted: false,
      dismissProven: true,
      detail: "No combobox control was found for this field."
    };
  }

  const wasOpen = isComboboxOpen(trigger, root, policy);
  let openedByUs = false;
  try {
    if (!wasOpen) {
      trigger.click();
      openedByUs = true;
    }

    const listbox =
      queryComposedTreeFirst(host, LISTBOX_SELECTOR, policy) ?? queryComposedTreeFirst(root, LISTBOX_SELECTOR, policy);
    // Canonical label first, then dedupe: two spellings of the same
    // whitespace are one option, not two.
    const labels = listbox
      ? [...new Set(selectableOptions(listbox, policy).map(optionLabel).filter(Boolean))]
      : [];
    const suspicious = labels.length > 0 ? suspiciousDomain(labels) : undefined;

    return {
      ...(labels.length > 0 && !suspicious ? { options: labels } : {}),
      openedByUs,
      // Whatever happened above, a control WE opened must be put back.
      ...dismissCombobox(trigger, root, policy, openedByUs),
      detail: suspicious
        ? `The values read from this control do not look like a list of choices: ${suspicious}.`
        : labels.length > 0
          ? `Read ${labels.length} offered values.`
          : "The control opened but offered no readable values."
    };
  } catch (error) {
    // A read that throws still owns whatever it opened.
    return {
      openedByUs,
      ...dismissCombobox(trigger, root, policy, openedByUs),
      detail: `Reading the offered values failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** Whether the popup is currently showing, by the control's own ARIA state or a visible listbox. */
function isComboboxOpen(trigger: Element, root: ParentNode, policy: ResolutionPolicy): boolean {
  if (trigger.getAttribute("aria-expanded") === "true") return true;
  const listbox = queryComposedTreeFirst(root, LISTBOX_SELECTOR, policy);
  return Boolean(listbox && isVisible(listbox));
}

/**
 * Closes a popup this operation opened, and proves it closed.
 *
 * Escape is how a human dismisses this control and selects nothing, which
 * is exactly the property that matters: dismissal must never be achieved
 * by choosing an option. A second activation of the trigger is the
 * fallback, and it is a toggle, not a selection.
 */
function dismissCombobox(
  trigger: HTMLElement,
  root: ParentNode,
  policy: ResolutionPolicy,
  openedByUs: boolean
): Pick<OptionReadOutcome, "dismissAttempted" | "dismissProven"> {
  // A control the user already had open is theirs; leaving it as found is
  // the correct restoration.
  if (!openedByUs) return { dismissAttempted: false, dismissProven: true };

  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (isComboboxOpen(trigger, root, policy)) trigger.click();
  return { dismissAttempted: true, dismissProven: !isComboboxOpen(trigger, root, policy) };
}

/**
 * Leaves record-edit mode the way a human would: by activating the
 * platform's own dismiss action, resolved semantically from the labels the
 * pack declares, and then proving the page actually returned to
 * record-view rather than assuming the click worked.
 *
 * Only ever invoked for an edit transition AutoWebMCP itself caused.
 */
async function restoreSalesforceRecordView(
  root: ParentNode,
  resolution: ResolutionPolicy,
  pageState: PageStatePolicy,
  timeoutMs = EDIT_WAIT_TIMEOUT_MS
): Promise<EditRestoration> {
  const diagnostics: string[] = [];
  const dismiss = findActionLabelled(root, pageState.dismissActionLabels, resolution);
  diagnostics.push(`Dismiss action resolved: ${dismiss ? "yes" : "no"}`);
  if (!dismiss) {
    const state = assessSalesforcePageState(root, resolution, pageState).state;
    diagnostics.push(`Final Salesforce page state: ${state}`);
    return {
      ok: state !== "record-edit",
      dismissActionResolved: false,
      dismissActionInvoked: false,
      finalState: state,
      diagnostics
    };
  }

  dismiss.click();
  diagnostics.push("Dismiss action invoked: yes");

  const deadline = Date.now() + timeoutMs;
  let state = assessSalesforcePageState(root, resolution, pageState).state;
  while (state === "record-edit" && Date.now() < deadline) {
    await sleep(EDIT_WAIT_POLL_MS);
    state = assessSalesforcePageState(root, resolution, pageState).state;
  }
  diagnostics.push(`Final Salesforce page state: ${state}`);
  return {
    ok: state !== "record-edit",
    dismissActionResolved: true,
    dismissActionInvoked: true,
    finalState: state,
    diagnostics
  };
}

/** The visible action carrying one of these accessible names, e.g. the pack's dismiss labels. */
function findActionLabelled(
  root: ParentNode,
  labels: readonly string[],
  resolution: ResolutionPolicy
): HTMLElement | undefined {
  const wanted = new Set(labels.map((label) => label.toLowerCase()));
  const action = queryComposedTree(root, SURFACE_ACTION_SELECTOR, resolution)
    .filter(isVisible)
    .find((element) => wanted.has(normalizeLabel(accessibleName(element) ?? "")));
  return action instanceof HTMLElement ? action : undefined;
}

/**
 * Describes what a resolved element actually is, for a failure that has to
 * be diagnosable without another live run.
 *
 * A live regression reported only "No date-picker trigger control was
 * found near the field" — true, and useless: it named the last strategy
 * rather than saying which element had been resolved or why the three
 * earlier strategies declined.
 */
function describeResolvedTarget(resolved: ResolvedTarget, policy: ResolutionPolicy): string {
  const element = resolved.element;
  const nativeAnywhere = composedMatchWithin(element, "input, select, textarea", policy);
  return [
    `resolved <${element.tagName.toLowerCase()}> via ${resolved.strategy}`,
    `accessible name ${JSON.stringify(accessibleName(element) ?? null)}`,
    `application identifier ${JSON.stringify(element.getAttribute("name") ?? element.getAttribute("id") ?? null)}`,
    `own shadow root: ${element.shadowRoot ? "yes" : "no"}`,
    `native input in composed subtree: ${nativeAnywhere ? `<${nativeAnywhere.tagName.toLowerCase()}>` : "none"}`
  ].join("; ");
}

function setDateValue(resolved: ResolvedTarget, value: string, policy: ResolutionPolicy): FieldWriteOutcome {
  const element = resolved.element;
  // Each strategy records why it declined, so a failure explains the whole
  // chain rather than only its last link.
  const attempts: string[] = [];

  // 1. A native `<input type="date">` reachable through the shadow root —
  //    genuinely expects ISO, and writing to the real control a human would
  //    type into is more trustworthy than a component property whose
  //    contract we cannot see.
  const nativeDate = nativeDateInputWithin(element, policy);
  if (nativeDate) {
    writeNativeInput(nativeDate, value);
    return { ok: true, detail: "Value set via the native date input in the field's composed subtree." };
  }
  attempts.push("native date input: none found in the composed subtree");

  // 2. Any other native input inside the shadow root — a live Salesforce
  //    field proved this one the hard way: writing raw ISO through a
  //    mirrored `value` property landed as literal unparsed text ("Your
  //    entry does not match the allowed format 12/31/2024"), because this
  //    component's `value` setter does not do the ISO→display reformatting
  //    a genuine `lightning-input type="date"` would. Its underlying text
  //    input expects what a human would actually type — the locale display
  //    format — so that is what this strategy writes.
  const anyNative = anyNativeInputWithin(element, policy);
  if (!anyNative) attempts.push("any native input: none found in the composed subtree");
  if (anyNative) {
    const parsed = parseIsoDate(value);
    const formatted = parsed ? `${parsed.month}/${parsed.day}/${parsed.year}` : value;
    writeNativeInput(anyNative, formatted);
    return { ok: true, detail: "Value set via the field's own text input, in the display format it expects." };
  }

  // 3. The host's own mirrored value property — a real mechanism for
  //    components that keep their shadow root closed, but tried only after
  //    a reachable native input, per the evidence above: this path cannot
  //    be trusted to reformat what it is given.
  if (!hasMirroredValueProperty(element)) attempts.push("mirrored value property: not exposed by the resolved element");
  if (hasMirroredValueProperty(element)) {
    try {
      (element as unknown as { value: string }).value = value;
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { ok: true, detail: "Value set via the component's mirrored value property." };
    } catch {
      attempts.push("mirrored value property: present but read-only");
    }
  }

  // 4. The date-picker UI itself, semantically.
  const parsed = parseIsoDate(value);
  if (!parsed) return { ok: false, detail: `"${value}" is not a recognized ISO date (yyyy-mm-dd).` };
  const viaPicker = setDateViaPicker(resolved, parsed, policy);
  if (viaPicker.ok) return viaPicker;
  return {
    ok: false,
    detail:
      `${viaPicker.detail} Strategies attempted — ${attempts.join("; ")}; ` +
      `date picker: ${viaPicker.detail.toLowerCase()} Target: ${describeResolvedTarget(resolved, policy)}.`
  };
}

const EDIT_WAIT_TIMEOUT_MS = 5_000;
const EDIT_WAIT_POLL_MS = 100;

/* --------------------------- page state ----------------------------- *
 * "A visible dialog exists" is not a page state. A live Lightning record
 * page carried visible dialog-role surfaces (docked utility bar, panels)
 * while sitting in plain read-only view, and reading any of them as "the
 * record is being edited" skipped the Edit click entirely.
 *
 * Candidate surfaces are now discovered generically, by `observeSurfaces`
 * (surfaceObservation.ts) — not by a hardcoded selector naming Salesforce
 * component tags. What establishes that a given candidate actually means
 * record-edit comes entirely from the Salesforce pack's `page-state-
 * semantics` entries, compiled into the `patterns` this adapter's
 * `PageStatePolicy` carries. This split — observe broadly, then let
 * declared patterns interpret — exists because the previous, selector-first
 * design discovered candidates and consulted knowledge in the wrong order:
 * a live, sixteen-field Salesforce edit form matched none of the declared
 * component tags and had no dialog role either, so it never became a
 * candidate at all, and no amount of correct knowledge could have rescued
 * it once discovery had already excluded it.
 * -------------------------------------------------------------------- */

const SURFACE_ACTION_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"]';

function findEditAction(root: ParentNode, resolution: ResolutionPolicy): HTMLElement | undefined {
  const action = queryComposedTree(root, 'button, [role="button"], a', resolution)
    .filter(isVisible)
    .find((element) => normalizeLabel(accessibleName(element) ?? "") === "edit");
  return action instanceof HTMLElement ? action : undefined;
}

/** Which of a component-identity pattern's declared tags were actually observed on this surface. */
function matchedComponentIdentities(
  componentIdentities: readonly string[],
  facts: SurfaceObservation["facts"]
): string[] {
  const wanted = new Set(componentIdentities.map((tag) => tag.toLowerCase()));
  return facts.componentIdentities.filter((tag) => wanted.has(tag));
}

/** Whether one declared pattern is satisfied by one observed surface's facts. */
function patternQualifies(
  pattern: PageStatePolicy["patterns"][number],
  facts: SurfaceObservation["facts"],
  commitActionLabels: readonly string[]
): boolean {
  if (pattern.evidence.kind === "component-identity") {
    return matchedComponentIdentities(pattern.evidence.componentIdentities, facts).length > 0;
  }
  const hasCommit = commitActionLabels.some((label) => facts.actionLabels.includes(label));
  return facts.editableFieldCount >= pattern.evidence.minimumEditableFields && hasCommit;
}

/**
 * Classifies the page: `record-edit` only when some declared pattern is
 * satisfied by an observed surface — a component identity, or a structural
 * signature the pack has earned the right to declare. `record-view` only
 * with positive evidence for it: an Edit action is offered, AND no
 * observed candidate looked edit-like without being explained. A candidate
 * with real fields and something that looks like a commit action, that
 * still satisfied no pattern, is unexplained evidence, not proof of a
 * plain view — reporting `record-view` there is exactly the false
 * negative a live run was caught making, so it now reports `unknown`
 * instead. A generic dialog alone never qualifies, no matter how visible.
 */
function assessSalesforcePageState(
  root: ParentNode,
  resolution: ResolutionPolicy,
  pageState: PageStatePolicy
): PageStateAssessment {
  const surfaces = observeSurfaces(root, resolution);

  let best: PageStateEvidence = {
    editableFieldCount: 0,
    commitActionFound: false,
    dismissActionFound: false,
    editComponentEvidence: [],
    unrelatedDialogsIgnored: surfaces.length,
    surfacesObserved: surfaces.length
  };

  for (const surface of surfaces) {
    const commitActionFound = pageState.commitActionLabels.some((label) => surface.facts.actionLabels.includes(label));
    const dismissActionFound = pageState.dismissActionLabels.some((label) => surface.facts.actionLabels.includes(label));
    const editComponentEvidence = [
      ...new Set(
        pageState.patterns
          .filter((pattern) => pattern.evidence.kind === "component-identity")
          .flatMap((pattern) =>
            pattern.evidence.kind === "component-identity"
              ? matchedComponentIdentities(pattern.evidence.componentIdentities, surface.facts)
              : []
          )
      )
    ];

    const evidence: PageStateEvidence = {
      editableFieldCount: surface.facts.editableFieldCount,
      commitActionFound,
      dismissActionFound,
      editComponentEvidence,
      unrelatedDialogsIgnored: surfaces.length - 1,
      surfacesObserved: surfaces.length,
      ...(surface.facts.expansionTrace ? { expansionTrace: surface.facts.expansionTrace } : {})
    };

    const matched = pageState.patterns.find((pattern) =>
      patternQualifies(pattern, surface.facts, pageState.commitActionLabels)
    );
    if (matched) {
      return {
        state: "record-edit",
        surface: surface.root,
        evidence: { ...evidence, matchedPattern: { id: matched.id, strength: matched.strength } }
      };
    }
    if (evidence.editableFieldCount > best.editableFieldCount) best = evidence;
  }

  // Nothing qualified. Keep a neutral summary of every observed candidate —
  // an unrelated dialog (an Aura error banner, a docked panel) is reported,
  // never silently dropped, so a failure can be diagnosed instead of
  // guessed at from an aggregate count alone.
  best = {
    ...best,
    otherSurfaces: surfaces.map((surface) => ({
      heading: surface.facts.heading,
      roles: surface.facts.roles,
      editableFieldCount: surface.facts.editableFieldCount
    }))
  };

  const state: PageState =
    best.editableFieldCount > 0 && best.commitActionFound
      ? "unknown"
      : findEditAction(root, resolution)
        ? "record-view"
        : "unknown";
  return { state, evidence: best };
}

function describeEvidence(evidence: PageStateEvidence): string {
  const base =
    `editable fields found: ${evidence.editableFieldCount}, ` +
    `Save action found: ${evidence.commitActionFound ? "yes" : "no"}, ` +
    `Cancel action found: ${evidence.dismissActionFound ? "yes" : "no"}, ` +
    `record-edit component evidence: ${
      evidence.editComponentEvidence.length ? evidence.editComponentEvidence.join(", ") : "none"
    }, ` +
    `surfaces observed: ${evidence.surfacesObserved}`;
  const pattern = evidence.matchedPattern
    ? ` — matched pattern "${evidence.matchedPattern.id}" (${evidence.matchedPattern.strength})`
    : "";
  const others =
    evidence.otherSurfaces && evidence.otherSurfaces.length > 0
      ? ` Other surfaces observed: ${evidence.otherSurfaces
          .map(
            (surface) =>
              `${surface.heading ? `"${surface.heading}"` : "(unlabelled)"} [${
                surface.roles.join(", ") || "no role"
              }], ${surface.editableFieldCount} field(s)`
          )
          .join("; ")}.`
      : "";
  const trace =
    evidence.expansionTrace && evidence.expansionTrace.length > 0
      ? ` Expansion climb from the nearest action: ${evidence.expansionTrace
          .map((step) => `${step.element} (${step.editableFieldCount})`)
          .join(" -> ")}.`
      : "";
  return `${base}${pattern}.${others}${trace}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * View → edit as a proven transition. Clicking Edit is not success; the
 * postcondition is a re-assessment that classifies the page as
 * `record-edit` under the pack's semantics. Anything less returns a failed
 * transition carrying the full diagnostic trail, so execution stops at
 * this layer instead of hunting for fields on a page that never changed.
 * Not a data write: nothing here sets a value or commits anything.
 */
async function ensureSalesforceEditable(
  root: ParentNode,
  resolution: ResolutionPolicy,
  pageState: PageStatePolicy,
  timeoutMs = EDIT_WAIT_TIMEOUT_MS
): Promise<EditableTransition> {
  const initial = assessSalesforcePageState(root, resolution, pageState);
  const diagnostics: string[] = [
    `Initial Salesforce page state: ${initial.state}`,
    `Edit-state evidence: ${describeEvidence(initial.evidence)}`
  ];

  if (initial.state === "record-edit") {
    return {
      ok: true,
      initialState: "record-edit",
      finalState: "record-edit",
      editActionResolved: false,
      editActionInvoked: false,
      diagnostics
    };
  }

  const editAction = findEditAction(root, resolution);
  diagnostics.push(`Edit action resolved: ${editAction ? "yes" : "no"}`);
  if (!editAction) {
    return {
      ok: false,
      initialState: initial.state,
      finalState: initial.state,
      editActionResolved: false,
      editActionInvoked: false,
      diagnostics
    };
  }

  editAction.click();
  diagnostics.push("Edit action invoked: yes");

  const deadline = Date.now() + timeoutMs;
  let final = initial;
  for (;;) {
    final = assessSalesforcePageState(root, resolution, pageState);
    if (final.state === "record-edit" || Date.now() >= deadline) break;
    await sleep(EDIT_WAIT_POLL_MS);
  }

  diagnostics.push(
    `Application reaction observed: ${final.state !== initial.state ? "yes" : "no"}`,
    `Resulting Salesforce page state: ${final.state}`,
    `Edit-state evidence: ${describeEvidence(final.evidence)}`
  );

  return {
    ok: final.state === "record-edit",
    initialState: initial.state,
    finalState: final.state,
    editActionResolved: true,
    editActionInvoked: true,
    diagnostics
  };
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

/**
 * Whether an element is, or sits inside, one of the platform's notification
 * components — the pack-declared identities of regions whose alerts are the
 * platform talking, not a field rejecting.
 */
function isNotificationElement(element: Element, verification: VerificationPolicy): boolean {
  const classMatch = (candidate: Element): boolean =>
    verification.notificationComponentClasses.some((className) => candidate.classList.contains(className)) ||
    verification.notificationRoles.some((role) => candidate.getAttribute("role") === role);

  let current: Element | null = element;
  let hops = 0;
  while (current && hops < 12) {
    if (classMatch(current)) return true;
    if (current.parentElement) current = current.parentElement;
    else {
      const treeRoot = current.getRootNode();
      current = treeRoot instanceof ShadowRoot ? treeRoot.host : null;
    }
    hops++;
  }
  // A notification wrapper may also be a descendant of the alert element
  // itself (an alert region containing the toast component).
  return queryComposedTree(
    element,
    verification.notificationComponentClasses.map((className) => `.${className}`).join(", ") || "__none__",
    { traversal: "composed-tree", shadowRoots: "recursive", eventRetargeting: false, identityPriority: [] }
  ).length > 0;
}

/**
 * Post-commit validation, tied to the save attempt rather than swept from
 * the whole document. The live evidence this encodes: a blocking
 * validation holds the record-edit surface open with the error inside it,
 * and Salesforce's success notification itself carries `role="alert"` — a
 * ground-truth-successful save was misreported as failed by exactly that.
 */
function assessSalesforceValidation(
  root: ParentNode,
  resolution: ResolutionPolicy,
  pageState: PageStatePolicy,
  verification: VerificationPolicy
): ValidationAssessment {
  const state = assessSalesforcePageState(root, resolution, pageState);
  const notes: string[] = [];

  if (state.state === "record-edit" && state.surface) {
    // The save attempt is still on screen: validation evidence is whatever
    // the edit surface itself shows.
    const markers = queryComposedTree(state.surface, SLDS_VALIDATION_SELECTOR, resolution)
      .filter(isVisible)
      .filter((marker) => !isNotificationElement(marker, verification));
    if (markers.length > 0) {
      notes.push(`The edit surface is still open with ${markers.length} validation marker(s) inside it.`);
      return { blocking: true, notes };
    }
    notes.push("The edit surface is open with no validation markers inside it.");
    return { blocking: false, notes };
  }

  // The edit surface has closed. Per the pack, a blocking validation would
  // have held it open — so classify what any lingering alerts actually are
  // instead of treating their existence as a verdict.
  const alerts = queryComposedTree(root, SLDS_VALIDATION_SELECTOR, resolution).filter(isVisible);
  const notifications = alerts.filter((alert) => isNotificationElement(alert, verification));
  const unexplained = alerts.filter((alert) => !isNotificationElement(alert, verification));

  if (notifications.length > 0) {
    notes.push(
      `${notifications.length} alert-role element(s) identified as platform notifications (${[
        ...new Set(notifications.map((alert) => `${alert.tagName.toLowerCase()}.${[...alert.classList].join(".")}`))
      ].join("; ")}), not validation.`
    );
  }
  if (unexplained.length > 0) {
    notes.push(
      `${unexplained.length} other alert-class element(s) visible (${[
        ...new Set(unexplained.map((alert) => alert.tagName.toLowerCase()))
      ].join(", ")}) — not treated as blocking because the edit surface closed, which a blocking validation would have prevented.`
    );
  }
  if (verification.blockingValidationHoldsEditSurfaceOpen) {
    notes.push("The record-edit surface closed, so no blocking validation was in effect.");
    return { blocking: false, notes };
  }
  return { blocking: unexplained.length > 0, notes };
}

/**
 * The value a record VIEW displays for a labelled field — read-back for a
 * save whose edit surface has closed. The label element is found by its
 * exact text; the value is the remaining text of its nearest enclosing
 * field container. Display text is presentation, not the wire format (see
 * the pack's `sf-dom-text-not-field-value`), so callers compare it
 * tolerantly and treat anything incomparable as unverifiable — never as
 * proof either way.
 */
function readRecordViewDisplayValue(
  root: ParentNode,
  target: SemanticTarget,
  resolution: ResolutionPolicy
): string | undefined {
  const wanted = normalizeLabel(target.label);
  const labelElements = queryComposedTree(root, "span, div, dt, label, p", resolution)
    .filter(isVisible)
    .filter(
      (element) =>
        element.children.length === 0 && normalizeLabel(element.textContent ?? "") === wanted
    );

  for (const labelElement of labelElements) {
    let container: Element | null = labelElement.parentElement;
    let hops = 0;
    while (container && hops < 4) {
      const labelText = (labelElement.textContent ?? "").replace(/\s+/g, " ").trim();
      const leftover = (container.textContent ?? "")
        .replace(/\s+/g, " ")
        .replace(labelText, "")
        // A record-view row carries an inline pencil control ("Edit Close
        // Date"); its text is not the field's value.
        .replace(new RegExp(`edit\\s+${escapeForRegExp(stripRequiredMarker(labelText))}`, "i"), "")
        .trim();
      if (leftover && normalizeLabel(leftover) !== wanted) return leftover;
      container = container.parentElement;
      hops++;
    }
  }
  return undefined;
}

/**
 * The control itself, when it is not wrapped in a component host — a bare
 * `<button role="combobox">` carrying the field's accessible name.
 */
function resolveFieldElement(
  root: ParentNode,
  target: SemanticTarget,
  policy: ResolutionPolicy
): Element | undefined {
  const wanted = normalizeLabel(target.label);
  const matches = queryComposedTree(root, COMBOBOX_TRIGGER_SELECTOR, policy).filter((element) => {
    const name = accessibleName(element);
    return name !== undefined && normalizeLabel(name) === wanted;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** A native control carrying the field's own accessible name or identifier. */
function resolveNativeControl(
  root: ParentNode,
  target: SemanticTarget,
  policy: ResolutionPolicy
): HTMLInputElement | HTMLTextAreaElement | undefined {
  const wanted = normalizeLabel(target.label);
  const matches = queryComposedTree(root, "input, textarea", policy).filter((element) => {
    if (target.applicationIdentifier && element.getAttribute("name") === target.applicationIdentifier) return true;
    const name = accessibleName(element);
    return name !== undefined && normalizeLabel(name) === wanted;
  });
  const only = matches.length === 1 ? matches[0] : undefined;
  return only instanceof HTMLInputElement || only instanceof HTMLTextAreaElement ? only : undefined;
}

export function createSalesforceResolverAdapter(
  pageState: PageStatePolicy = DEFAULT_PAGE_STATE_POLICY,
  verification: VerificationPolicy = DEFAULT_VERIFICATION_POLICY
): PlatformResolverAdapter {
  return {
    id: "salesforce-lightning",

    ensureEditable(root: ParentNode, policy: ResolutionPolicy, timeoutMs?: number): Promise<EditableTransition> {
      return ensureSalesforceEditable(root, policy, pageState, timeoutMs);
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
    ): FieldWriteOutcome | Promise<FieldWriteOutcome> | undefined {
      if (valueKind === "date") return setDateValue(resolved, value, policy);
      // Asynchronous by necessity: a picklist selection is only verifiable
      // once the component has settled.
      if (valueKind === "select") return setPicklistValue(resolved, value, policy);
      return undefined;
    },

    assessValidation(root: ParentNode, policy: ResolutionPolicy): ValidationAssessment {
      return assessSalesforceValidation(root, policy, pageState, verification);
    },

    isEditStateClosed(root: ParentNode, policy: ResolutionPolicy): boolean {
      // The same pack-defined semantics that establish edit mode also
      // establish leaving it: only a genuine record-edit surface counts as
      // "still open", so a leftover unrelated dialog cannot misreport an
      // unsaved form after a successful save.
      return assessSalesforcePageState(root, policy, pageState).state !== "record-edit";
    },

    readFieldOptions(root: ParentNode, target: SemanticTarget, policy: ResolutionPolicy): OptionReadOutcome {
      const element = findFieldHost(root, target, policy) ?? resolveFieldElement(root, target, policy);
      if (!element) {
        return {
          openedByUs: false,
          dismissAttempted: false,
          dismissProven: true,
          detail: `No control labelled "${target.label}" could be resolved on the page.`
        };
      }
      return readPicklistOptions(element, policy);
    },

    restoreRecordView(root: ParentNode, policy: ResolutionPolicy, timeoutMs?: number): Promise<EditRestoration> {
      return restoreSalesforceRecordView(root, policy, pageState, timeoutMs);
    },

    assessPageState(root: ParentNode, policy: ResolutionPolicy): PageStateAssessment {
      return assessSalesforcePageState(root, policy, pageState);
    },

    readFieldValue(root: ParentNode, target: SemanticTarget, policy: ResolutionPolicy): string | undefined {
      // The control may not be wrapped in a component at all. Reading has
      // the same shape problem writing had: assuming a host meant a plain
      // input carrying the field's own name could not be read back, so a
      // write into it could never be verified.
      const bare = resolveNativeControl(root, target, policy);
      if (bare) return bare.value;
      // While the edit surface is open: read through the very same
      // field-host search that wrote the value, in the same
      // native-input-first order, so a value is never read from a different
      // source than the one written.
      const element = findFieldHost(root, target, policy);
      if (element) {
        const nativeDate = nativeDateInputWithin(element, policy);
        if (nativeDate) return nativeDate.value;
        // A combobox's displayed text is the selected option's label, which
        // is what was written and therefore what must be compared. Checked
        // after the native date input, whose ISO value is more precise than
        // any display string a component renders over it.
        const combobox = readComboboxDisplayValue(element, policy);
        if (combobox) return combobox;
        const anyNative = anyNativeInputWithin(element, policy);
        if (anyNative) return anyNative.value;
        if (hasMirroredValueProperty(element)) {
          const value = (element as unknown as { value?: unknown }).value;
          if (typeof value === "string") return value;
        }
        return undefined;
      }
      // After a successful save the edit field no longer exists; the record
      // view displays the persisted value instead. Reading it there is what
      // lets a proven save become fully verified rather than stopping at
      // "read-back unavailable".
      return readRecordViewDisplayValue(root, target, policy);
    }
  };
}
