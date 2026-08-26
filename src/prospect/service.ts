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

export function searchCompanies(query: string): Company[] {
  const needle = normalize(query);
  if (!needle) return [];

  return companies.filter((company) =>
    [company.name, company.industry, company.summary].some((value) => normalize(value).includes(needle))
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
