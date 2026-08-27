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
