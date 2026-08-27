import type { ObservationTrace } from "../../capture/normalize";
import type { CaptureFieldContext } from "../../capture/types";
import type { SemanticCapability } from "../../semantic/model";
import { observedRecordType, resolveFieldMapping } from "../fieldMapping";
import {
  BROWSER_BINDING_SAFETY,
  type BrowserBindingInput,
  type BrowserBindingProposal,
  type BrowserExecutionBinding,
  type FieldValueKind,
  type SemanticTarget
} from "./model";

/* ------------------------------------------------------------------ *
 * Deterministic browser binding proposal.
 *
 * No model call: everything a browser binding needs — a field's visible
 * label, the record type, the commit action's label — is evidence the
 * capture already recorded, the same evidence `fieldMapping.ts` reads for
 * the supported-API route. Silence beats a guess, so any input the evidence
 * cannot ground drops the whole proposal to `binding: null` with a plain
 * reason, exactly like `binding/model.ts`'s `noSafeCandidate`.
 * ------------------------------------------------------------------ */

const CONTROL_TO_VALUE_KIND: Record<string, FieldValueKind> = {
  date: "date",
  select: "select",
  combobox: "select",
  checkbox: "checkbox",
  number: "number",
  text: "text",
  textarea: "text",
  radio: "select",
  other: "text",
  masked: "text"
};

interface ObservedFieldEvidence {
  label?: string;
  section?: string;
  control?: CaptureFieldContext["control"];
}

/**
 * Label, section, and control kind for each observed field identifier — the
 * same capture events `fieldMapping.ts`'s internal `observedFields` reads,
 * kept separately here because that function does not expose labels, and a
 * browser binding's whole point is to resolve by label.
 */
function observedFieldEvidence(trace: ObservationTrace): Map<string, ObservedFieldEvidence> {
  const byIdentifier = new Map<string, ObservedFieldEvidence>();
  for (const event of trace.captureEvents ?? []) {
    const identifier = event.element?.name;
    if (!identifier) continue;

    const existing = byIdentifier.get(identifier);
    // A field_change event naming itself is stronger evidence than a click
    // did, same rule fieldMapping.ts applies to the identifier itself.
    if (existing && event.kind !== "field_change") continue;

    const label = event.field?.label ?? event.element?.label ?? event.actionLabel;
    byIdentifier.set(identifier, {
      ...(label ? { label } : {}),
      ...(event.field?.section ? { section: event.field.section } : {}),
      ...(event.field?.control ? { control: event.field.control } : {})
    });
  }
  return byIdentifier;
}

/**
 * The accessible label of the observed commit action, e.g. "Save". Never
 * assumed: only what the capture actually showed the human activate.
 */
function observedCommitLabel(trace: ObservationTrace): string | undefined {
  const save = trace.observations.find((observation) => observation.action === "save");
  return save?.target;
}

/**
 * Proposes a browser execution binding for a confirmed capability from the
 * trace it was learned from. Pure and deterministic: the same trace always
 * proposes the same binding, and a human still has to test and accept it
 * before it can execute anything.
 */
export function proposeBrowserBinding(
  capability: SemanticCapability,
  trace: ObservationTrace
): BrowserBindingProposal {
  const source = capability.provenance.sourceApplication;
  if (!source) {
    return { binding: null, warnings: ["No source application is recorded for this capability."] };
  }

  const commitLabel = observedCommitLabel(trace);
  if (!commitLabel) {
    return {
      binding: null,
      warnings: [
        "No commit action (e.g. Save) was observed in the capture, so there is nothing to invoke at the end of the workflow."
      ]
    };
  }

  const fieldMapping = resolveFieldMapping(capability, trace);
  if (
    fieldMapping.ambiguities.length > 0 ||
    Object.keys(fieldMapping.mapping).length !== capability.inputs.length
  ) {
    return {
      binding: null,
      warnings: [
        "Not every capability input has an unambiguous observed application field identifier.",
        ...fieldMapping.ambiguities
      ]
    };
  }

  const evidenceByIdentifier = observedFieldEvidence(trace);
  const inputs: BrowserBindingInput[] = [];
  const evidence: string[] = [];

  for (const input of capability.inputs) {
    const identifier = fieldMapping.mapping[input.name];
    const observed = evidenceByIdentifier.get(identifier);
    if (!observed?.label) {
      return {
        binding: null,
        warnings: [
          `No visible label was observed for the field identified as "${identifier}", so it cannot be resolved semantically at runtime.`
        ]
      };
    }

    const target: SemanticTarget = {
      role: "field",
      label: observed.label,
      applicationIdentifier: identifier,
      ...(observed.section ? { section: observed.section } : {})
    };
    // The capability's canonical type is stronger evidence than the capture's
    // control classification: a Lightning datepicker reports `control:
    // "other"`, which read as plain text and sent raw canonical dates into a
    // control expecting its display format. The human-confirmed contract
    // says what the value *is*; the observed control only suggests it.
    const valueKind: FieldValueKind =
      input.enum && input.enum.length > 0
        ? "select"
        : input.type === "date"
          ? "date"
          : input.type === "number"
            ? "number"
            : input.type === "boolean"
              ? "checkbox"
              : (CONTROL_TO_VALUE_KIND[observed.control ?? "text"] ?? "text");
    inputs.push({
      semanticInput: input.name,
      semanticTarget: target,
      valueKind
    });
    evidence.push(
      `"${input.name}" resolves at runtime to the control labelled "${observed.label}"` +
        `${observed.section ? ` in "${observed.section}"` : ""}, application identifier "${identifier}".`
    );
  }

  const recordType = observedRecordType(trace);
  const binding: BrowserExecutionBinding = {
    id: `browser-${capability.id}-${source.id}`,
    capabilityId: capability.id,
    sourceApplication: source,
    platform: source.id,
    context: {
      ...(recordType ? { recordType } : {}),
      pageMode: "edit-or-record"
    },
    inputs,
    commit: { semanticAction: { role: "button", label: commitLabel } },
    verification: [
      "edit-state-closed",
      "returned-to-record-view",
      "field-value-observable",
      "no-validation-error-visible"
    ],
    safety: BROWSER_BINDING_SAFETY,
    evidence: [
      ...(recordType ? [`Object type resolved from the captured page path: ${recordType}.`] : []),
      ...evidence,
      `Commit action observed: a click labelled "${commitLabel}" was treated as the save action.`
    ]
  };

  return { binding, warnings: [] };
}
