import { describe, expect, it } from "vitest";
import { CONTACT_FUNCTIONS, SENIORITIES, companies, contacts, formatEmployeeCount } from "../src/prospect/data";
import { countContacts, findContacts, getCompany, getContact, searchCompanies } from "../src/prospect/service";
import { invokeProspectCapability, prospectCapabilities } from "../src/prospect/capabilities";
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
  it("finds Acme by name and is case insensitive", () => {
    expect(searchCompanies("Acme").map((company) => company.id)).toEqual(["acme"]);
    expect(searchCompanies("acme").map((company) => company.id)).toEqual(["acme"]);
    expect(searchCompanies("  ACME  ").map((company) => company.id)).toEqual(["acme"]);
  });

  it("also matches partial names, domains, and industries", () => {
    expect(searchCompanies("acm").map((company) => company.id)).toEqual(["acme"]);
    expect(searchCompanies("acmeindustrial.example").map((company) => company.id)).toEqual(["acme"]);
    expect(searchCompanies("Logistics").map((company) => company.id)).toContain("northstar");
  });

  it("returns nothing for an empty or unmatched query", () => {
    expect(searchCompanies("")).toEqual([]);
    expect(searchCompanies("   ")).toEqual([]);
    expect(searchCompanies("zzzzz")).toEqual([]);
  });
});

describe("Contact filtering at Acme", () => {
  it("maps the buying committee the demo reasons over", () => {
    const acme = findContacts({ company_id: "acme" });
    expect(countContacts("acme")).toBe(acme.length);
    expect(acme.map((contact) => `${contact.name} — ${contact.title}`)).toEqual([
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
    const procurement = findContacts({ company_id: "acme", function: "Procurement" });
    expect(procurement.map((contact) => contact.seniority)).toEqual(["VP", "Manager", "Director"]);

    const executive = findContacts({ company_id: "acme", function: "Procurement", seniority: "VP" });
    expect(executive.map((contact) => contact.name)).toEqual(["Maya Chen"]);
  });

  it("does not encode a single hardcoded answer: several procurement seniorities exist", () => {
    const procurement = findContacts({ company_id: "acme", function: "Procurement" });
    expect(procurement.length).toBeGreaterThan(1);
    expect(new Set(procurement.map((contact) => contact.seniority)).size).toBeGreaterThan(1);
  });

  it("filters title keywords and retrieves a contact by id", () => {
    const results = findContacts({ company_id: "acme", title_keywords: "VP procurement" });
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
    const input = { company_id: "acme", function: "Procurement", seniority: "VP" };
    expect(findContacts(input)).toEqual(findContacts(input));
  });
});

describe("Prospect capabilities", () => {
  it("exposes the four business capabilities the agent composes with", () => {
    expect(prospectCapabilities.map((capability) => capability.id)).toEqual([
      "search_companies",
      "find_contacts",
      "get_contact",
      "get_company"
    ]);
    expect(prospectCapabilities.every((capability) => capability.safety.readOnly)).toBe(true);
  });

  it("runs the demo path end to end through the capability bindings", () => {
    const byId = (id: string) => prospectCapabilities.find((capability) => capability.id === id)!;

    const found = invokeProspectCapability(byId("search_companies"), { query: "Acme" }) as {
      companies: Array<{ id: string }>;
    };
    expect(found.companies.map((company) => company.id)).toEqual(["acme"]);

    const candidates = invokeProspectCapability(byId("find_contacts"), {
      company_id: "acme",
      function: "Procurement",
      seniority: "VP"
    }) as { contacts: Array<{ id: string }> };
    expect(candidates.contacts).toHaveLength(1);

    const contact = invokeProspectCapability(byId("get_contact"), {
      contact_id: candidates.contacts[0].id
    }) as { contact: { name: string; email: string } | null };
    expect(contact.contact?.name).toBe("Maya Chen");
    expect(contact.contact?.email).toBe("maya.chen@acmeindustrial.example");

    const company = invokeProspectCapability(byId("get_company"), { company_id: "acme" }) as {
      company: { headquarters: string } | null;
    };
    expect(company.company?.headquarters).toBe("Columbus, OH");
  });

  it("compiles every capability into a valid read-only WebMCP tool", async () => {
    for (const capability of prospectCapabilities) {
      const tool = compileCapability(capability, invokeProspectCapability);
      expect(tool.name).toBe(capability.id);
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const input of capability.inputs) {
        expect(tool.inputSchema.properties[input.name]).toBeDefined();
      }
    }

    const findContactsTool = compileCapability(
      prospectCapabilities.find((capability) => capability.id === "find_contacts")!,
      invokeProspectCapability
    );
    expect(findContactsTool.inputSchema.required).toEqual(["company_id"]);
    expect(findContactsTool.inputSchema.properties.seniority?.enum).toContain("VP");

    const result = await findContactsTool.execute({ company_id: "acme", function: "Procurement", seniority: "VP" });
    expect(JSON.parse(result.content[0].text).contacts[0].name).toBe("Maya Chen");
  });

  it("returns null rather than throwing for unknown identifiers", () => {
    const byId = (id: string) => prospectCapabilities.find((capability) => capability.id === id)!;
    expect(invokeProspectCapability(byId("get_contact"), { contact_id: "nope" })).toEqual({ contact: null });
    expect(invokeProspectCapability(byId("get_company"), { company_id: "nope" })).toEqual({ company: null });
  });
});
