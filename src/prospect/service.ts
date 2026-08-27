import { companies, contacts, type Company, type Contact } from "./data";

export interface FindContactsInput {
  company_id: string;
  function?: string;
  seniority?: string;
  title_keywords?: string;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Deterministic substring matching over name, domain, industry, and description.
 * No ranking model, no embeddings: the demo depends on this being debuggable.
 */
export function searchCompanies(query: string): Company[] {
  const needle = normalize(query);
  if (!needle) return [];

  return companies.filter((company) =>
    [company.name, company.domain, company.industry, company.description].some((value) =>
      normalize(value).includes(needle)
    )
  );
}

export function findContacts(input: FindContactsInput): Contact[] {
  const functionFilter = input.function ? normalize(input.function) : undefined;
  const seniorityFilter = input.seniority ? normalize(input.seniority) : undefined;
  const titleTerms = input.title_keywords
    ? normalize(input.title_keywords)
        .split(/\s+/)
        .filter(Boolean)
    : [];

  return contacts.filter((contact) => {
    if (contact.companyId !== input.company_id) return false;
    if (functionFilter && normalize(contact.function) !== functionFilter) return false;
    if (seniorityFilter && normalize(contact.seniority) !== seniorityFilter) return false;
    return titleTerms.every((term) => normalize(contact.title).includes(term));
  });
}

/** Resolves what a human typed into the search box to one company record. */
export function resolveCompany(nameOrId: string): Company | undefined {
  const needle = normalize(nameOrId);
  if (!needle) return undefined;

  return (
    companies.find((company) => company.id === needle) ??
    companies.find((company) => normalize(company.name) === needle) ??
    searchCompanies(nameOrId)[0]
  );
}

export interface FindRelevantContactsInput {
  company: string;
  function?: string;
  seniority?: string;
  title_keywords?: string;
}

export interface RelevantContacts {
  company: Company | null;
  contacts: Contact[];
}

/**
 * The whole research workflow as one call: resolve the account, then narrow its
 * contacts. It composes the functions the pages already use rather than
 * reimplementing search and filtering for an agent.
 */
export function findRelevantContacts(input: FindRelevantContactsInput): RelevantContacts {
  const company = resolveCompany(input.company);
  if (!company) return { company: null, contacts: [] };

  return {
    company,
    contacts: findContacts({
      company_id: company.id,
      function: input.function,
      seniority: input.seniority,
      title_keywords: input.title_keywords
    })
  };
}

export function getContact(contactId: string): Contact | undefined {
  return contacts.find((contact) => contact.id === contactId);
}

export function getCompany(companyId: string): Company | undefined {
  return companies.find((company) => company.id === companyId);
}

/** Companies shown before the visitor has searched for anything. */
export function featuredCompanies(limit = 6): Company[] {
  return companies.slice(0, limit);
}

export function countContacts(companyId: string): number {
  return contacts.reduce((total, contact) => total + (contact.companyId === companyId ? 1 : 0), 0);
}
