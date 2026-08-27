import type { CapabilityInputValue, CapabilityInputValues, SemanticCapability } from "../semantic/model";
import {
  findContacts,
  findRelevantContacts,
  getCompany,
  getContact,
  searchCompanies
} from "./service";

export const PROSPECT_APPLICATION = "prospect-intelligence";

type BindingHandler = (inputs: CapabilityInputValues) => unknown;

function text(value: CapabilityInputValue): string {
  return typeof value === "string" ? value.trim() : value === undefined ? "" : String(value);
}

function optional(value: CapabilityInputValue): string | undefined {
  const trimmed = text(value);
  return trimmed === "" ? undefined : trimmed;
}

/** A human may rename an input during confirmation, so accept the near synonyms. */
function firstOf(inputs: CapabilityInputValues, names: string[]): CapabilityInputValue {
  for (const name of names) {
    if (inputs[name] !== undefined && text(inputs[name]) !== "") return inputs[name];
  }
  return undefined;
}

/**
 * The execution bindings this application already has.
 *
 * Nothing here is exposed to an agent on its own. A binding becomes reachable
 * only when a confirmed capability that resolves to it has been published.
 */
export const prospectBindings: Record<string, BindingHandler> = {
  find_relevant_contacts: (inputs) =>
    findRelevantContacts({
      company: text(firstOf(inputs, ["company", "company_name", "company_id", "account"])),
      function: optional(firstOf(inputs, ["function", "business_function", "department"])),
      seniority: optional(firstOf(inputs, ["seniority", "seniority_level"])),
      title_keywords: optional(firstOf(inputs, ["title_keywords", "title"]))
    }),
  search_companies: (inputs) => ({ companies: searchCompanies(text(inputs.query)) }),
  find_contacts: (inputs) => ({
    contacts: findContacts({
      company_id: text(inputs.company_id),
      function: optional(inputs.function),
      seniority: optional(inputs.seniority),
      title_keywords: optional(inputs.title_keywords)
    })
  }),
  get_contact: (inputs) => ({ contact: getContact(text(inputs.contact_id)) ?? null }),
  get_company: (inputs) => ({ company: getCompany(text(inputs.company_id)) ?? null })
};

/**
 * A capability taught through the extension often carries no binding at all, so
 * the application matches on its own action names and falls back to the
 * capability id. Returning undefined means "this site cannot execute that".
 */
export function bindingActionFor(capability: SemanticCapability): string | undefined {
  if (capability.binding && capability.binding.application !== PROSPECT_APPLICATION) return undefined;

  const action = capability.binding?.action;
  if (action && action in prospectBindings) return action;
  if (!action && capability.id in prospectBindings) return capability.id;
  return undefined;
}

export function invokeProspectBinding(capability: SemanticCapability, inputs: CapabilityInputValues): unknown {
  const action = bindingActionFor(capability);
  if (!action) {
    throw new Error(`No execution binding has been established for capability: ${capability.id}`);
  }
  return prospectBindings[action](inputs);
}
