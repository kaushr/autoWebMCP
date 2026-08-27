import type { ObservationTrace } from "../../capture/normalize";
import type { CaptureFieldContext } from "../../capture/types";
import type { SemanticCapability } from "../../semantic/model";
import { observedRecordType, resolveFieldMapping, type ApplicationIntelligence } from "../fieldMapping";
import type { ApplicationFieldType } from "../../applicationIntelligence/model";
import {
  BROWSER_BINDING_SAFETY,
  type BoundApplicationField,
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

/**
 * What the application says a field *is*, mapped to how a value must be
 * put into it. Stronger than the capture's control classification: a
 * Lightning picklist and a Lightning datepicker both report `control:
 * "other"`, and only the application's own model separates them.
 */
const APPLICATION_TYPE_TO_VALUE_KIND: Record<ApplicationFieldType, FieldValueKind> = {
  string: "text",
  date: "date",
  datetime: "date",
  number: "number",
  currency: "number",
  boolean: "checkbox",
  picklist: "select",
  reference: "text"
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
  trace: ObservationTrace,
  intelligence: ApplicationIntelligence = {}
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

  const fieldMapping = resolveFieldMapping(capability, trace, intelligence);
  if (
    fieldMapping.ambiguities.length > 0 ||
    Object.keys(fieldMapping.mapping).length !== capability.inputs.length
  ) {
    return {
      binding: null,
      warnings: [
        "Not every capability input could be grounded in the application's own model.",
        ...fieldMapping.ambiguities
      ]
    };
  }

  const evidenceByIdentifier = observedFieldEvidence(trace);
  const inputs: BrowserBindingInput[] = [];
  const evidence: string[] = [];

  for (const input of capability.inputs) {
    const applicationField = fieldMapping.fields[input.name];
    const grounding = fieldMapping.grounding[input.name];
    const observed = fieldMapping.observed[input.name];
    if (!observed?.label) {
      return {
        binding: null,
        warnings: [
          `No visible label was observed for the field grounded as "${applicationField.apiName}", so it cannot be resolved semantically at runtime.`
        ]
      };
    }

    // The target says how to FIND the control on screen, so it carries only
    // what the page itself shows: the visible label, and the identifier the
    // control exposed if it exposed one. The application's API name says
    // what the field IS and belongs on `applicationField` — putting
    // `StageName` here would invite the runtime to look for a DOM name that
    // Lightning never renders.
    const target: SemanticTarget = {
      role: "field",
      label: observed.label,
      ...(observed.applicationIdentifier ? { applicationIdentifier: observed.applicationIdentifier } : {}),
      ...(observed.section ? { section: observed.section } : {})
    };
    const observedControl = observed.applicationIdentifier
      ? evidenceByIdentifier.get(observed.applicationIdentifier)?.control
      : undefined;
    // How the value must be written, strongest source first.
    //
    // The application's own declared type outranks both the confirmed
    // capability type and the capture's control classification, because a
    // Lightning datepicker and a Lightning picklist both report `control:
    // "other"` and only the application's model tells them apart. A human
    // enumerating the domain still wins: that is an explicit statement
    // about this capability, not a guess about the control.
    const valueKind: FieldValueKind =
      input.enum && input.enum.length > 0
        ? "select"
        : grounding.knowledge !== "observation-only"
          ? APPLICATION_TYPE_TO_VALUE_KIND[applicationField.type]
          : input.type === "date"
            ? "date"
            : input.type === "number"
              ? "number"
              : input.type === "boolean"
                ? "checkbox"
                : (CONTROL_TO_VALUE_KIND[observedControl ?? "text"] ?? "text");

    const bound: BoundApplicationField = {
      ...(applicationField.objectApiName ? { objectApiName: applicationField.objectApiName } : {}),
      apiName: applicationField.apiName,
      type: applicationField.type,
      ...(applicationField.options ? { options: [...applicationField.options] } : {}),
      ...(applicationField.optionsSource ? { optionsSource: applicationField.optionsSource } : {}),
      knowledge: grounding.knowledge,
      ...(grounding.release ? { release: grounding.release } : {})
    };

    inputs.push({
      semanticInput: input.name,
      semanticTarget: target,
      valueKind,
      applicationField: bound
    });
    evidence.push(grounding.detail);
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
