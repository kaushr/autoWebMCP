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
      <a href="/lightning/r/${ACME_A}/view">Acme Renewal</a>
      <a href="/lightning/r/Opportunity/${ACME_A}/view" aria-label="Preview Acme Renewal">Preview</a>
      <a href="/lightning/r/${ACME_B}/view">Acme Renewal</a>
      <a href="/lightning/r/${ACCOUNT}/view">Acme Corporation</a>
      <a href="/lightning/o/Opportunity/list">All Opportunities</a>
      <a href="/lightning/r/Opportunity/${ACME_A}/related/OpportunityLineItems/view">Products(4)</a>
    </div>
  `;
  document.querySelector("#go")!.addEventListener("click", () => {
    document.querySelector("#results")!.setAttribute("data-searched", "true");
  });
  return document.body;
}

/**
 * A page where the results ARRIVE when the search runs, which is what a
 * real one does. A fixture that has them mounted from the start cannot
 * distinguish a search that worked from one that never ran.
 */
function mountSearchable(): HTMLElement {
  const root = mountResults();
  const results = document.querySelector("#results")!;
  const html = results.innerHTML;
  results.innerHTML = "";
  document.querySelector("#go")!.addEventListener("click", () => {
    results.innerHTML = html;
  });
  return root;
}

const run = (inputs: Record<string, string>) =>
  executeQuery({
    root: mountSearchable(),
    binding: BINDING,
    inputs,
    adapter: adapter(),
    identity: IDENTITY,
    reaction: { timeoutMs: 40, quietMs: 10 },
    resultsWaitMs: 300
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

  it("rejects a link BENEATH a record, which is not a result for it", () => {
    // Taken verbatim from a live Lightning page. It parses to a valid
    // Opportunity id, and offering it would hand an agent an Opportunity
    // named "Products(4)" whose id belongs to another record's related
    // list. The canonical route from the pack's own template is what
    // separates a record's own page from somewhere beneath it.
    const candidates = candidatesOnPage(mountResults(), "Opportunity", IDENTITY, adapter());
    expect(candidates.map((c) => c.name)).not.toContain("Products(4)");
    expect(candidates).toHaveLength(2);
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

describe("the route shapes a live org actually emits", () => {
  it("reads a link that omits the object segment entirely", () => {
    // What a live Opportunity list view emitted:
    //   /lightning/r/0065w00002AZ0GeAAL/view
    // No object anywhere in it. Requiring one made every result invisible.
    document.body.innerHTML = `<a href="/lightning/r/${ACME_A}/view">PS Project Test</a>`;
    expect(candidatesOnPage(document.body, "Opportunity", IDENTITY, adapter())).toEqual([
      { id: ACME_A, name: "PS Project Test", entityType: "Opportunity" }
    ]);
  });

  it("types an objectless link from the identifier's own prefix", () => {
    // 006 is an Opportunity, 001 an Account. Without that, an objectless
    // link could not be filtered by entity at all.
    document.body.innerHTML = `
      <a href="/lightning/r/${ACME_A}/view">An Opportunity</a>
      <a href="/lightning/r/${ACCOUNT}/view">An Account</a>
    `;
    expect(candidatesOnPage(document.body, "Opportunity", IDENTITY, adapter()).map((c) => c.name)).toEqual([
      "An Opportunity"
    ]);
    expect(candidatesOnPage(document.body, "Account", IDENTITY, adapter()).map((c) => c.name)).toEqual([
      "An Account"
    ]);
  });

  it("reads both route shapes as the same record", async () => {
    const { identityFromPath } = await import("../src/binding/browserExecution/entityIdentity");
    // The record page carries the object; its own list link does not.
    expect(identityFromPath(`/lightning/r/Opportunity/${ACME_A}/view`, IDENTITY)?.id).toBe(ACME_A);
    expect(identityFromPath(`/lightning/r/${ACME_A}/view`, IDENTITY)?.id).toBe(ACME_A);
  });

  it("leaves the type unknown for an unrecognized prefix rather than guessing", async () => {
    const { identityFromPath } = await import("../src/binding/browserExecution/entityIdentity");
    // A custom object's prefix is assigned per org and is not declared.
    expect(identityFromPath("/lightning/r/a0X5w00000ABCDEFGH/view", IDENTITY)).toEqual({
      id: "a0X5w00000ABCDEFGH"
    });
  });
});

describe("a type filter excludes what it cannot type", () => {
  it("drops records whose prefix the platform does not declare", () => {
    // Straight from a live run: searching for "PS Project" returned six
    // candidates, four of which were not Opportunities — a custom object
    // and two undeclared prefixes. Every one passed an Opportunity filter
    // by having no known type, because matching on id alone is right for
    // comparing two references to one record and wrong for filtering.
    document.body.innerHTML = `
      <a href="/lightning/r/0065w00002AZ0GeAAL/view">PS Project Test - updated</a>
      <a href="/lightning/r/0005w00000A8bu1EAB/view">revVana Opportunity Revenue</a>
      <a href="/lightning/r/0Fb5w0000002aIwCAI/view">revVanaInsights</a>
      <a href="/lightning/r/a075w00000dzRAXAA2/view">PS Project Test</a>
      <a href="/lightning/r/a0A5w00000yIci8EAC/view">Project Forecast</a>
    `;
    const candidates = candidatesOnPage(document.body, "Opportunity", IDENTITY, adapter());
    expect(candidates.map((c) => c.id)).toEqual(["0065w00002AZ0GeAAL"]);
  });

  it("still finds every record of a type it does know", () => {
    document.body.innerHTML = `
      <a href="/lightning/r/${ACME_A}/view">One</a>
      <a href="/lightning/r/${ACME_B}/view">Two</a>
    `;
    expect(candidatesOnPage(document.body, "Opportunity", IDENTITY, adapter())).toHaveLength(2);
  });
});

describe("a result and a field of that result look alike, and are not", () => {
  /**
   * The live Salesforce results page, at the structure the probe reported:
   * the matched record's link sits in a row header and a card heading,
   * while its account and owner sit in grid cells and card list items.
   */
  function mountLiveResults(): HTMLElement {
    document.body.innerHTML = `
      <div class="slds-card">
        <h2 class="recordTitle"><a href="/lightning/r/${ACME_A}/view">PS Project Test - updated</a></h2>
        <ul class="slds-card__body">
          <li><div><a href="/lightning/r/${ACCOUNT}/view">A &amp; H Steel Ltd.</a></div></li>
          <li><div><a href="/lightning/r/0055w00000BtwefAAB/view">KRupa</a></div></li>
        </ul>
      </div>
      <table role="grid"><tbody>
        <tr>
          <th class="slds-cell-edit"><span><a href="/lightning/r/${ACME_A}/view">PS Project Test - updated</a></span></th>
          <td role="gridcell"><span><a href="/lightning/r/${ACCOUNT}/view">A &amp; H Steel Ltd.</a></span></td>
        </tr>
        <tr>
          <th class="slds-cell-edit"><span><a href="/lightning/r/${ACME_B}/view">Another Opportunity</a></span></th>
          <td role="gridcell"><span><a href="/lightning/r/0055w00000BtwefAAB/view">KRupa</a></span></td>
        </tr>
      </tbody></table>
    `;
    return document.body;
  }

  it("returns the records the rows are about, not their fields", () => {
    // Six record links, two results. The account and the owner are
    // properties of the matched Opportunity, and returning them invites an
    // agent to act on an Account it never searched for.
    const candidates = candidatesOnPage(mountLiveResults(), undefined, IDENTITY, adapter());
    expect(candidates.map((c) => c.id)).toEqual([ACME_A, ACME_B]);
    expect(candidates.some((c) => c.entityType === "Account")).toBe(false);
    expect(candidates.some((c) => c.entityType === "User")).toBe(false);
  });

  it("reads a card's heading and a row's header as the same kind of signal", () => {
    // Both are standard semantics — a heading titles its card, a row
    // header identifies its row — so neither is a platform special case.
    document.body.innerHTML = `
      <h3><a href="/lightning/r/${ACME_A}/view">From a heading</a></h3>
      <table role="grid"><tbody><tr>
        <th><a href="/lightning/r/${ACME_B}/view">From a row header</a></th>
        <td role="gridcell"><a href="/lightning/r/${ACCOUNT}/view">A field</a></td>
      </tr></tbody></table>
    `;
    expect(candidatesOnPage(document.body, undefined, IDENTITY, adapter()).map((c) => c.name)).toEqual([
      "From a heading",
      "From a row header"
    ]);
  });

  it("takes every link when the page marks nothing", () => {
    // No structure to reason from is not a reason to return nothing.
    document.body.innerHTML = `
      <div><a href="/lightning/r/${ACME_A}/view">One</a></div>
      <div><a href="/lightning/r/${ACME_B}/view">Two</a></div>
    `;
    expect(candidatesOnPage(document.body, undefined, IDENTITY, adapter())).toHaveLength(2);
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
      // Both Opportunities, plus the Account the page also offered — a
      // search returns what the application found, each labelled with what
      // it is, and leaves the choosing to the caller.
      const opportunities = outcome.candidates.filter((c) => c.entityType === "Opportunity");
      expect(opportunities.map((c) => c.name)).toEqual(["Acme Renewal", "Acme Renewal"]);
      expect(opportunities.map((c) => c.id)).toEqual([ACME_A, ACME_B]);
      expect(outcome.candidates.some((c) => c.entityType === "Account")).toBe(true);
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
      reaction: { timeoutMs: 40, quietMs: 10 },
      // A genuinely empty result is the only case that pays the full wait.
      resultsWaitMs: 50
    });
    expect(outcome.status).toBe("no-results");
    expect(outcome.candidates).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });
});

describe("results that arrive late are still found", () => {
  it("keeps looking until the application renders them", async () => {
    // The live failure this covers: reading once, immediately after
    // submitting, found an empty page and reported no matches while
    // Salesforce was still fetching. A settle signal is not the same as
    // results existing.
    document.body.innerHTML = `<label for="q">Search</label><input id="q" /><button id="go">Search</button>`;
    setTimeout(() => {
      const late = document.createElement("a");
      late.setAttribute("href", `/lightning/r/${ACME_A}/view`);
      late.textContent = "Arrived Late";
      document.body.appendChild(late);
    }, 250);

    const outcome = await executeQuery({
      root: document.body,
      binding: { ...BINDING, submit: undefined, submitKey: undefined },
      inputs: { name: "Acme" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 },
      resultsWaitMs: 3_000
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.candidates.map((c) => c.name)).toEqual(["Arrived Late"]);
  });
});

/* ===================== running the search ===================== */

describe("the search is performed through the application's own controls", () => {
  it("types the term, runs the search, and reads what came back", async () => {
    const outcome = await run({ name: "Acme Renewal" });
    expect((document.querySelector("#q") as HTMLInputElement).value).toBe("Acme Renewal");
    expect(document.querySelector("#results")?.getAttribute("data-searched")).toBe("true");
    expect(outcome.evidence.join(" ")).toMatch(/Typed "Acme Renewal"/);
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
      reaction: { timeoutMs: 40, quietMs: 10 },
      // A static fixture offers nothing new after searching, so it waits
      // the whole budget — which is the correct behaviour being asserted
      // elsewhere, and just needs to be short here.
      resultsWaitMs: 50
    });
    expect((document.querySelector("#acc") as HTMLInputElement).value).toBe("untouched");

    // Supplied: written.
    await executeQuery({
      root: document.body,
      binding: filtered,
      inputs: { name: "Acme", account_name: "Acme Corporation" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 },
      resultsWaitMs: 50
    });
    expect((document.querySelector("#acc") as HTMLInputElement).value).toBe("Acme Corporation");
  });
});

describe("what a search returns is the caller's to choose from", () => {
  it("returns every identifiable record, each labelled with what it is", () => {
    // The demonstration ended on an Opportunity, which does not establish
    // that Opportunities are all a caller wants: someone searching "Acme"
    // may well mean the Account. Discarding the rest would hide results
    // the application itself offered.
    const candidates = candidatesOnPage(mountResults(), undefined, IDENTITY, adapter());
    expect(new Set(candidates.map((c) => c.entityType))).toEqual(new Set(["Opportunity", "Account"]));
  });

  it("still drops what it cannot identify", () => {
    // An id with no type is not a usable handoff: a caller cannot tell
    // what it refers to, which is how a custom object's identifier reached
    // a list of Opportunities.
    document.body.innerHTML = `
      <a href="/lightning/r/${ACME_A}/view">Typed</a>
      <a href="/lightning/r/a0A5w00000yIci8EAC/view">Untypeable</a>
    `;
    expect(candidatesOnPage(document.body, undefined, IDENTITY, adapter()).map((c) => c.name)).toEqual(["Typed"]);
  });

  it("narrows when a type is explicitly asked for", () => {
    const only = candidatesOnPage(mountResults(), "Account", IDENTITY, adapter());
    expect(only.every((c) => c.entityType === "Account")).toBe(true);
  });
});

describe("results the page was already showing are not results", () => {
  it("waits for links the page was not offering before the search", async () => {
    // The live failure: a search run from an Opportunity record returned
    // that record's own account and owner. They were on screen the whole
    // time, and reading as soon as "some record link exists" found them
    // before the results page replaced them.
    document.body.innerHTML = `
      <label for="q">Search</label><input id="q" /><button id="go">Search</button>
      <div id="page">
        <h3><a href="/lightning/r/${ACCOUNT}/view">The account already on screen</a></h3>
      </div>
    `;
    setTimeout(() => {
      document.querySelector("#page")!.innerHTML =
        `<h3><a href="/lightning/r/${ACME_A}/view">An actual result</a></h3>`;
    }, 250);

    const outcome = await executeQuery({
      root: document.body,
      binding: { ...BINDING, submit: undefined, submitKey: undefined },
      inputs: { name: "Acme" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 },
      resultsWaitMs: 3_000
    });

    expect(outcome.candidates.map((c) => c.name)).toEqual(["An actual result"]);
  });
});

describe("a search that never ran returns nothing", () => {
  it("does not hand back the links that were already on the page", async () => {
    // The live failure this closes. Run from an Opportunity record, the
    // search never reached a results page, and after the wait expired the
    // record's own account and owner were returned as if they were
    // matches. Waiting alone was not enough: on timeout it still answered
    // with whatever happened to be there.
    document.body.innerHTML = `
      <label for="q">Search</label><input id="q" /><button id="go">Search</button>
      <h3><a href="/lightning/r/${ACCOUNT}/view">The account on this record</a></h3>
      <h3><a href="/lightning/r/0055w00000BtwefAAB/view">The owner of this record</a></h3>
    `;

    const outcome = await executeQuery({
      root: document.body,
      binding: { ...BINDING, submit: undefined, submitKey: undefined },
      inputs: { name: "PS" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 },
      resultsWaitMs: 100
    });

    expect(outcome.candidates).toEqual([]);
    expect(outcome.status).toBe("no-results");
  });
});

describe("searching twice for the same thing answers twice", () => {
  it("returns records that were already linked, when the application navigated", async () => {
    // The live failure: a second search from the results page returned
    // nothing, because everything it found had been on screen when it
    // started. Excluding pre-existing links is right only while the page
    // has not changed — once the application answers by navigating, the
    // page IS the answer.
    document.body.innerHTML = `
      <label for="q">Search</label><input id="q" /><button id="go">Search</button>
      <h3><a href="/lightning/r/${ACME_A}/view">Already showing</a></h3>
    `;
    window.history.pushState({}, "", "/one/one.app#firstSearch");
    document.querySelector("#go")!.addEventListener("click", () => {
      window.history.pushState({}, "", "/one/one.app#secondSearch");
    });

    const outcome = await executeQuery({
      root: document.body,
      binding: { ...BINDING, submit: { role: "button", label: "Search" }, submitKey: undefined },
      inputs: { name: "PS" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 },
      resultsWaitMs: 500
    });

    expect(outcome.candidates.map((c) => c.id)).toEqual([ACME_A]);
  });
});

describe("an application can answer without navigating", () => {
  it("reads results offered in a type-ahead listbox", async () => {
    // A live Salesforce search would not submit synthetically, and did not
    // need to: typing surfaced its matches in a listbox. An option IS the
    // thing it offers to select, exactly as a row header identifies its
    // row.
    document.body.innerHTML = `
      <label for="q">Search</label><input id="q" />
      <ul role="listbox">
        <li role="option"><a href="/lightning/r/${ACME_A}/view">PS Project Test - updated</a></li>
        <li role="option"><a href="/lightning/r/${ACCOUNT}/view">A &amp; H Steel Ltd.</a></li>
      </ul>
      <h3><a href="/lightning/r/${ACME_B}/view">Something else on the page</a></h3>
    `;
    const candidates = candidatesOnPage(document.body, undefined, IDENTITY, adapter());
    expect(candidates.map((c) => c.name)).toContain("PS Project Test - updated");
    expect(candidates.map((c) => c.entityType)).toContain("Account");
  });
});

describe("a list that filters in place is answering too", () => {
  it("returns the narrowed set, which is never anything new", async () => {
    // The structural flaw this closes. A list view already shows records,
    // and searching NARROWS it — the results are always a subset of what
    // was there, so "candidates that were not there before" is empty by
    // construction and the answer was discarded every time.
    document.body.innerHTML = `
      <label for="q">Search this list...</label><input id="q" /><button id="go">Go</button>
      <table role="grid"><tbody id="rows">
        <tr><th><a href="/lightning/r/${ACME_A}/view">PS Project Test</a></th></tr>
        <tr><th><a href="/lightning/r/${ACME_B}/view">Another Opportunity</a></th></tr>
        <tr><th><a href="/lightning/r/${ACCOUNT}/view">An Account</a></th></tr>
      </tbody></table>
    `;
    // Filtering removes rows; it never adds any.
    document.querySelector("#go")!.addEventListener("click", () => {
      document.querySelector("#rows")!.innerHTML =
        `<tr><th><a href="/lightning/r/${ACME_A}/view">PS Project Test</a></th></tr>`;
    });

    const outcome = await executeQuery({
      root: document.body,
      binding: {
        ...BINDING,
        query: { inputName: "name", semanticTarget: { role: "field", label: "Search this list..." } },
        open: undefined,
        submit: { role: "button", label: "Go" },
        submitKey: undefined
      },
      inputs: { name: "PS" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 },
      resultsWaitMs: 1_000
    });

    expect(outcome.candidates.map((c) => c.id)).toEqual([ACME_A]);
  });

  it("still returns nothing when the set never changed", async () => {
    // A search that did not run leaves the page exactly as it was, and
    // that is the one case where the records on screen are not an answer.
    document.body.innerHTML = `
      <label for="q">Search this list...</label><input id="q" />
      <table role="grid"><tbody>
        <tr><th><a href="/lightning/r/${ACME_A}/view">Untouched</a></th></tr>
      </tbody></table>
    `;
    const outcome = await executeQuery({
      root: document.body,
      binding: {
        ...BINDING,
        query: { inputName: "name", semanticTarget: { role: "field", label: "Search this list..." } },
        open: undefined,
        submit: undefined,
        submitKey: undefined
      },
      inputs: { name: "PS" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 },
      resultsWaitMs: 100
    });
    expect(outcome.candidates).toEqual([]);
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

/* ------------------------------------------------------------------ *
 * Pressing a key an application can actually recognise.
 *
 * A live search reported every step succeeding — opened, typed, Enter
 * pressed, page settled — and the address never changed. The key was
 * dispatched and ignored: `new KeyboardEvent()` leaves `keyCode` and
 * `which` at 0 however `key` is set, and frameworks predating `key` read
 * exactly those.
 * ------------------------------------------------------------------ */

describe("a synthetic key carries what the application reads", () => {
  it("sends the legacy identifiers alongside the modern ones", async () => {
    const { pressKey } = await import("../src/binding/browserExecution/engine");
    document.body.innerHTML = `<label for="q">Search</label><input id="q" />`;
    const seen: Array<{ type: string; key: string; keyCode: number; which: number }> = [];
    for (const type of ["keydown", "keypress", "keyup"]) {
      document.querySelector("#q")!.addEventListener(type, (event) => {
        const e = event as KeyboardEvent;
        seen.push({ type, key: e.key, keyCode: e.keyCode, which: e.which });
      });
    }

    await pressKey(document.body, { role: "field", label: "Search" }, "Enter", adapter(), {
      timeoutMs: 40,
      quietMs: 10
    });

    expect(seen.map((entry) => entry.type)).toEqual(["keydown", "keypress", "keyup"]);
    // The identifiers a framework that predates `key` reads.
    expect(seen.every((entry) => entry.keyCode === 13 && entry.which === 13)).toBe(true);
    expect(seen.every((entry) => entry.key === "Enter")).toBe(true);
  });

  it("presses the control a person would type into, not the wrapper around it", async () => {
    const { pressKey } = await import("../src/binding/browserExecution/engine");
    // A component host does not listen for keys; its input does.
    document.body.innerHTML = `
      <div role="textbox" aria-label="Search" id="host"><input id="inner" /></div>
    `;
    let onInner = 0;
    document.querySelector("#inner")!.addEventListener("keydown", () => (onInner += 1));

    await pressKey(document.body, { role: "field", label: "Search" }, "Enter", adapter(), {
      timeoutMs: 40,
      quietMs: 10
    });
    expect(onInner).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Typing, as opposed to writing.
 *
 * A live search showed the term sitting in the box while the component
 * believed the field was empty: the value had been set directly, and a
 * framework that keeps its own state updates it from key events. Pressing
 * Enter then searched for nothing.
 * ------------------------------------------------------------------ */

describe("a search term is typed the way a person types it", () => {
  it("emits key events per character, so a component can follow along", async () => {
    const { typeText } = await import("../src/binding/browserExecution/engine");
    document.body.innerHTML = `<label for="q">Search</label><input id="q" />`;
    const input = document.querySelector("#q") as HTMLInputElement;

    // What a component listening for keys would see.
    const observed: string[] = [];
    input.addEventListener("input", () => observed.push(input.value));

    const result = await typeText(document.body, { role: "field", label: "Search" }, "Acme", adapter());

    expect(result.ok).toBe(true);
    expect(input.value).toBe("Acme");
    // Cleared first, then built up one character at a time.
    expect(observed).toEqual(["", "A", "Ac", "Acm", "Acme"]);
  });

  it("types into the control inside a component host", async () => {
    const { typeText } = await import("../src/binding/browserExecution/engine");
    document.body.innerHTML = `<div role="textbox" aria-label="Search"><input id="inner" /></div>`;
    await typeText(document.body, { role: "field", label: "Search" }, "PS", adapter());
    expect((document.querySelector("#inner") as HTMLInputElement).value).toBe("PS");
  });

  it("refuses a control that text cannot be typed into", async () => {
    const { typeText } = await import("../src/binding/browserExecution/engine");
    document.body.innerHTML = `<div role="button" aria-label="Search">Search</div>`;
    const result = await typeText(document.body, { role: "button", label: "Search" }, "PS", adapter());
    expect(result.ok).toBe(false);
  });
});

describe("a search input has an event of its own", () => {
  it("fires `search` when Enter is pressed in input[type=search]", async () => {
    const { pressKey } = await import("../src/binding/browserExecution/engine");
    // Browsers fire this natively on Enter, and an application listening
    // for it never hears the key sequence — which left a live list
    // unfiltered while every keystroke arrived correctly.
    document.body.innerHTML = `<label for="q">Search this list...</label><input id="q" type="search" />`;
    let fired = 0;
    document.querySelector("#q")!.addEventListener("search", () => (fired += 1));

    await pressKey(document.body, { role: "field", label: "Search this list..." }, "Enter", adapter(), {
      timeoutMs: 40,
      quietMs: 10
    });
    expect(fired).toBe(1);
  });

  it("fires it only for a search input, and only for Enter", async () => {
    const { pressKey } = await import("../src/binding/browserExecution/engine");
    document.body.innerHTML = `<label for="q">Plain</label><input id="q" type="text" />`;
    let fired = 0;
    document.querySelector("#q")!.addEventListener("search", () => (fired += 1));
    await pressKey(document.body, { role: "field", label: "Plain" }, "Enter", adapter(), {
      timeoutMs: 40,
      quietMs: 10
    });
    expect(fired).toBe(0);
  });
});

describe("a component library may listen for its own signal, not for keys", () => {
  it("fires Lightning's commit event, which reaches a listener on the host", async () => {
    const { pressKey } = await import("../src/binding/browserExecution/engine");
    // `lightning-input` consumes the key sequence and re-emits `commit`.
    // A synthetic Enter is otherwise delivered flawlessly and means
    // nothing, which is what left a live list-view search unperformed.
    document.body.innerHTML = `
      <lightning-input id="host"><label for="q">Search this list...</label><input id="q" type="search" /></lightning-input>
    `;
    let committed = 0;
    document.querySelector("#host")!.addEventListener("commit", () => (committed += 1));

    const result = await pressKey(
      document.body,
      { role: "field", label: "Search this list..." },
      "Enter",
      adapter(),
      { timeoutMs: 40, quietMs: 10 }
    );

    expect(committed).toBe(1);
    expect(result.detail).toMatch(/commit/);
  });

  it("does not fire it for a control that is not a Lightning input", async () => {
    const { pressKey } = await import("../src/binding/browserExecution/engine");
    document.body.innerHTML = `<label for="q">Plain</label><input id="q" />`;
    let committed = 0;
    document.querySelector("#q")!.addEventListener("commit", () => (committed += 1));
    await pressKey(document.body, { role: "field", label: "Plain" }, "Enter", adapter(), {
      timeoutMs: 40,
      quietMs: 10
    });
    expect(committed).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The term is what tells a match from a bystander.
 *
 * A live list was already filtered to "PS" from an earlier search, so the
 * set did not change and change detection discarded the correct result
 * sitting in plain sight. The same detection had earlier returned a
 * record's account and owner from an unrelated page. Neither is about
 * change; both are about whether the records answer the term.
 * ------------------------------------------------------------------ */

describe("an unchanged page can still be showing the answer", () => {
  const run = (term: string) =>
    executeQuery({
      root: document.body,
      binding: {
        ...BINDING,
        query: { inputName: "name", semanticTarget: { role: "field", label: "Search this list..." } },
        open: undefined,
        submit: undefined,
        submitKey: undefined
      },
      inputs: { name: term },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 },
      resultsWaitMs: 100
    });

  it("returns a record already on screen whose name answers the term", async () => {
    // Exactly the live case: the list was left filtered by a previous
    // search, so nothing changed and the answer was already there.
    document.body.innerHTML = `
      <label for="q">Search this list...</label><input id="q" type="search" />
      <table role="grid"><tbody><tr>
        <th><a href="/lightning/r/${ACME_A}/view">PS Project Test - updated</a></th>
      </tr></tbody></table>
    `;
    const outcome = await run("PS");
    expect(outcome.candidates.map((c) => c.id)).toEqual([ACME_A]);
  });

  it("still ignores records that have nothing to do with the term", async () => {
    // A record page's own account and owner, which is what an unchanged
    // page looked like the first time this went wrong.
    document.body.innerHTML = `
      <label for="q">Search this list...</label><input id="q" type="search" />
      <h3><a href="/lightning/r/${ACCOUNT}/view">A &amp; H Steel Ltd.</a></h3>
      <h3><a href="/lightning/r/0055w00000BtwefAAB/view">Kaushik Ruparel</a></h3>
    `;
    const outcome = await run("PS");
    expect(outcome.candidates).toEqual([]);
  });

  it("does not filter what the application actively produced", async () => {
    // When the page answers, its answer stands whole — a platform can
    // match on a field that never appears in a record's name.
    document.body.innerHTML = `
      <label for="q">Search this list...</label><input id="q" type="search" /><button id="go">Go</button>
    `;
    document.querySelector("#go")!.addEventListener("click", () => {
      const row = document.createElement("h3");
      row.innerHTML = `<a href="/lightning/r/${ACME_B}/view">Renewal 2027</a>`;
      document.body.appendChild(row);
    });

    const outcome = await executeQuery({
      root: document.body,
      binding: {
        ...BINDING,
        query: { inputName: "name", semanticTarget: { role: "field", label: "Search this list..." } },
        open: undefined,
        submit: { role: "button", label: "Go" },
        submitKey: undefined
      },
      inputs: { name: "Acme" },
      adapter: adapter(),
      identity: IDENTITY,
      reaction: { timeoutMs: 40, quietMs: 10 },
      resultsWaitMs: 1_000
    });
    expect(outcome.candidates.map((c) => c.name)).toEqual(["Renewal 2027"]);
  });
});
