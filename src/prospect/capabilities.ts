import type { SemanticCapability } from "../semantic/model";
import { CONTACT_FUNCTIONS, SENIORITIES } from "./data";

/**
 * Reference capability contracts.
 *
 * None of these are registered by the application. They are kept as the shape a
 * confirmed capability is expected to take once it has been taught: fixtures for
 * the deterministic compiler's tests, and a reference for what each execution
 * binding in `bindings.ts` expects to be handed.
 *
 * The site starts with no agent capability at all; publication is what creates
 * one.
 */
export const referenceCapabilities: SemanticCapability[] = [
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
    name: "Find contacts",
    description: "Find contacts at a known company identifier, filtered by function, seniority, and title keywords.",
    inputs: [
      { name: "company_id", description: "The company identifier returned by search_companies.", type: "string", required: true },
      {
        name: "function",
        description: "Optional business function, such as Procurement.",
        type: "string",
        required: false,
        enum: [...CONTACT_FUNCTIONS]
      },
      {
        name: "seniority",
        description: "Optional seniority, such as VP or C-Level.",
        type: "string",
        required: false,
        enum: [...SENIORITIES]
      },
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
  },
  {
    id: "get_company",
    name: "Get company",
    description: "Retrieve the profile of one company, including industry, headcount, headquarters, and domain.",
    inputs: [
      { name: "company_id", description: "The company identifier returned by search_companies.", type: "string", required: true }
    ],
    outputs: [{ name: "company", description: "The requested company record.", type: "object" }],
    binding: { application: "prospect-intelligence", action: "get_company" },
    provenance: { source: "configured", observationIds: [], confirmedByHuman: false },
    safety: { readOnly: true, requiresConfirmation: false }
  }
];

/**
 * What the semanticizer is expected to propose from the canonical training
 * session: search Tesla, open it, filter by function and seniority, open a
 * person. One business outcome, not four UI primitives.
 *
 * This is a test fixture and a review reference. The recorder must never emit
 * it, and the site must never register it without a human publishing it.
 */
export const findRelevantContactsProposal: SemanticCapability = {
  id: "find_relevant_contacts",
  name: "Find Relevant Contacts",
  description: "Find relevant contacts at a company by business function and seniority.",
  inputs: [
    { name: "company", description: "The company to research.", type: "string", required: true },
    { name: "function", description: "Business function, such as Procurement.", type: "string", required: false },
    { name: "seniority", description: "Seniority, such as VP.", type: "string", required: false }
  ],
  outputs: [{ name: "contacts", description: "The matching contacts at that company.", type: "array" }],
  provenance: { source: "inferred", observationIds: [], confirmedByHuman: false },
  safety: { readOnly: true, requiresConfirmation: false }
};
