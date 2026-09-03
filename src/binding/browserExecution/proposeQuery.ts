import type { ObservationTrace } from "../../capture/normalize";
import type { SemanticCapability } from "../../semantic/model";
import { BROWSER_BINDING_SAFETY, type SemanticTarget } from "./model";
import type { BrowserQueryBinding } from "./query";
import { canonicalIdentityFromPath, type EntityIdentityPolicy } from "./entityIdentity";

/* ------------------------------------------------------------------ *
 * Proposing an entity search from a demonstration.
 *
 * Deterministic, with no model call — the same rule the mutation proposal
 * follows, and for a stronger reason here: an entity search is DETERMINED
 * by its entity type. There is nothing for a model to infer about the
 * shape of "find an Opportunity by name"; asking one to invent it would
 * add a source of error where none is needed.
 *
 * What the demonstration is read for:
 *
 *   a query control     the field a term was typed into
 *   an opening action   the control that revealed it, when one was clicked
 *   an entity type      from the record the workflow ended on
 *
 * The last of those is the load-bearing one. A search is only a search FOR
 * something, and where the rep landed says what they were looking for.
 * ------------------------------------------------------------------ */

export interface QueryProposal {
  binding: BrowserQueryBinding | null;
  /** Why no query binding could be proposed, in plain language. */
  warnings: string[];
}

/** A trace that saved something is a mutation, whatever else it also did. */
function committedSomething(trace: ObservationTrace): boolean {
  return trace.observations.some((observation) => observation.action === "save");
}

/**
 * The entity the workflow ended up at.
 *
 * Read from the LAST record route navigated to, because a search that ends
 * on an Opportunity was a search for an Opportunity. Earlier navigations
 * are the journey, not the destination.
 */
function destinationEntity(trace: ObservationTrace, identity: EntityIdentityPolicy): string | undefined {
  for (let index = trace.observations.length - 1; index >= 0; index--) {
    const path = trace.observations[index]?.page?.path;
    if (!path) continue;
    const parsed = canonicalIdentityFromPath(path, identity);
    if (parsed?.entityType) return parsed.entityType;
  }
  return undefined;
}

/**
 * The control a term was typed into, and the term itself.
 *
 * The LAST field change that carried a value: a search box emits one event
 * per keystroke, and only the final one holds what was actually searched
 * for. A live trace showed nine changes for a six-word term.
 */
function queryControl(trace: ObservationTrace): { label: string; value?: string } | undefined {
  let found: { label: string; value?: string } | undefined;
  for (const event of trace.captureEvents ?? []) {
    if (event.kind !== "field_change") continue;
    const label = event.field?.label ?? event.element?.label;
    if (!label) continue;
    const value = event.value?.masked ? undefined : event.value?.to;
    // Later events supersede earlier ones for the same control, so the
    // final state of the box is what is remembered.
    found = { label, ...(value ? { value } : found?.value ? { value: found.value } : {}) };
  }
  return found;
}

/** The action clicked before any typing — a search box often has to be opened first. */
function openingAction(trace: ObservationTrace, queryLabel: string): SemanticTarget | undefined {
  for (const event of trace.captureEvents ?? []) {
    if (event.kind === "field_change") break;
    if (event.kind !== "click") continue;
    const label = event.actionLabel ?? event.element?.label;
    // Skipped when it names the query control itself: clicking into the box
    // is focusing it, not revealing it.
    if (!label || label === queryLabel) continue;
    return { role: "button", label };
  }
  return undefined;
}

/**
 * Proposes an entity search from a trace, or explains why it cannot.
 *
 * Pure and deterministic: the same trace always proposes the same binding.
 */
export function proposeQueryBinding(
  capability: SemanticCapability,
  trace: ObservationTrace,
  identity: EntityIdentityPolicy | undefined
): QueryProposal {
  const source = capability.provenance.sourceApplication;
  if (!source) return { binding: null, warnings: ["No source application is recorded for this capability."] };
  if (!identity) {
    return {
      binding: null,
      warnings: [
        "This platform does not declare how it identifies entities, so a search could not return anything a later " +
          "step could act on."
      ]
    };
  }
  if (committedSomething(trace)) {
    return {
      binding: null,
      warnings: ["This recording saved a record, so it describes a change rather than a search."]
    };
  }

  const control = queryControl(trace);
  if (!control) {
    return { binding: null, warnings: ["No search term was typed anywhere in this recording."] };
  }

  const entityType = destinationEntity(trace, identity);
  if (!entityType) {
    return {
      binding: null,
      warnings: [
        "The recording never reached a record, so there is nothing to say what kind of entity was being looked for. " +
          "Open one of the results before stopping the recording."
      ]
    };
  }

  const queryInput = capability.inputs.find((input) => input.role === "query") ?? capability.inputs[0];
  if (!queryInput) {
    return { binding: null, warnings: ["The capability declares no input to carry the search term."] };
  }

  const opening = openingAction(trace, control.label);
  return {
    binding: {
      id: `query-${capability.id}-${source.id}`,
      capabilityId: capability.id,
      sourceApplication: source,
      platform: source.id,
      entityType,
      query: { inputName: queryInput.name, semanticTarget: { role: "field", label: control.label } },
      ...(opening ? { open: opening } : {}),
      // Submitted by key rather than by clicking: the live trace showed
      // typing followed directly by navigation, with no commit control
      // anywhere between.
      submitKey: "Enter",
      safety: BROWSER_BINDING_SAFETY,
      evidence: [
        `Search control observed: a field labelled "${control.label}".`,
        ...(control.value ? [`Demonstrated search term: ${JSON.stringify(control.value)}.`] : []),
        ...(opening ? [`Opened by a control labelled "${opening.label}".`] : []),
        `Entity type resolved from the record the recording ended on: ${entityType}.`
      ]
    },
    warnings: []
  };
}
