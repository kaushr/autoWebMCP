import type { ObservationTrace } from "../capture/normalize";
import type { SemanticCapability } from "../semantic/model";

/**
 * Field mapping from evidence, not from a model.
 *
 * The capture already recorded the control's own identifier — the real
 * Salesforce session observed `<input name="CloseDate">` under the label
 * `*Close Date`. That is the application naming its own field, which beats any
 * inference. The order is deliberate: deterministic metadata first, human
 * confirmation next, and a model only where nothing else can answer.
 *
 * Nothing here knows what Salesforce or CloseDate is. It matches a capability's
 * inputs against identifiers the application itself supplied.
 */

export interface FieldMappingResult {
  /** Semantic input name → application field identifier. */
  mapping: Record<string, string>;
  /** Inputs that matched more than one field, or none. Never guessed. */
  ambiguities: string[];
  evidence: string[];
}

interface ObservedField {
  identifier: string;
  label?: string;
  /** Higher wins when the same identifier appears on several events. */
  strength: number;
}

/**
 * Field identifiers the application exposed, from anywhere in the capture.
 *
 * Not only field changes. On a component library the change event is retargeted
 * to a shadow host that carries no name, while the click that focused the
 * control still reports the real one — the live Salesforce session recorded
 * `<input name="CloseDate">` on the click and `<lightning-datepicker>` with no
 * name on the change. Restricting this to change events threw the only
 * deterministic identifier away.
 */
function observedFields(trace: ObservationTrace): ObservedField[] {
  const found = new Map<string, ObservedField>();

  for (const event of trace.captureEvents ?? []) {
    const identifier = event.element?.name;
    if (!identifier) continue;

    // A field change naming itself is stronger evidence than a click did.
    const strength = event.kind === "field_change" ? 2 : 1;
    const label = event.field?.label ?? event.element?.label ?? event.actionLabel;
    const existing = found.get(identifier);
    if (existing && existing.strength >= strength) continue;
    found.set(identifier, { identifier, strength, ...(label ? { label } : {}) });
  }
  return [...found.values()];
}

/** `close_date` and `CloseDate` and `*Close Date` all reduce to `closedate`. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolveFieldMapping(
  capability: SemanticCapability,
  trace: ObservationTrace
): FieldMappingResult {
  const fields = observedFields(trace);
  const mapping: Record<string, string> = {};
  const ambiguities: string[] = [];
  const evidence: string[] = [];

  if (fields.length === 0) {
    return {
      mapping,
      ambiguities: capability.inputs.map(
        (input) => `No application field identifier was observed for "${input.name}".`
      ),
      evidence: ["The capture recorded no field identifiers, so no mapping could be established."]
    };
  }

  for (const input of capability.inputs) {
    const target = fold(input.name);
    const matches = fields.filter(
      (field) => fold(field.identifier) === target || (field.label ? fold(field.label) === target : false)
    );

    if (matches.length === 1) {
      mapping[input.name] = matches[0].identifier;
      evidence.push(
        `"${input.name}" maps to the observed field identifier "${matches[0].identifier}"${
          matches[0].label ? ` (labelled "${matches[0].label}")` : ""
        }.`
      );
      continue;
    }

    // More than one candidate is not a coin toss. Silence beats a wrong write.
    ambiguities.push(
      matches.length === 0
        ? `No observed field identifier matches "${input.name}".`
        : `"${input.name}" matches several observed fields: ${matches
            .map((field) => field.identifier)
            .join(", ")}. A human must choose.`
    );
  }

  return { mapping, ambiguities, evidence };
}

/** The record type the capture happened on, when the path revealed one. */
export function observedRecordType(trace: ObservationTrace): string | undefined {
  for (const observation of trace.observations) {
    const match = observation.page?.path.match(/\/lightning\/r\/([A-Za-z0-9_]+)\//);
    if (match) return match[1];
  }
  return undefined;
}
