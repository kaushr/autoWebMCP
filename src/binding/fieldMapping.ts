import type { ObservationTrace } from "../capture/normalize";
import type { SemanticCapability } from "../semantic/model";
import type {
  ApplicationFieldType,
  EpistemicNeed,
  FieldClarification,
  FieldGrounding,
  ObservedFieldSignal,
  ResolutionStatus,
  ResolvedApplicationField,
  StandardApplicationSchema,
  TenantIntelligenceSource
} from "../applicationIntelligence/model";
import { foldIdentity } from "../applicationIntelligence/model";
import { resolveApplicationField, type ObservedFieldCandidate } from "../applicationIntelligence/resolveField";

/**
 * Field mapping from evidence, explained by application knowledge.
 *
 * The capture records what the application named its own controls — the
 * real Salesforce session observed `<input name="CloseDate">` under the
 * label `*Close Date`. That is the application naming its own field, which
 * beats any inference.
 *
 * But a component library need not name anything. A Lightning picklist is
 * a button and a listbox inside shadow components, and a live capture of a
 * Stage change exposed no `name` on any of its events — only the visible
 * label `*Stage`. Requiring an identifier therefore threw away a field the
 * human demonstrably changed. What was missing was not more DOM digging
 * but a layer that knows what `Stage` *means* on an Opportunity, which is
 * `applicationIntelligence/`.
 *
 * This module stays the evidence half: it extracts what the recording
 * observed and hands it to the resolver. It never guesses, and an input it
 * cannot ground uniquely blocks rather than binding something plausible.
 */

/** Application knowledge available while grounding. All parts optional; absence degrades, never crashes. */
export interface ApplicationIntelligence {
  platform?: string;
  standard?: StandardApplicationSchema;
  tenant?: TenantIntelligenceSource;
  /** Answers a human has already given for this capability. Consulted last, by design. */
  clarifications?: readonly FieldClarification[];
}

export interface FieldMappingResult {
  /** Semantic input name → the application's own field identity. */
  mapping: Record<string, string>;
  /** The full resolved field per input: type, options where known, provenance. */
  fields: Record<string, ResolvedApplicationField>;
  /** How each mapped input was grounded — evidence and knowledge, separately. */
  grounding: Record<string, FieldGrounding>;
  /**
   * The observed signal each mapping rests on. A binding resolves controls
   * at runtime by what is on screen, so the caller needs the observed label
   * and identifier — never the application's API name, which describes what
   * the field is and not where it is.
   */
  observed: Record<string, ObservedFieldSignal>;
  /** Inputs that matched more than one field, or none. Never guessed. */
  ambiguities: string[];
  /**
   * What the system knows it is missing, per input.
   *
   * The difference between "this failed" and "this needs one specific
   * fact": a need names the gap precisely enough to act on, so an
   * unresolved field becomes a question rather than a dead end. Includes
   * non-blocking needs, which record a gap without stopping anything.
   */
  needs: EpistemicNeed[];
  /** The outcome per input, so a caller can tell a question from a refusal. */
  statuses: Record<string, ResolutionStatus>;
  evidence: string[];
}

/**
 * Every field the capture observed a human interact with.
 *
 * Not only field changes, and no longer only named controls. On a
 * component library the change event is retargeted to a shadow host that
 * carries no name, while the click that focused the control still reports
 * the real one — the live Salesforce session recorded `<input
 * name="CloseDate">` on the click and `<lightning-datepicker>` with no
 * name on the change. A picklist reported no name on any event at all.
 *
 * Candidates collapse on the application's identifier when one exists and
 * on the folded visible label otherwise, so repeated events for one field
 * become one candidate while genuinely distinct fields stay distinct — and
 * two different fields sharing a label stay two candidates, which is what
 * makes that case block instead of silently picking one.
 */
export function observedFieldCandidates(trace: ObservationTrace): ObservedFieldCandidate[] {
  const found = new Map<string, ObservedFieldCandidate>();

  for (const event of trace.captureEvents ?? []) {
    const identifier = event.element?.name;
    const label = event.field?.label ?? event.element?.label ?? event.actionLabel;
    if (!identifier && !label) continue;

    // A field change naming itself is stronger evidence than a click did.
    const strength = event.kind === "field_change" ? 2 : 1;
    const key = identifier ? `id:${foldIdentity(identifier)}` : `label:${foldIdentity(label as string)}`;
    const existing = found.get(key);
    if (existing && existing.strength >= strength) continue;

    // The control classification and any value the human actually set are
    // deterministic discriminators when several fields share a label.
    const value = event.kind === "field_change" && !event.value?.masked ? event.value?.to : undefined;
    found.set(key, {
      ...(identifier ? { applicationIdentifier: identifier } : {}),
      ...(label ? { label } : {}),
      ...(event.field?.section ? { section: event.field.section } : {}),
      ...(event.field?.control ? { control: event.field.control } : {}),
      ...(value ? { value } : {}),
      strength
    });
  }
  return [...found.values()];
}

/**
 * The capability's own declared type, in the application's vocabulary.
 *
 * Used only to rule a candidate out. `string` is what an unconfirmed input
 * looks like and deliberately rules nothing out; an enumerated input is a
 * closed domain, which is what a picklist is.
 */
function declaredTypeFor(input: SemanticCapability["inputs"][number]): ApplicationFieldType | undefined {
  if (input.enum && input.enum.length > 0) return "picklist";
  if (input.type === "date") return "date";
  if (input.type === "number") return "number";
  if (input.type === "boolean") return "boolean";
  return undefined;
}

/** The inputs a human actually demonstrated — the only ones grounding can resolve. */
export function businessInputs(capability: SemanticCapability): SemanticCapability["inputs"] {
  return capability.inputs.filter((input) => (input.role ?? "business") === "business");
}

export function resolveFieldMapping(
  capability: SemanticCapability,
  trace: ObservationTrace,
  intelligence: ApplicationIntelligence = {}
): FieldMappingResult {
  const observed = observedFieldCandidates(trace);
  const objectApiName = observedRecordType(trace);
  const mapping: Record<string, string> = {};
  const fields: Record<string, ResolvedApplicationField> = {};
  const grounding: Record<string, FieldGrounding> = {};
  const observedByInput: Record<string, ObservedFieldSignal> = {};
  const ambiguities: string[] = [];
  const needs: EpistemicNeed[] = [];
  const statuses: Record<string, ResolutionStatus> = {};
  const evidence: string[] = [];

  if (observed.length === 0) {
    return {
      mapping,
      fields,
      grounding,
      observed: observedByInput,
      needs,
      statuses,
      ambiguities: businessInputs(capability).map(
        (input) => `No application field identifier or visible label was observed for "${input.name}".`
      ),
      evidence: ["The capture recorded no field evidence, so no mapping could be established."]
    };
  }

  // A target-identity input names WHICH record, not a field on it. Nobody
  // demonstrated it and no control holds it, so grounding must not look for
  // one — asking "which Opportunity field is opportunity_id?" has no true
  // answer, and forcing one would put a write somewhere it does not belong.
  for (const input of businessInputs(capability)) {
    const resolution = resolveApplicationField({
      inputName: input.name,
      ...(objectApiName ? { objectApiName } : {}),
      ...(declaredTypeFor(input) ? { inputType: declaredTypeFor(input) } : {}),
      observed,
      ...(intelligence.platform ? { platform: intelligence.platform } : {}),
      ...(intelligence.standard ? { standard: intelligence.standard } : {}),
      ...(intelligence.tenant ? { tenant: intelligence.tenant } : {}),
      ...(intelligence.clarifications ? { clarifications: intelligence.clarifications } : {})
    });

    statuses[input.name] = resolution.status;
    if (resolution.need) needs.push(resolution.need);
    if (!resolution.ok) {
      ambiguities.push(resolution.reason);
      continue;
    }
    mapping[input.name] = resolution.field.apiName;
    fields[input.name] = resolution.field;
    grounding[input.name] = resolution.grounding;
    observedByInput[input.name] = resolution.observed;
    evidence.push(resolution.grounding.detail);
  }

  return { mapping, fields, grounding, observed: observedByInput, needs, statuses, ambiguities, evidence };
}

/** The record type the capture happened on, when the path revealed one. */
export function observedRecordType(trace: ObservationTrace): string | undefined {
  for (const observation of trace.observations) {
    const match = observation.page?.path.match(/\/lightning\/r\/([A-Za-z0-9_]+)\//);
    if (match) return match[1];
  }
  return undefined;
}
