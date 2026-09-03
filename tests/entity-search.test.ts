// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { candidatesOnPage, executeQuery, type BrowserQueryBinding } from "../src/binding/browserExecution/query";
import { entityIdentityPolicyForPlatform, resolverAdapterForPlatform } from "../src/binding/browserExecution/adapters";
import type { EntityIdentityPolicy } from "../src/binding/browserExecution/entityIdentity";
import { sourceApplicationFor } from "../src/training/sourceApplication";

/* ------------------------------------------------------------------ *
 * Entity resolution.
 *
 *   SEARCH MAY BE FUZZY. MUTATION MUST BE EXACT.
 *
 * Search's job is to hand back the platform's own stable identity, and
 * never to choose between candidates. A name cannot do that job: two
 * Opportunities may share one, and picking the first would be the system
 * silently deciding which record a later write lands on.
 * ------------------------------------------------------------------ */

const PLATFORM = "salesforce-lightning";
const IDENTITY = entityIdentityPolicyForPlatform(PLATFORM) as EntityIdentityPolicy;
const adapter = () => resolverAdapterForPlatform(PLATFORM);
const SALESFORCE = sourceApplicationFor(PLATFORM, "nvent-dev-ed.lightning.force.com");

const ACME_A = "0065w00002AZ0GeAAL";
const ACME_B = "0065w000023IJFiAAO";
const ACCOUNT = "0015w00002XYZabAAB";

const BINDING: BrowserQueryBinding = {
  id: "query-search_opportunities-salesforce-lightning",
  capabilityId: "search_opportunities",
  sourceApplication: SALESFORCE,
  platform: PLATFORM,
  entityType: "Opportunity",
  query: { inputName: "name", semanticTarget: { role: "field", label: "Search" } },
  submit: { role: "button", label: "Search" },
  safety: { noCoordinates: true, noXPath: true, noPrivateTransportReplay: true, noCredentialExtraction: true },
  evidence: []
};

/**
 * A results page shaped like the real thing: each row links the record
 * more than once, an unrelated object is linked alongside, and the two
 * matches share a name.
 */
function mountResults(): HTMLElement {
  document.body.innerHTML = `
    <label for="q">Search</label>
    <input id="q" type="text" />
    <button id="go">Search</button>
    <div id="results">
      <a href="/lightning/r/Opportunity/${ACME_A}/view">Acme Renewal</a>
      <a href="/lightning/r/Opportunity/${ACME_A}/view" aria-label="Preview Acme Renewal">Preview</a>
      <a href="/lightning/r/Opportunity/${ACME_B}/view">Acme Renewal</a>
      <a href="/lightning/r/Account/${ACCOUNT}/view">Acme Corporation</a>
      <a href="/lightning/o/Opportunity/list">All Opportunities</a>
    </div>
  `;
  document.querySelector("#go")!.addEventListener("click", () => {
    document.querySelector("#results")!.setAttribute("data-searched", "true");
  });
  return document.body;
}

const run = (inputs: Record<string, string>) =>
  executeQuery({
    root: mountResults(),
    binding: BINDING,
    inputs,
    adapter: adapter(),
    identity: IDENTITY,
    reaction: { timeoutMs: 40, quietMs: 10 }
  });

/* ===================== identity extraction ===================== */

describe("candidates carry the platform's own identity", () => {
  it("reads ids from the links' routes, using the declared pattern", () => {
    const candidates = candidatesOnPage(mountResults(), "Opportunity", IDENTITY, adapter());
    expect(candidates.map((candidate) => candidate.id)).toEqual([ACME_A, ACME_B]);
    expect(candidates.every((candidate) => candidate.entityType === "Opportunity")).toBe(true);
  });

  it("collapses repeated links to one candidate per record", () => {
    // A results row links the same record from its title and its preview.
    // Two links, one record.
    const candidates = candidatesOnPage(mountResults(), "Opportunity", IDENTITY, adapter());
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(2);
  });

  it("ignores entities of another type and links that identify nothing", () => {
    // The Account link and the list-view link are both on the page and
    // neither is an Opportunity candidate.
    const candidates = candidatesOnPage(mountResults(), "Opportunity", IDENTITY, adapter());
    expect(candidates.some((candidate) => candidate.id === ACCOUNT)).toBe(false);
    expect(candidates.some((candidate) => candidate.name === "All Opportunities")).toBe(false);
  });

  it("resolves the same identity from an absolute href", () => {
    document.body.innerHTML = `
      <a href="https://nvent-dev-ed.lightning.force.com/lightning/r/Opportunity/${ACME_A}/view">Acme Renewal</a>
    `;
    expect(candidatesOnPage(document.body, "Opportunity", IDENTITY, adapter())[0]?.id).toBe(ACME_A);
  });

  it("finds Accounts with the same code, given a different entity type", () => {
    // Nothing here is Opportunity-specific: the entity type is a parameter,
    // which is what makes search_accounts the same mechanism.
    const candidates = candidatesOnPage(mountResults(), "Account", IDENTITY, adapter());
    expect(candidates).toEqual([{ id: ACCOUNT, name: "Acme Corporation", entityType: "Account" }]);
  });
});

/* ===================== ambiguity is preserved ===================== */

describe("ambiguity is returned, never resolved", () => {
  it("returns both records that share a name, and picks neither", () => {
    // The case that makes identity necessary. Two Opportunities called
    // "Acme Renewal": a name cannot say which, and choosing one here would
    // decide where a later write lands.
    return run({ name: "Acme Renewal" }).then((outcome) => {
      expect(outcome.status).toBe("succeeded");
      expect(outcome.candidates).toHaveLength(2);
      expect(outcome.candidates.map((candidate) => candidate.name)).toEqual(["Acme Renewal", "Acme Renewal"]);
      expect(outcome.candidates.map((candidate) => candidate.id)).toEqual([ACME_A, ACME_B]);
      expect(outcome.warnings.join(" ")).toMatch(/none has been chosen/i);
    });
  });

  it("says nothing about ranking beyond the application's own order", () => {
    return run({ name: "Acme Renewal" }).then((outcome) => {
      // Returned in page order — the application ranked them, not us.
      expect(outcome.candidates[0].id).toBe(ACME_A);
      expect(outcome.warnings.join(" ")).toMatch(/application's own order/i);
    });
  });

  it("reports an empty result honestly rather than as a failure", async () => {
    document.body.innerHTML = `<label for="q">Search</label><input id="q" /><button>Search</button>`;
    const outcome = await executeQuery({
      root: document.body,
      binding: BINDING,
      inputs: { name: "Nothing At All" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 }
    });
    expect(outcome.status).toBe("no-results");
    expect(outcome.candidates).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });
});

/* ===================== running the search ===================== */

describe("the search is performed through the application's own controls", () => {
  it("types the term, runs the search, and reads what came back", async () => {
    const outcome = await run({ name: "Acme Renewal" });
    expect((document.querySelector("#q") as HTMLInputElement).value).toBe("Acme Renewal");
    expect(document.querySelector("#results")?.getAttribute("data-searched")).toBe("true");
    expect(outcome.evidence.join(" ")).toMatch(/Set "name" to "Acme Renewal"/);
  });

  it("refuses without a search term rather than listing the whole page", async () => {
    const outcome = await run({ name: "   " });
    expect(outcome.status).toBe("blocked");
    expect(outcome.candidates).toEqual([]);
  });

  it("applies a supplied filter and leaves an unsupplied one alone", async () => {
    document.body.innerHTML = `
      <label for="q">Search</label><input id="q" />
      <label for="acc">Account</label><input id="acc" value="untouched" />
      <button id="go">Search</button>
      <a href="/lightning/r/Opportunity/${ACME_A}/view">Acme Renewal</a>
    `;
    const filtered: BrowserQueryBinding = {
      ...BINDING,
      submit: { role: "button", label: "Search" },
      filters: [
        {
          inputName: "account_name",
          semanticTarget: { role: "field", label: "Account" },
          valueKind: "text"
        }
      ]
    };

    // Not supplied: "not narrowing by account" is a different search from
    // "narrowing by an empty account", so the control is left as it was.
    await executeQuery({
      root: document.body,
      binding: filtered,
      inputs: { name: "Acme" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 }
    });
    expect((document.querySelector("#acc") as HTMLInputElement).value).toBe("untouched");

    // Supplied: written.
    await executeQuery({
      root: document.body,
      binding: filtered,
      inputs: { name: "Acme", account_name: "Acme Corporation" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 }
    });
    expect((document.querySelector("#acc") as HTMLInputElement).value).toBe("Acme Corporation");
  });
});

/* ============ the handoff into a mutation ============ */

describe("what search returns is what update requires", () => {
  it("hands back an identity a mutation can be gated on", async () => {
    // The whole point of the pair. Search is allowed to be fuzzy — a name
    // matched two records — and the mutation that follows is exact,
    // because what travels between them is an id.
    const outcome = await run({ name: "Acme Renewal" });
    const chosen = outcome.candidates[1];
    expect(chosen.id).toBe(ACME_B);

    const { identityFromPath } = await import("../src/binding/browserExecution/entityIdentity");
    // The same id, read back from the record's own route, is what an
    // execution compares against.
    const openRecord = identityFromPath(`/lightning/r/Opportunity/${chosen.id}/view`, IDENTITY);
    expect(openRecord).toEqual({ entityType: "Opportunity", id: ACME_B });
  });

  it("stores nothing a DOM could invalidate", () => {
    // Scanned over the TARGETS, not the whole binding: the safety block
    // declares `noXPath: true`, and a search for "xpath" over the lot
    // matches the very flag asserting its absence.
    const targets = JSON.stringify([BINDING.query.semanticTarget, BINDING.submit, BINDING.filters]);
    expect(targets).not.toMatch(/queryselector|xpath|\/html\/|nth-child|clientx|nodeid/i);
    // Role plus visible label, exactly as a mutation binding's are.
    expect(BINDING.query.semanticTarget).toEqual({ role: "field", label: "Search" });
  });
});
