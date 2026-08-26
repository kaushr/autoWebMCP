import type { SemanticCapability } from "../semantic/model";
import { findContacts, getContact, searchCompanies } from "./service";

export const prospectCapabilities: SemanticCapability[] = [
  {
    id: "search_companies",
    name: "Search companies",
    description: "Search the prospect intelligence dataset for companies matching a name, industry, or summary.",
    inputs: [{ name: "query", description: "Company name, industry, or other search phrase.", type: "string", required: true }],
    outputs: [{ name: "companies", description: "Matching company records.", type: "array" }],
    binding: { application: "prospect-intelligence", action: "search_companies" },
    provenance: { source: "configured", observationIds: [], confirmedByHuman: false },
    safety: { readOnly: true, requiresConfirmation: false }
  },
  {
    id: "find_contacts",
    name: "Find relevant contacts",
    description: "Find contacts at a company filtered by function, seniority, and title keywords.",
    inputs: [
      { name: "company_id", description: "The company identifier returned by search_companies.", type: "string", required: true },
      { name: "function", description: "Optional business function, such as Procurement.", type: "string", required: false },
      { name: "seniority", description: "Optional seniority, such as VP or C-Level.", type: "string", required: false },
      { name: "title_keywords", description: "Optional words that must appear in the job title.", type: "string", required: false }
    ],
    outputs: [{ name: "contacts", description: "Matching contact records.", type: "array" }],
    binding: { application: "prospect-intelligence", action: "find_contacts" },
    provenance: { source: "configured", observationIds: [], confirmedByHuman: false },
    safety: { readOnly: true, requiresConfirmation: false }
  },
  {
    id: "get_contact",
    name: "Get contact",
    description: "Retrieve the details of one prospect contact.",
    inputs: [{ name: "contact_id", description: "The contact identifier returned by find_contacts.", type: "string", required: true }],
    outputs: [{ name: "contact", description: "The requested contact record.", type: "object" }],
    binding: { application: "prospect-intelligence", action: "get_contact" },
    provenance: { source: "configured", observationIds: [], confirmedByHuman: false },
    safety: { readOnly: true, requiresConfirmation: false }
  }
];

export function invokeProspectCapability(
  capability: SemanticCapability,
  input: Record<string, string | number | boolean | undefined>
): unknown {
  if (!capability.binding) {
    throw new Error(`No execution binding has been established for capability: ${capability.id}`);
  }
  switch (capability.binding.action) {
    case "search_companies":
      return { companies: searchCompanies(String(input.query ?? "")) };
    case "find_contacts":
      return {
        contacts: findContacts({
          company_id: String(input.company_id ?? ""),
          function: typeof input.function === "string" ? input.function : undefined,
          seniority: typeof input.seniority === "string" ? input.seniority : undefined,
          title_keywords: typeof input.title_keywords === "string" ? input.title_keywords : undefined
        })
      };
    case "get_contact":
      return { contact: getContact(String(input.contact_id ?? "")) ?? null };
    default:
      throw new Error(`Unsupported prospect binding: ${capability.binding.action}`);
  }
}
