import { describe, expect, it } from "vitest";
import { CONTACT_FUNCTIONS, SENIORITIES, companies, contacts, formatEmployeeCount } from "../src/prospect/data";
import { countContacts, findContacts, getCompany, getContact, searchCompanies } from "../src/prospect/service";
import { referenceCapabilities } from "../src/prospect/capabilities";
import { invokeProspectBinding } from "../src/prospect/bindings";
import { compileCapability } from "../src/webmcp/compiler";

describe("Prospect Intelligence dataset", () => {
  it("contains the deterministic synthetic dataset required for the demo", () => {
    expect(companies).toHaveLength(20);
    expect(contacts.length).toBeGreaterThanOrEqual(80);
    expect(contacts.length).toBeLessThanOrEqual(120);
  });

  it("gives every company and contact a complete, unique record", () => {
    expect(new Set(companies.map((company) => company.id)).size).toBe(companies.length);
    expect(new Set(contacts.map((contact) => contact.id)).size).toBe(contacts.length);

    for (const company of companies) {
      expect(company.domain).toMatch(/\.example$/);
      expect(company.headquarters).toMatch(/, [A-Z]{2}$/);
      expect(company.employeeCount).toBeGreaterThan(0);
      expect(company.description.length).toBeGreaterThan(20);
    }

    for (const contact of contacts) {
      expect(getCompany(contact.companyId)).toBeDefined();
      expect(CONTACT_FUNCTIONS).toContain(contact.function);
      expect(SENIORITIES).toContain(contact.seniority);
      expect(contact.email).toMatch(/^[a-z.]+@[a-z]+\.example$/);
      expect(contact.responsibilitySummary.length).toBeGreaterThan(20);
    }
  });

  it("bands headcount the way a prospecting tool displays it", () => {
    expect(formatEmployeeCount(7400)).toBe("5,001–10,000");
    expect(formatEmployeeCount(640)).toBe("501–1,000");
    expect(formatEmployeeCount(16800)).toBe("10,001+");
  });
});

describe("Company search", () => {
  it("finds Tesla by name and is case insensitive", () => {
    expect(searchCompanies("Tesla").map((company) => company.id)).toEqual(["tesla"]);
    expect(searchCompanies("tesla").map((company) => company.id)).toEqual(["tesla"]);
    expect(searchCompanies("  TESLA  ").map((company) => company.id)).toEqual(["tesla"]);
  });

  it("also matches partial names, domains, and industries", () => {
    expect(searchCompanies("tes").map((company) => company.id)).toEqual(["tesla"]);
    expect(searchCompanies("teslamotors.example").map((company) => company.id)).toEqual(["tesla"]);
    expect(searchCompanies("Logistics").map((company) => company.id)).toContain("northstar");
  });

  it("returns nothing for an empty or unmatched query", () => {
    expect(searchCompanies("")).toEqual([]);
    expect(searchCompanies("   ")).toEqual([]);
    expect(searchCompanies("zzzzz")).toEqual([]);
  });
});

describe("Contact filtering at Tesla", () => {
  it("maps the buying committee the demo reasons over", () => {
    const tesla = findContacts({ company_id: "tesla" });
    expect(countContacts("tesla")).toBe(tesla.length);
    expect(tesla.map((contact) => `${contact.name} — ${contact.title}`)).toEqual([
      "Maya Chen — VP Procurement",
      "Daniel Brooks — Procurement Manager",
      "Nina Alvarez — Director, Indirect Procurement",
      "Priya Shah — SVP Operations",
      "Marcus Lee — Chief Information Officer",
      "Tomas Weber — VP Information Technology",
      "Elena Garcia — Chief Financial Officer",
      "Jordan Kim — Director, Sales Operations"
    ]);
  });

  it("narrows by function, then by seniority", () => {
    const procurement = findContacts({ company_id: "tesla", function: "Procurement" });
    expect(procurement.map((contact) => contact.seniority)).toEqual(["VP", "Manager", "Director"]);

    const executive = findContacts({ company_id: "tesla", function: "Procurement", seniority: "VP" });
    expect(executive.map((contact) => contact.name)).toEqual(["Maya Chen"]);
  });

  it("does not encode a single hardcoded answer: several procurement seniorities exist", () => {
    const procurement = findContacts({ company_id: "tesla", function: "Procurement" });
    expect(procurement.length).toBeGreaterThan(1);
    expect(new Set(procurement.map((contact) => contact.seniority)).size).toBeGreaterThan(1);
  });

  it("filters title keywords and retrieves a contact by id", () => {
    const results = findContacts({ company_id: "tesla", title_keywords: "VP procurement" });
    expect(results).toHaveLength(1);
    expect(getContact(results[0].id)?.name).toBe("Maya Chen");
  });

  it("never leaks contacts from another company", () => {
    for (const contact of findContacts({ company_id: "northstar" })) {
      expect(contact.companyId).toBe("northstar");
    }
    expect(findContacts({ company_id: "does-not-exist" })).toEqual([]);
  });

  it("is stable across repeated calls", () => {
    const input = { company_id: "tesla", function: "Procurement", seniority: "VP" };
    expect(findContacts(input)).toEqual(findContacts(input));
  });
});

describe("Reference capability contracts", () => {
  it("describes the bindings this application already has", () => {
    expect(referenceCapabilities.map((capability) => capability.id)).toEqual([
      "search_companies",
      "find_contacts",
      "get_contact",
      "get_company"
    ]);
    expect(referenceCapabilities.every((capability) => capability.safety.readOnly)).toBe(true);
    // Configured, not confirmed: none of these may be published as they stand.
    expect(referenceCapabilities.every((capability) => !capability.provenance.confirmedByHuman)).toBe(true);
  });

  it("runs the demo path end to end through the execution bindings", () => {
    const byId = (id: string) => referenceCapabilities.find((capability) => capability.id === id)!;

    const found = invokeProspectBinding(byId("search_companies"), { query: "Tesla" }) as {
      companies: Array<{ id: string }>;
    };
    expect(found.companies.map((company) => company.id)).toEqual(["tesla"]);

    const candidates = invokeProspectBinding(byId("find_contacts"), {
      company_id: "tesla",
      function: "Procurement",
      seniority: "VP"
    }) as { contacts: Array<{ id: string }> };
    expect(candidates.contacts).toHaveLength(1);

    const contact = invokeProspectBinding(byId("get_contact"), {
      contact_id: candidates.contacts[0].id
    }) as { contact: { name: string; email: string } | null };
    expect(contact.contact?.name).toBe("Maya Chen");
    expect(contact.contact?.email).toBe("maya.chen@teslamotors.example");

    const company = invokeProspectBinding(byId("get_company"), { company_id: "tesla" }) as {
      company: { headquarters: string } | null;
    };
    expect(company.company?.headquarters).toBe("Columbus, OH");
  });

  it("compiles every reference capability into a valid read-only WebMCP tool", async () => {
    for (const capability of referenceCapabilities) {
      const tool = compileCapability(capability, invokeProspectBinding);
      expect(tool.name).toBe(capability.id);
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const input of capability.inputs) {
        expect(tool.inputSchema.properties[input.name]).toBeDefined();
      }
    }

    const findContactsTool = compileCapability(
      referenceCapabilities.find((capability) => capability.id === "find_contacts")!,
      invokeProspectBinding
    );
    expect(findContactsTool.inputSchema.required).toEqual(["company_id"]);
    expect(findContactsTool.inputSchema.properties.seniority?.enum).toContain("VP");

    const result = await findContactsTool.execute({ company_id: "tesla", function: "Procurement", seniority: "VP" });
    expect(JSON.parse(result.content[0].text).contacts[0].name).toBe("Maya Chen");
  });

  it("returns null rather than throwing for unknown identifiers", () => {
    const byId = (id: string) => referenceCapabilities.find((capability) => capability.id === id)!;
    expect(invokeProspectBinding(byId("get_contact"), { contact_id: "nope" })).toEqual({ contact: null });
    expect(invokeProspectBinding(byId("get_company"), { company_id: "nope" })).toEqual({ company: null });
  });
});

/* ====== an input named after the label a human read off the screen ====== */

describe("a taught input reaches the action it was bound to", () => {
  it("matches a name derived from the form's own label", async () => {
    // The live failure: SignalBase labels its search "Company name, domain,
    // or industry", so the taught input became
    // `company_name_domain_or_industry` — which no alias list anticipated.
    // The agent's call returned {"company":null,"contacts":[]} for an
    // account plainly on the page.
    const { prospectBindings } = await import("../src/prospect/bindings");
    const result = prospectBindings.find_relevant_contacts({
      company_name_domain_or_industry: "Tesla",
      function: "Procurement",
      seniority: "VP"
    }) as { company: unknown; contacts: unknown[] };

    expect(result.company).not.toBeNull();
    expect(result.contacts.length).toBeGreaterThan(0);
  });

  it("still prefers an exact name over one that merely starts with it", async () => {
    const { prospectBindings } = await import("../src/prospect/bindings");
    const result = prospectBindings.find_relevant_contacts({
      company: "Tesla",
      company_name_domain_or_industry: "Northstar"
    }) as { company: { name?: string } | null };
    expect(result.company?.name).toBe("Tesla Motors");
  });
});
