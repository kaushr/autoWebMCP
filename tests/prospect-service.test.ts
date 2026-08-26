import { describe, expect, it } from "vitest";
import { contacts, companies } from "../src/prospect/data";
import { findContacts, getContact, searchCompanies } from "../src/prospect/service";

describe("Prospect Intelligence data and tools", () => {
  it("contains the deterministic synthetic dataset required for the demo", () => {
    expect(companies).toHaveLength(20);
    expect(contacts.length).toBeGreaterThanOrEqual(80);
    expect(contacts.length).toBeLessThanOrEqual(120);
  });

  it("finds Acme and its procurement executives", () => {
    expect(searchCompanies("Acme").map((company) => company.id)).toEqual(["acme"]);

    const results = findContacts({ company_id: "acme", function: "Procurement" });
    expect(results.map((contact) => contact.title)).toContain("VP Procurement");
    expect(results.map((contact) => contact.title)).toContain("Procurement Manager");
  });

  it("filters title keywords and retrieves a contact by id", () => {
    const results = findContacts({ company_id: "acme", title_keywords: "VP procurement" });
    expect(results).toHaveLength(1);
    expect(getContact(results[0].id)?.name).toBe("Maya Chen");
  });
});
