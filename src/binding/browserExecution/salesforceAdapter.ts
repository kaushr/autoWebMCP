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
import {
  DEFAULT_PAGE_STATE_POLICY,
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
const COMBOBOX_TRIGGER_SELECTOR =
  '[role="combobox"], button[aria-haspopup="listbox"], input[aria-haspopup="listbox"]';
const LISTBOX_SELECTOR = '[role="listbox"]';
const OPTION_SELECTOR = '[role="option"]';

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
  return (
    hasMirroredValueProperty(element) ||
    Boolean(nativeControlWithin(element, "input, select, textarea", policy)) ||
    // A picklist host may contain neither: its control is a combobox
    // trigger and a listbox, which is a control by ARIA rather than by tag.
    // Without this, a Lightning picklist is not even a candidate field.
    Boolean(controlWithin(element, COMBOBOX_TRIGGER_SELECTOR, policy))
  );
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

/**
 * Any control inside the host's shadow root, native or not.
 *
 * Distinct from `nativeControlWithin`, which deliberately returns only a
 * real `<input>`: a picklist's control is a `<button role="combobox">`,
 * which is a control by ARIA and not by tag.
 */
function controlWithin(host: Element, selector: string, policy: ResolutionPolicy): Element | undefined {
  const shadow = host.shadowRoot;
  if (!shadow) return undefined;
  return queryComposedTreeFirst(shadow, selector, policy);
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

/** The option's own accessible name, as a human reads it in the list. */
function optionLabel(option: Element): string {
  return (accessibleName(option) ?? option.textContent ?? "").trim();
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
  if (host.matches(COMBOBOX_TRIGGER_SELECTOR)) return host;
  return queryComposedTreeFirst(host, COMBOBOX_TRIGGER_SELECTOR, policy);
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
function setPicklistValue(resolved: ResolvedTarget, value: string, policy: ResolutionPolicy): FieldWriteOutcome {
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

  const options = queryComposedTree(listbox, OPTION_SELECTOR, policy).filter(isVisible);
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

  const shown = readComboboxDisplayValue(host, policy);
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
function readPicklistOptions(host: Element, policy: ResolutionPolicy): string[] | undefined {
  const root: ParentNode = host.ownerDocument ?? host;
  const trigger = comboboxTriggerFor(host, policy);
  if (!(trigger instanceof HTMLElement)) return undefined;

  const alreadyOpen = trigger.getAttribute("aria-expanded") === "true";
  if (!alreadyOpen) trigger.click();

  const listbox =
    queryComposedTreeFirst(host, LISTBOX_SELECTOR, policy) ?? queryComposedTreeFirst(root, LISTBOX_SELECTOR, policy);
  const labels = listbox
    ? [
        ...new Set(
          queryComposedTree(listbox, OPTION_SELECTOR, policy)
            .filter(isVisible)
            .map(optionLabel)
            .filter((label): label is string => Boolean(label))
        )
      ]
    : undefined;

  // Leave the control as it was found. Escape is how a human dismisses this
  // popup, and it selects nothing.
  if (!alreadyOpen) {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (trigger.getAttribute("aria-expanded") === "true") trigger.click();
  }
  return labels && labels.length > 0 ? labels : undefined;
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

/* --------------------------- page state ----------------------------- *
 * "A visible dialog exists" is not a page state. A live Lightning record
 * page carried visible dialog-role surfaces (docked utility bar, panels)
 * while sitting in plain read-only view, and reading any of them as "the
 * record is being edited" skipped the Edit click entirely. What actually
 * establishes record-edit here comes from the Salesforce pack's
 * `sf-record-edit-surface-semantics` entry, compiled into the
 * `PageStatePolicy` this adapter is constructed with.
 * -------------------------------------------------------------------- */

const DIALOG_SURFACE_SELECTOR = '[role="dialog"], [aria-modal="true"]';
const EDITABLE_FIELD_SELECTOR =
  'input:not([type="hidden"]), select, textarea, [role="textbox"], [contenteditable="true"]';
const SURFACE_ACTION_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"]';

/** Composed-tree containment: walks parents, hopping from a shadow root to its host. */
function composedContains(ancestor: Element, node: Element): boolean {
  let current: Element | null = node;
  let hops = 0;
  while (current && hops < 60) {
    if (current === ancestor) return true;
    if (current.parentElement) current = current.parentElement;
    else {
      const treeRoot = current.getRootNode();
      current = treeRoot instanceof ShadowRoot ? treeRoot.host : null;
    }
    hops++;
  }
  return false;
}

/**
 * Editable record fields inside a surface, counted as *field units*: a
 * component host that owns a value counts once, and native controls are
 * counted only when no counted host already contains them — otherwise one
 * `lightning-input` wrapping one `<input>` would count as two fields and a
 * lone search box would satisfy a multiple-fields threshold by itself.
 */
function countEditableFields(surface: Element, resolution: ResolutionPolicy): number {
  const allHosts = queryComposedTree(surface, "*", resolution).filter(
    (element) => isVisible(element) && isPotentialFieldHost(element, resolution)
  );
  const topHosts = allHosts.filter(
    (host) => !allHosts.some((other) => other !== host && composedContains(other, host))
  );
  const natives = queryComposedTree(surface, EDITABLE_FIELD_SELECTOR, resolution)
    .filter(isVisible)
    .filter((native) => !topHosts.some((host) => composedContains(host, native)));
  return topHosts.length + natives.length;
}

function surfaceHasActionLabelled(
  surface: Element,
  labels: readonly string[],
  resolution: ResolutionPolicy
): boolean {
  const wanted = new Set(labels.map((label) => label.toLowerCase()));
  return queryComposedTree(surface, SURFACE_ACTION_SELECTOR, resolution)
    .filter(isVisible)
    .some((action) => wanted.has(normalizeLabel(accessibleName(action) ?? "")));
}

function editComponentEvidenceIn(
  surface: Element,
  pageState: PageStatePolicy,
  resolution: ResolutionPolicy
): string[] {
  if (pageState.editSurfaceComponents.length === 0) return [];
  const tags = new Set(pageState.editSurfaceComponents.map((tag) => tag.toLowerCase()));
  const found = new Set<string>();
  if (tags.has(surface.tagName.toLowerCase())) found.add(surface.tagName.toLowerCase());
  for (const descendant of queryComposedTree(surface, pageState.editSurfaceComponents.join(", "), resolution)) {
    found.add(descendant.tagName.toLowerCase());
  }
  return [...found];
}

function findEditAction(root: ParentNode, resolution: ResolutionPolicy): HTMLElement | undefined {
  const action = queryComposedTree(root, 'button, [role="button"], a', resolution)
    .filter(isVisible)
    .find((element) => normalizeLabel(accessibleName(element) ?? "") === "edit");
  return action instanceof HTMLElement ? action : undefined;
}

/**
 * Classifies the page: `record-edit` only on the pack's evidence — the
 * platform's record-edit component, or a surface holding at least the
 * declared minimum of editable fields together with a commit action.
 * `record-view` when nothing qualifies but an Edit action is offered
 * (which is what a view page does); `unknown` otherwise. A generic dialog
 * alone never qualifies, no matter how visible.
 */
function assessSalesforcePageState(
  root: ParentNode,
  resolution: ResolutionPolicy,
  pageState: PageStatePolicy
): PageStateAssessment {
  const surfaceSelector =
    pageState.editSurfaceComponents.length > 0
      ? `${DIALOG_SURFACE_SELECTOR}, ${pageState.editSurfaceComponents.join(", ")}`
      : DIALOG_SURFACE_SELECTOR;
  const allSurfaces = queryComposedTree(root, surfaceSelector, resolution).filter(isVisible);
  // Nested dialog markers (a modal that is also aria-modal, wrappers inside
  // wrappers) describe one surface, not several.
  const surfaces = allSurfaces.filter(
    (surface) => !allSurfaces.some((other) => other !== surface && composedContains(other, surface))
  );

  let best: PageStateEvidence = {
    editableFieldCount: 0,
    commitActionFound: false,
    dismissActionFound: false,
    editComponentEvidence: [],
    unrelatedDialogsIgnored: surfaces.length
  };
  for (const surface of surfaces) {
    const evidence: PageStateEvidence = {
      editableFieldCount: countEditableFields(surface, resolution),
      commitActionFound: surfaceHasActionLabelled(surface, pageState.commitActionLabels, resolution),
      dismissActionFound: surfaceHasActionLabelled(surface, pageState.dismissActionLabels, resolution),
      editComponentEvidence: editComponentEvidenceIn(surface, pageState, resolution),
      unrelatedDialogsIgnored: surfaces.length - 1
    };
    const qualifies =
      evidence.editComponentEvidence.length > 0 ||
      (evidence.editableFieldCount >= pageState.minimumEditableFields && evidence.commitActionFound);
    if (qualifies) return { state: "record-edit", surface, evidence };
    if (evidence.editableFieldCount > best.editableFieldCount) best = evidence;
  }

  const state: PageState = findEditAction(root, resolution) ? "record-view" : "unknown";
  return { state, evidence: best };
}

function describeEvidence(evidence: PageStateEvidence): string {
  return (
    `editable fields found: ${evidence.editableFieldCount}, ` +
    `Save action found: ${evidence.commitActionFound ? "yes" : "no"}, ` +
    `Cancel action found: ${evidence.dismissActionFound ? "yes" : "no"}, ` +
    `record-edit component evidence: ${
      evidence.editComponentEvidence.length ? evidence.editComponentEvidence.join(", ") : "none"
    }, ` +
    `unrelated dialogs ignored: ${evidence.unrelatedDialogsIgnored}`
  );
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
  pageState: PageStatePolicy
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

  const deadline = Date.now() + EDIT_WAIT_TIMEOUT_MS;
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
        .replace(new RegExp(`edit\\s+${labelText.replace(/^\\*/, "")}`, "i"), "")
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

export function createSalesforceResolverAdapter(
  pageState: PageStatePolicy = DEFAULT_PAGE_STATE_POLICY,
  verification: VerificationPolicy = DEFAULT_VERIFICATION_POLICY
): PlatformResolverAdapter {
  return {
    id: "salesforce-lightning",

    ensureEditable(root: ParentNode, policy: ResolutionPolicy): Promise<EditableTransition> {
      return ensureSalesforceEditable(root, policy, pageState);
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
      if (valueKind === "date") return setDateValue(resolved, value, policy);
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

    readFieldOptions(root: ParentNode, target: SemanticTarget, policy: ResolutionPolicy): string[] | undefined {
      const element = findFieldHost(root, target, policy) ?? resolveFieldElement(root, target, policy);
      return element ? readPicklistOptions(element, policy) : undefined;
    },

    readFieldValue(root: ParentNode, target: SemanticTarget, policy: ResolutionPolicy): string | undefined {
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
