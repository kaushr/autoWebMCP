export interface Company {
  id: string;
  name: string;
  industry: string;
  employeeRange: string;
  summary: string;
}

export interface Contact {
  id: string;
  companyId: string;
  name: string;
  title: string;
  function: "Procurement" | "Operations" | "Information Technology" | "Finance" | "Sales" | "People";
  seniority: "C-Level" | "SVP" | "VP" | "Director" | "Manager";
  email: string;
  summary: string;
}

export const companies: Company[] = [
  ["acme", "Acme Industrial", "Industrial Manufacturing", "5,001–10,000", "Global manufacturer modernizing direct materials sourcing."],
  ["northstar", "Northstar Logistics", "Logistics", "1,001–5,000", "Regional logistics network expanding its carrier operations."],
  ["harbor", "Harbor Health Systems", "Healthcare", "5,001–10,000", "Integrated care provider standardizing operational systems."],
  ["vertex", "Vertex Software", "Software", "1,001–5,000", "B2B platform company growing its enterprise segment."],
  ["summit", "Summit Retail Group", "Retail", "10,001+", "Multi-brand retailer consolidating merchandising operations."],
  ["cedar", "Cedar Energy", "Energy", "1,001–5,000", "Renewable energy operator managing distributed assets."],
  ["atlas", "Atlas Construction", "Construction", "5,001–10,000", "National construction firm managing major project portfolios."],
  ["pioneer", "Pioneer Foods", "Food and Beverage", "1,001–5,000", "Consumer food producer scaling its supply chain."],
  ["clearwater", "Clearwater Financial", "Financial Services", "5,001–10,000", "Financial-services provider investing in data governance."],
  ["evergreen", "Evergreen Education", "Education", "1,001–5,000", "Education network improving student enrollment services."],
  ["redwood", "Redwood Materials", "Materials", "1,001–5,000", "Specialty materials company streamlining plant procurement."],
  ["lumen", "Lumen Media", "Media", "501–1,000", "Media network centralizing ad operations."],
  ["orbit", "Orbit Travel", "Travel", "1,001–5,000", "Corporate travel provider updating its partner platform."],
  ["meridian", "Meridian Insurance", "Insurance", "5,001–10,000", "Insurer simplifying claims and policy operations."],
  ["forge", "Forge Robotics", "Industrial Automation", "501–1,000", "Robotics manufacturer expanding into new distribution channels."],
  ["solstice", "Solstice Telecom", "Telecommunications", "10,001+", "Telecom provider upgrading its field-service operations."],
  ["willow", "Willow Hospitality", "Hospitality", "1,001–5,000", "Hotel group standardizing property technology."],
  ["keystone", "Keystone Public Sector", "Government Services", "5,001–10,000", "Public-sector contractor coordinating program delivery."],
  ["aperture", "Aperture Analytics", "Analytics", "501–1,000", "Analytics consultancy managing a growing enterprise client base."],
  ["riverstone", "Riverstone Utilities", "Utilities", "5,001–10,000", "Utility modernizing its infrastructure maintenance program."]
].map(([id, name, industry, employeeRange, summary]) => ({
  id,
  name,
  industry,
  employeeRange,
  summary
}));

const acmeContacts: Contact[] = [
  {
    id: "contact-acme-01",
    companyId: "acme",
    name: "Maya Chen",
    title: "VP Procurement",
    function: "Procurement",
    seniority: "VP",
    email: "maya.chen@acme.example",
    summary: "Executive owner for strategic sourcing and supplier performance."
  },
  {
    id: "contact-acme-02",
    companyId: "acme",
    name: "Jordan Patel",
    title: "Procurement Manager",
    function: "Procurement",
    seniority: "Manager",
    email: "jordan.patel@acme.example",
    summary: "Runs direct-materials sourcing programs and supplier onboarding."
  },
  {
    id: "contact-acme-03",
    companyId: "acme",
    name: "Elena Garcia",
    title: "SVP Operations",
    function: "Operations",
    seniority: "SVP",
    email: "elena.garcia@acme.example",
    summary: "Executive sponsor for manufacturing and operational excellence."
  },
  {
    id: "contact-acme-04",
    companyId: "acme",
    name: "Priya Nair",
    title: "VP Information Technology",
    function: "Information Technology",
    seniority: "VP",
    email: "priya.nair@acme.example",
    summary: "Leads enterprise applications and technology modernization."
  },
  {
    id: "contact-acme-05",
    companyId: "acme",
    name: "Marcus Reed",
    title: "Chief Financial Officer",
    function: "Finance",
    seniority: "C-Level",
    email: "marcus.reed@acme.example",
    summary: "Executive finance leader focused on capital efficiency."
  },
  {
    id: "contact-acme-06",
    companyId: "acme",
    name: "Nina Brooks",
    title: "Director, Supply Chain",
    function: "Procurement",
    seniority: "Director",
    email: "nina.brooks@acme.example",
    summary: "Owns supply continuity and supplier risk reporting."
  }
];

const generatedContacts: Contact[] = companies
  .filter((company) => company.id !== "acme")
  .flatMap((company, companyIndex) => {
    const firstNames = ["Avery", "Blair", "Casey", "Devon", "Emerson"];
    const roles: Array<Pick<Contact, "title" | "function" | "seniority">> = [
      { title: "VP Sales", function: "Sales", seniority: "VP" },
      { title: "Director of Information Technology", function: "Information Technology", seniority: "Director" },
      { title: "Operations Manager", function: "Operations", seniority: "Manager" },
      { title: "Finance Director", function: "Finance", seniority: "Director" },
      { title: "People Operations Manager", function: "People", seniority: "Manager" }
    ];

    return roles.map((role, roleIndex) => ({
      id: `contact-${company.id}-${String(roleIndex + 1).padStart(2, "0")}`,
      companyId: company.id,
      name: `${firstNames[roleIndex]} ${["Morris", "Shah", "Kim", "Davis", "Okafor"][companyIndex % 5]}`,
      ...role,
      email: `${firstNames[roleIndex].toLowerCase()}.${companyIndex + 1}@${company.id}.example`,
      summary: `Synthetic ${role.function.toLowerCase()} contact at ${company.name}.`
    }));
  });

export const contacts: Contact[] = [...acmeContacts, ...generatedContacts];
