import type { SemanticCapability } from "../semantic/model";
import type { BrowserExecutionBinding } from "../binding/browserExecution/model";

/* ------------------------------------------------------------------ *
 * Execution test form — the typed input contract for testing a browser
 * execution binding, extracted from the Studio so it can be tested
 * without a DOM.
 *
 * A raw text prompt was too weak: it accepted anything, validated
 * nothing, and left the value's meaning to whatever the live control
 * happened to do with the string. Here the capability's canonical input
 * type drives the control (`date` → date control, `enum` → select,
 * `number` → numeric, `boolean` → toggle), values are validated and
 * canonicalized BEFORE the explicit execution confirmation, and the
 * same canonical contract is what an agent supplies through WebMCP —
 * dates always travel as `YYYY-MM-DD`; how a platform wants them
 * presented is the adapter's business.
 * ------------------------------------------------------------------ */

export type TestFieldControl = "text" | "date" | "number" | "checkbox" | "select";

export interface TestFormField {
  /** The capability input name — the canonical contract key. */
  name: string;
  /** What the human sees, from the binding's semantic target (required marker stripped). */
  label: string;
  control: TestFieldControl;
  options?: string[];
  required: boolean;
  /**
   * Set on a closed-domain field whose values are not known.
   *
   * The field stays a `select` — it is constrained whether or not anyone
   * has enumerated it — and the form must refuse to accept a typed value
   * rather than degrading to a text box, which would invite exactly the
   * arbitrary business value the application will reject.
   */
  domainUnknown?: boolean;
}

export type TestFormValidation =
  | { ok: true; values: Record<string, string> }
  | { ok: false; errors: string[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function displayLabel(label: string): string {
  return label.replace(/^\*/, "").trim();
}

/**
 * One form field per binding input, typed by the capability's canonical
 * contract. The capability says what the value *is* (type, enum,
 * required); the binding says what the human called it on screen.
 */
export function buildTestFormFields(
  capability: SemanticCapability,
  binding: BrowserExecutionBinding,
  /** Values read from the live application, which outrank any stored domain. */
  liveOptions?: Record<string, string[]>
): TestFormField[] {
  return binding.inputs.map((bindingInput) => {
    const input = capability.inputs.find((candidate) => candidate.name === bindingInput.semanticInput);
    const label = displayLabel(bindingInput.semanticTarget.label) || bindingInput.semanticInput;

    if (input?.enum && input.enum.length > 0) {
      return { name: bindingInput.semanticInput, label, control: "select" as const, options: [...input.enum], required: input.required };
    }

    // The value domain, materialized onto the binding when it was proposed
    // or read from the live application just before the form was built.
    // Absent means "not yet established", NEVER "unconstrained" — a live
    // run proved the difference: a picklist that degraded to a text box let
    // an arbitrary Stage value through to the runtime, which then had
    // nothing sensible to do with it.
    const declaredOptions = liveOptions?.[bindingInput.semanticInput] ?? bindingInput.applicationField?.options;

    const control: TestFieldControl =
      input?.type === "date"
        ? "date"
        : input?.type === "number"
          ? "number"
          : input?.type === "boolean"
            ? "checkbox"
            : bindingInput.valueKind === "date"
              ? "date"
              : bindingInput.valueKind === "number"
                ? "number"
                : bindingInput.valueKind === "checkbox"
                  ? "checkbox"
                  : bindingInput.valueKind === "select"
                    ? "select"
                    : "text";

    const domainUnknown = control === "select" && !(declaredOptions && declaredOptions.length > 0);
    return {
      name: bindingInput.semanticInput,
      label,
      control,
      ...(control === "select" && declaredOptions ? { options: [...declaredOptions] } : {}),
      ...(domainUnknown ? { domainUnknown: true } : {}),
      required: input?.required ?? true
    };
  });
}

/**
 * Validates and canonicalizes what the form collected. Runs BEFORE the
 * execution confirmation — invalid or missing required values block here,
 * without the target application ever being touched.
 */
export function validateTestInputs(
  fields: readonly TestFormField[],
  raw: Record<string, string | undefined>
): TestFormValidation {
  const errors: string[] = [];
  const values: Record<string, string> = {};

  for (const field of fields) {
    const value = (raw[field.name] ?? "").trim();

    if (field.control === "checkbox") {
      values[field.name] = value === "true" || value === "on" ? "true" : "false";
      continue;
    }
    if (!value) {
      if (field.control === "select" && field.domainUnknown) {
        errors.push(
          `"${field.label}" is a fixed set of choices, but its valid values are not known yet. ` +
            "The application's own list could not be read, so there is nothing to choose from."
        );
        continue;
      }
      if (field.required) errors.push(`"${field.label}" is required.`);
      continue;
    }
    switch (field.control) {
      case "date":
        if (!ISO_DATE.test(value)) {
          errors.push(`"${field.label}" must be a calendar date (YYYY-MM-DD). Use the date control.`);
          continue;
        }
        values[field.name] = value;
        break;
      case "number": {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          errors.push(`"${field.label}" must be a number.`);
          continue;
        }
        values[field.name] = String(parsed);
        break;
      }
      case "select":
        if (field.domainUnknown) {
          errors.push(
            `"${field.label}" is a fixed set of choices, but its valid values are not known yet, so no value can be checked. ` +
              "Nothing was sent to the application."
          );
          continue;
        }
        if (!field.options?.includes(value)) {
          errors.push(`"${field.label}" must be one of: ${field.options?.join(", ") ?? ""}.`);
          continue;
        }
        values[field.name] = value;
        break;
      default:
        values[field.name] = value;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

/** A canonical value as a human reads it in the confirmation — dates localized, booleans worded. */
export function displayValue(field: TestFormField, value: string): string {
  if (field.control === "date" && ISO_DATE.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }
  if (field.control === "checkbox") return value === "true" ? "checked" : "unchecked";
  return value;
}

/**
 * The confirmation text: a summary of exactly what will be done with the
 * values already collected and validated — never a request for more input.
 */
export function summarizeExecutionPlan(
  fields: readonly TestFormField[],
  values: Record<string, string>,
  commitLabel: string,
  applicationLabel: string
): string {
  const changes = fields
    .filter((field) => values[field.name] !== undefined)
    .map((field) => `Change ${field.label} to ${displayValue(field, values[field.name])}`);
  return [
    "AutoWebMCP is about to:",
    ...changes,
    `and activate "${commitLabel}" on the taught ${applicationLabel} record.`,
    "",
    "Continue?"
  ].join("\n");
}
