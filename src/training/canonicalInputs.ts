import type { ObservationTrace } from "../capture/normalize";
import type { SemanticCapability } from "../semantic/model";
import { assertSemanticCapability } from "../semantic/model";
import { resolveFieldMapping, type ApplicationIntelligence } from "../binding/fieldMapping";
import { foldIdentity, type StandardApplicationSchema } from "../applicationIntelligence/model";

/* ------------------------------------------------------------------ *
 * Canonical capability vocabulary.
 *
 * The semanticizer names inputs after the labels a human saw, which is the
 * right default and the wrong contract. A label is TENANT vocabulary: an
 * org that renames Stage to "Sales Stage" would publish
 * `update_opportunity({ sales_stage })`, so two orgs running the same
 * application would hand an agent two different tools for one business
 * capability — and any agent written against one would break on the other.
 *
 * The application's own field identity is the thing that does not move.
 * `StageName` is `StageName` in every org, and the vendor's label for it is
 * the same everywhere too. So once an input is grounded, its name is taken
 * from the VENDOR's vocabulary rather than the tenant's.
 *
 * Deliberately deterministic and model-free. Renaming a published contract
 * is not a judgement call, and re-asking a model would make the contract
 * depend on inference twice over. The rename happens before a human
 * confirms, so what they approve is what an agent will see.
 *
 * The honest limit: this can only canonicalize what standard knowledge
 * recognizes. An input grounded to a custom field, or to a renamed field in
 * an org with no tenant metadata installed, keeps the tenant-derived name
 * and is reported in `tenantDerived` rather than quietly renamed to
 * something invented.
 * ------------------------------------------------------------------ */

/** One input renamed from a tenant's vocabulary to the vendor's. */
export interface InputCanonicalization {
  from: string;
  to: string;
  /** The field identity that made the rename safe. */
  apiName: string;
  detail: string;
}

export interface CanonicalizationResult {
  capability: SemanticCapability;
  renames: InputCanonicalization[];
  /**
   * Inputs whose names still come from what this tenant happens to call
   * the field, because nothing vendor-level identified them. Not a
   * failure — a disclosure, so a contract that is tenant-shaped says so.
   */
  tenantDerived: string[];
}

/** `Close Date` → `close_date`. Snake case, as `assertSemanticCapability` requires. */
export function toInputName(label: string): string {
  const name = label
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return /^[a-z]/.test(name) ? name : "";
}

/** The vendor's own name for a field identity, when the vendor's model knows it. */
function vendorNameFor(apiName: string, standard: StandardApplicationSchema | undefined): string | undefined {
  if (!standard) return undefined;
  const wanted = foldIdentity(apiName);
  for (const object of standard.objects) {
    const field = object.fields.find((entry) => foldIdentity(entry.apiName) === wanted);
    if (field) return toInputName(field.defaultLabel) || undefined;
  }
  return undefined;
}

/**
 * Renames a confirmed-or-proposed capability's inputs to the vendor's
 * vocabulary wherever the application's own model grounds them.
 *
 * Pure: returns a new capability and never mutates the one passed in. A
 * capability whose inputs are already canonical comes back unchanged, with
 * no renames, which is what the proven US org produces today.
 */
export function canonicalizeCapabilityInputs(
  capability: SemanticCapability,
  trace: ObservationTrace,
  intelligence: ApplicationIntelligence = {}
): CanonicalizationResult {
  const mapping = resolveFieldMapping(capability, trace, intelligence);
  const renames: InputCanonicalization[] = [];
  const tenantDerived: string[] = [];

  // Names already spoken for, so canonicalizing one input can never
  // collide with another's name — a capability with two inputs called
  // `stage` would not survive `assertSemanticCapability`, and silently
  // dropping one would be worse than leaving a tenant-shaped name.
  const taken = new Set(capability.inputs.map((input) => input.name));

  const inputs = capability.inputs.map((input) => {
    // Only demonstrated business fields have a vendor name to move onto.
    // A targeting parameter or a search term is not a field on the record,
    // so it is neither renamed nor reported as failing to ground.
    if ((input.role ?? "business") !== "business") return input;
    const field = mapping.fields[input.name];
    if (!field) {
      tenantDerived.push(input.name);
      return input;
    }
    const canonical = vendorNameFor(field.apiName, intelligence.standard);
    if (!canonical) {
      // Grounded, but to something the vendor's model does not describe —
      // a custom field, typically. Its only stable name is the API name
      // the org itself assigned, so the observed name stands.
      tenantDerived.push(input.name);
      return input;
    }
    if (canonical === input.name || taken.has(canonical)) return input;

    taken.add(canonical);
    renames.push({
      from: input.name,
      to: canonical,
      apiName: field.apiName,
      detail:
        `"${input.name}" was named after this org's label for ${field.apiName}. ` +
        `The vendor's own name for that field is "${canonical}", so the published contract uses it and stays the ` +
        "same for any org running this application."
    });
    return { ...input, name: canonical };
  });

  if (renames.length === 0) return { capability, renames, tenantDerived };
  return { capability: assertSemanticCapability({ ...capability, inputs }), renames, tenantDerived };
}
