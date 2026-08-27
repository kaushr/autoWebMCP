/**
 * Synthetic prospect-intelligence dataset.
 *
 * Everything here is fictional and generated deterministically: the same build
 * always produces the same companies, contacts, and identifiers, so tests, the
 * Teach Mode recorder, and WebMCP tool output all agree.
 */

export const CONTACT_FUNCTIONS = [
  "Procurement",
  "Operations",
  "Information Technology",
  "Finance",
  "Sales",
  "People"
] as const;

export const SENIORITIES = ["C-Level", "SVP", "VP", "Director", "Manager"] as const;

export type ContactFunction = (typeof CONTACT_FUNCTIONS)[number];
export type Seniority = (typeof SENIORITIES)[number];

export interface Company {
  id: string;
  name: string;
  domain: string;
  industry: string;
  employeeCount: number;
  headquarters: string;
  description: string;
}

export interface Contact {
  id: string;
  companyId: string;
  name: string;
  title: string;
  function: ContactFunction;
  seniority: Seniority;
  location: string;
  email: string;
  phone: string;
  responsibilitySummary: string;
}

/** A coarse band, the way a prospecting tool shows headcount rather than an exact number. */
export function formatEmployeeCount(count: number): string {
  if (count > 10_000) return "10,001+";
  if (count > 5_000) return "5,001–10,000";
  if (count > 1_000) return "1,001–5,000";
  if (count > 500) return "501–1,000";
  return "201–500";
}

type CompanySeed = [
  id: string,
  name: string,
  domain: string,
  industry: string,
  employeeCount: number,
  headquarters: string,
  description: string
];

const companySeeds: CompanySeed[] = [
  ["acme", "Acme Industrial", "acmeindustrial.example", "Industrial Manufacturing", 7400, "Columbus, OH", "Global manufacturer of precision components, modernizing how it sources direct materials across eleven plants."],
  ["northstar", "Northstar Logistics", "northstarlogistics.example", "Logistics", 3200, "Minneapolis, MN", "Regional freight network expanding carrier operations into the Southeast."],
  ["harbor", "Harbor Health Systems", "harborhealth.example", "Healthcare", 8600, "Baltimore, MD", "Integrated care provider standardizing clinical and back-office systems across 14 hospitals."],
  ["vertex", "Vertex Software", "vertexsoftware.example", "Software", 1900, "Austin, TX", "B2B workflow platform moving upmarket into regulated enterprise accounts."],
  ["summit", "Summit Retail Group", "summitretail.example", "Retail", 14500, "Chicago, IL", "Multi-brand retailer consolidating merchandising and store operations onto one platform."],
  ["cedar", "Cedar Energy", "cedarenergy.example", "Energy", 2400, "Denver, CO", "Renewable operator managing a distributed portfolio of wind and solar assets."],
  ["atlas", "Atlas Construction", "atlasconstruction.example", "Construction", 6100, "Dallas, TX", "National contractor running large civil and commercial project portfolios."],
  ["pioneer", "Pioneer Foods", "pioneerfoods.example", "Food and Beverage", 4300, "Kansas City, MO", "Consumer food producer scaling a cold-chain supply network."],
  ["clearwater", "Clearwater Financial", "clearwaterfinancial.example", "Financial Services", 9200, "Charlotte, NC", "Mid-market lender investing in data governance and regulatory reporting."],
  ["evergreen", "Evergreen Education", "evergreeneducation.example", "Education", 2800, "Portland, OR", "Education network improving enrollment and student support services."],
  ["redwood", "Redwood Materials Group", "redwoodmaterials.example", "Materials", 3600, "Sacramento, CA", "Specialty materials producer streamlining plant-level purchasing."],
  ["lumen", "Lumen Media", "lumenmedia.example", "Media", 820, "New York, NY", "Independent media network centralizing ad operations and rights management."],
  ["orbit", "Orbit Travel", "orbittravel.example", "Travel", 2100, "Atlanta, GA", "Corporate travel provider rebuilding its partner and supplier platform."],
  ["meridian", "Meridian Insurance", "meridianinsurance.example", "Insurance", 7800, "Hartford, CT", "Property and casualty insurer simplifying claims and policy administration."],
  ["forge", "Forge Robotics", "forgerobotics.example", "Industrial Automation", 640, "Pittsburgh, PA", "Robotics manufacturer expanding into indirect distribution channels."],
  ["solstice", "Solstice Telecom", "solsticetelecom.example", "Telecommunications", 16800, "Phoenix, AZ", "Regional carrier upgrading field-service and network operations tooling."],
  ["willow", "Willow Hospitality", "willowhospitality.example", "Hospitality", 4900, "Nashville, TN", "Hotel group standardizing property technology across four brands."],
  ["keystone", "Keystone Public Sector", "keystonepublic.example", "Government Services", 5900, "Arlington, VA", "Public-sector contractor coordinating multi-agency program delivery."],
  ["aperture", "Aperture Analytics", "apertureanalytics.example", "Analytics", 710, "Boston, MA", "Analytics consultancy managing a fast-growing enterprise client base."],
  ["riverstone", "Riverstone Utilities", "riverstoneutilities.example", "Utilities", 6700, "Sacramento, CA", "Regulated utility modernizing its infrastructure maintenance program."]
];

export const companies: Company[] = companySeeds.map(
  ([id, name, domain, industry, employeeCount, headquarters, description]) => ({
    id,
    name,
    domain,
    industry,
    employeeCount,
    headquarters,
    description
  })
);

/**
 * Acme is the demo account. It deliberately carries three procurement people at
 * three seniorities so that "the most relevant procurement executive" has to be
 * reasoned about from function and seniority rather than read off a flag.
 */
const acmeContacts: Contact[] = [
  {
    id: "contact-acme-01",
    companyId: "acme",
    name: "Maya Chen",
    title: "VP Procurement",
    function: "Procurement",
    seniority: "VP",
    location: "Columbus, OH",
    email: "maya.chen@acmeindustrial.example",
    phone: "+1 (614) 555-0143",
    responsibilitySummary:
      "Owns strategic sourcing, supplier performance, and the direct-materials category budget."
  },
  {
    id: "contact-acme-02",
    companyId: "acme",
    name: "Daniel Brooks",
    title: "Procurement Manager",
    function: "Procurement",
    seniority: "Manager",
    location: "Columbus, OH",
    email: "daniel.brooks@acmeindustrial.example",
    phone: "+1 (614) 555-0188",
    responsibilitySummary: "Runs day-to-day sourcing events and supplier onboarding for two plants."
  },
  {
    id: "contact-acme-03",
    companyId: "acme",
    name: "Nina Alvarez",
    title: "Director, Indirect Procurement",
    function: "Procurement",
    seniority: "Director",
    location: "Chicago, IL",
    email: "nina.alvarez@acmeindustrial.example",
    phone: "+1 (312) 555-0117",
    responsibilitySummary: "Leads indirect spend categories including facilities, MRO, and services."
  },
  {
    id: "contact-acme-04",
    companyId: "acme",
    name: "Priya Shah",
    title: "SVP Operations",
    function: "Operations",
    seniority: "SVP",
    location: "Columbus, OH",
    email: "priya.shah@acmeindustrial.example",
    phone: "+1 (614) 555-0102",
    responsibilitySummary: "Executive sponsor for manufacturing throughput and operational excellence."
  },
  {
    id: "contact-acme-05",
    companyId: "acme",
    name: "Marcus Lee",
    title: "Chief Information Officer",
    function: "Information Technology",
    seniority: "C-Level",
    location: "Columbus, OH",
    email: "marcus.lee@acmeindustrial.example",
    phone: "+1 (614) 555-0110",
    responsibilitySummary: "Accountable for enterprise applications, integration, and technology spend."
  },
  {
    id: "contact-acme-06",
    companyId: "acme",
    name: "Tomas Weber",
    title: "VP Information Technology",
    function: "Information Technology",
    seniority: "VP",
    location: "Detroit, MI",
    email: "tomas.weber@acmeindustrial.example",
    phone: "+1 (313) 555-0164",
    responsibilitySummary: "Runs plant systems, ERP delivery, and the manufacturing data platform."
  },
  {
    id: "contact-acme-07",
    companyId: "acme",
    name: "Elena Garcia",
    title: "Chief Financial Officer",
    function: "Finance",
    seniority: "C-Level",
    location: "Columbus, OH",
    email: "elena.garcia@acmeindustrial.example",
    phone: "+1 (614) 555-0129",
    responsibilitySummary: "Approves capital allocation and multi-year supplier commitments."
  },
  {
    id: "contact-acme-08",
    companyId: "acme",
    name: "Jordan Kim",
    title: "Director, Sales Operations",
    function: "Sales",
    seniority: "Director",
    location: "Columbus, OH",
    email: "jordan.kim@acmeindustrial.example",
    phone: "+1 (614) 555-0175",
    responsibilitySummary: "Owns forecasting, territory design, and revenue systems."
  }
];

type RoleSeed = Pick<Contact, "title" | "function" | "seniority">;

/** Three rosters so companies do not all present an identical org chart. */
const roleTemplates: RoleSeed[][] = [
  [
    { title: "VP Sales", function: "Sales", seniority: "VP" },
    { title: "Director of Information Technology", function: "Information Technology", seniority: "Director" },
    { title: "Procurement Manager", function: "Procurement", seniority: "Manager" },
    { title: "Finance Director", function: "Finance", seniority: "Director" },
    { title: "Operations Manager", function: "Operations", seniority: "Manager" }
  ],
  [
    { title: "Chief Information Officer", function: "Information Technology", seniority: "C-Level" },
    { title: "VP Operations", function: "Operations", seniority: "VP" },
    { title: "Director of Procurement", function: "Procurement", seniority: "Director" },
    { title: "Sales Operations Manager", function: "Sales", seniority: "Manager" },
    { title: "People Operations Director", function: "People", seniority: "Director" }
  ],
  [
    { title: "VP Finance", function: "Finance", seniority: "VP" },
    { title: "Director of Operations", function: "Operations", seniority: "Director" },
    { title: "IT Manager", function: "Information Technology", seniority: "Manager" },
    { title: "VP Procurement", function: "Procurement", seniority: "VP" },
    { title: "Sales Director", function: "Sales", seniority: "Director" }
  ]
];

const firstNames = [
  "Avery", "Rosa", "Casey", "Devon", "Emerson", "Farrah", "Gabriel", "Harriet", "Idris", "Jonah",
  "Kiara", "Lucas", "Mira", "Noor", "Omar", "Paloma", "Quinn", "Rafael", "Simone", "Theo",
  "Ursula", "Victor", "Wren", "Ximena", "Yusuf"
];

const lastNames = [
  "Morris", "Okafor", "Delgado", "Whitfield", "Nakamura", "Bergstrom", "Ibrahim", "Vasquez", "Lindqvist", "Achebe",
  "Rossi", "Kaur", "Petrov", "Mbeki", "Hollis", "Castellanos", "Novak", "Fitzgerald", "Haddad", "Sorensen",
  "Bianchi", "Ferreira", "Tanaka", "Wexler", "Adeyemi"
];

const satelliteCities = ["Remote (US)", "Seattle, WA", "Tampa, FL", "Columbus, OH", "San Jose, CA"];

const responsibilityByFunction: Record<ContactFunction, string> = {
  Procurement: "Manages supplier selection, contract terms, and category spend.",
  Operations: "Responsible for service delivery, capacity planning, and process performance.",
  "Information Technology": "Owns core systems, integrations, and technology vendor relationships.",
  Finance: "Handles budgeting, business cases, and spend approval thresholds.",
  Sales: "Leads revenue targets, pipeline coverage, and go-to-market execution.",
  People: "Oversees hiring plans, workforce programs, and internal enablement."
};

const generatedContacts: Contact[] = companies
  .filter((company) => company.id !== "acme")
  .flatMap((company, companyIndex) =>
    roleTemplates[companyIndex % roleTemplates.length].map((role, roleIndex) => {
      const seed = companyIndex * roleTemplates[0].length + roleIndex;
      const first = firstNames[(seed * 7) % firstNames.length];
      const last = lastNames[(seed * 11) % lastNames.length];

      return {
        id: `contact-${company.id}-${String(roleIndex + 1).padStart(2, "0")}`,
        companyId: company.id,
        name: `${first} ${last}`,
        ...role,
        location: roleIndex % 3 === 0 ? satelliteCities[seed % satelliteCities.length] : company.headquarters,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@${company.domain}`,
        phone: `+1 (${200 + (seed % 700)}) 555-0${String(100 + (seed % 800)).padStart(3, "0")}`,
        responsibilitySummary: `${responsibilityByFunction[role.function]} Based at ${company.name}.`
      };
    })
  );

export const contacts: Contact[] = [...acmeContacts, ...generatedContacts];
