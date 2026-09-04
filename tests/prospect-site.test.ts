import { describe, expect, it } from "vitest";
import { companyHref, contactHref, parseRoute, searchHref } from "../src/prospect/app/router";
import { renderRoute, renderShell } from "../src/prospect/app/views";
import { describeReadiness } from "../src/prospect/app/agentReadiness";

describe("SignalBase routing", () => {
  it("treats an empty hash as company search", () => {
    expect(parseRoute("")).toEqual({ view: "search", query: "" });
    expect(parseRoute("#/")).toEqual({ view: "search", query: "" });
    expect(parseRoute("#/?q=Tesla")).toEqual({ view: "search", query: "Tesla" });
  });

  it("parses a company route with contact filters", () => {
    expect(parseRoute("#/company/tesla?function=Procurement&seniority=VP&title=vp%20procurement")).toEqual({
      view: "company",
      companyId: "tesla",
      filters: { function: "Procurement", seniority: "VP", titleKeywords: "vp procurement" }
    });
  });

  it("omits blank filters rather than carrying empty values", () => {
    expect(parseRoute("#/company/tesla?function=&seniority=VP")).toEqual({
      view: "company",
      companyId: "tesla",
      filters: { function: undefined, seniority: "VP", titleKeywords: undefined }
    });
    expect(companyHref("tesla", { function: "", seniority: "VP" })).toBe("#/company/tesla?seniority=VP");
  });

  it("round-trips every route through its href builder", () => {
    expect(parseRoute(searchHref("Tesla"))).toEqual({ view: "search", query: "Tesla" });
    expect(parseRoute(contactHref("contact-tesla-01"))).toEqual({
      view: "contact",
      contactId: "contact-tesla-01"
    });
    expect(parseRoute(companyHref("tesla", { function: "Procurement" }))).toEqual({
      view: "company",
      companyId: "tesla",
      filters: { function: "Procurement", seniority: undefined, titleKeywords: undefined }
    });
  });

  it("reports unknown paths instead of guessing a view", () => {
    expect(parseRoute("#/opportunities/42")).toEqual({ view: "not-found", path: "/opportunities/42" });
  });
});

describe("SignalBase views", () => {
  it("renders company search results as links into the company route", () => {
    const html = renderRoute({ view: "search", query: "Tesla" });
    expect(html).toContain('href="#/company/tesla"');
    expect(html).toContain("Tesla Motors");
    expect(html).toContain("1 company");
  });

  it("narrows the contact list and reports the visible count as the filters tighten", () => {
    const all = renderRoute({ view: "company", companyId: "tesla", filters: {} });
    expect(all).toContain("Showing 8 of 8 contacts");

    const procurement = renderRoute({
      view: "company",
      companyId: "tesla",
      filters: { function: "Procurement" }
    });
    expect(procurement).toContain("Showing 3 of 8 contacts");
    expect(procurement).toContain("Maya Chen");
    expect(procurement).not.toContain("Elena Garcia");

    const executive = renderRoute({
      view: "company",
      companyId: "tesla",
      filters: { function: "Procurement", seniority: "VP" }
    });
    expect(executive).toContain("Showing 1 of 8 contacts");
    expect(executive).toContain('href="#/contact/contact-tesla-01"');
  });

  it("marks the selected facet values so state is readable from the DOM", () => {
    const html = renderRoute({ view: "company", companyId: "tesla", filters: { seniority: "VP" } });
    expect(html).toContain('<option value="VP" selected>VP</option>');
    expect(html).toContain('<option value="Procurement">Procurement</option>');
  });

  it("gives the recorder labelled controls and a live result count", () => {
    const html = renderRoute({ view: "company", companyId: "tesla", filters: {} });
    expect(html).toContain('<label for="filter-function">Function</label>');
    expect(html).toContain('<label for="filter-seniority">Seniority</label>');
    expect(html).toContain('<select id="filter-function" name="function">');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-labelledby="contacts-heading"');
  });

  it("renders the contact detail an agent would read", () => {
    const html = renderRoute({ view: "contact", contactId: "contact-tesla-01" });
    expect(html).toContain("Maya Chen");
    expect(html).toContain("VP Procurement");
    expect(html).toContain("maya.chen@teslamotors.example");
    expect(html).toContain("Columbus, OH");
    expect(html).toContain('href="#/company/tesla"');
  });

  it("does not invent records for unknown identifiers", () => {
    expect(renderRoute({ view: "company", companyId: "nope", filters: {} })).toContain("Nothing here");
    expect(renderRoute({ view: "contact", contactId: "nope" })).toContain("Nothing here");
  });

  it("escapes user-controlled search text", () => {
    const html = renderRoute({ view: "search", query: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("shows agent readiness in the shell", () => {
    expect(renderShell("<p></p>", describeReadiness({ webmcpAvailable: false, publishedNames: [] }))).toContain(
      "WebMCP unavailable in this browser"
    );
    expect(renderShell("<p></p>", describeReadiness({ webmcpAvailable: true, publishedNames: [] }))).toContain(
      "Agent capabilities: Not published"
    );

    const published = renderShell(
      "<p></p>",
      describeReadiness({ webmcpAvailable: true, publishedNames: ["Find Relevant Contacts"] })
    );
    expect(published).toContain("Agent capabilities: 1 published");
    expect(published).toContain("Find Relevant Contacts");
  });

  /* ---------------------------------------------------------------- *
   * The badge expands into the contract behind it.
   *
   * An agent chooses a tool from its description and calls it from its
   * schema, so a panel headed "what an agent sees" has to show both. And
   * it has to say where the list came from: `getTools()` is the browser's
   * answer about what an agent can discover, while this document's own
   * registry is only evidence that registration was attempted.
   * ---------------------------------------------------------------- */
  it("expands the badge into the tool exactly as an agent receives it", () => {
    const html = renderShell(
      "<p></p>",
      describeReadiness({
        webmcpAvailable: true,
        publishedNames: ["Find decision-maker contacts"],
        toolSource: "discovered",
        tools: [
          {
            name: "find_decision_maker_contacts",
            description: "Locate likely stakeholders at a target company.",
            inputSchema: {
              type: "object",
              properties: { company: { type: "string", description: "The company." } },
              required: ["company"],
              additionalProperties: false
            }
          }
        ]
      })
    );

    expect(html).toContain("<details");
    expect(html).toContain("What an agent sees");
    expect(html).toContain("find_decision_maker_contacts");
    expect(html).toContain("Locate likely stakeholders at a target company.");
    expect(html).toContain("&quot;company&quot;");
    expect(html).toContain("getTools()");
  });

  it("says a listing is registration evidence when the browser cannot be asked", () => {
    const html = renderShell(
      "<p></p>",
      describeReadiness({
        webmcpAvailable: true,
        publishedNames: ["Find decision-maker contacts"],
        toolSource: "registered",
        tools: [{ name: "find_decision_maker_contacts", description: "" }]
      })
    );
    expect(html).toContain("not of agent-side discovery");
    expect(html).toContain("This browser published no input schema for it.");
  });

  it("says an unpublished tool is still callable here until the page reloads", () => {
    // WebMCP has no unregister. Quietly dropping it from the count would
    // describe a tool surface that does not exist — and a demo that starts
    // from "SignalBase exposes nothing" needs to know a reload is the fix.
    const html = renderShell(
      "<p></p>",
      describeReadiness({
        webmcpAvailable: true,
        publishedNames: ["Find decision-maker contacts"],
        toolSource: "discovered",
        tools: [{ name: "find_decision_maker_contacts", description: "Locate stakeholders." }],
        staleNames: ["find_decision_maker_contacts"]
      })
    );
    expect(html).toContain("no longer published");
    expect(html).toContain("until the page is reloaded");
    // Still counted, because it is still there.
    expect(html).toContain("Agent capabilities: 1 published");
  });

  it("offers removal inside the panel, and asks twice", () => {
    // The control lives in the disclosure, never in the site's own chrome:
    // SignalBase has to read as an ordinary business site until someone
    // opens the badge.
    const readiness = {
      webmcpAvailable: true,
      publishedNames: ["Find decision-maker contacts"],
      toolSource: "discovered" as const,
      tools: [{ name: "find_decision_maker_contacts", description: "Locate stakeholders." }]
    };

    const idle = renderShell("<p></p>", describeReadiness(readiness));
    expect(idle).toContain('data-remove-capability="find_decision_maker_contacts"');
    expect(idle).toContain("Unpublish and reload");
    expect(idle).not.toContain("confirm");

    const armed = renderShell(
      "<p></p>",
      describeReadiness({ ...readiness, removalArmed: "find_decision_maker_contacts" })
    );
    expect(armed).toContain("Unpublish and reload — confirm");
    // Says what it actually does: the control plane is shared, and the
    // reload is the removal rather than tidying up after it.
    expect(armed).toContain("removes it from the control plane for every site");
    expect(armed.replace(/\s+/g, " ")).toContain("WebMCP has no unregister, so this page reloads");
  });

  it("stays a plain badge when there is nothing to expand", () => {
    // A disclosure control that opens onto an empty panel is worse than none.
    const unpublished = renderShell("<p></p>", describeReadiness({ webmcpAvailable: true, publishedNames: [] }));
    expect(unpublished).not.toContain("<details");

    // And a browser with no WebMCP has nothing an agent could receive,
    // whatever this document tried to register.
    const unsupported = renderShell(
      "<p></p>",
      describeReadiness({
        webmcpAvailable: false,
        publishedNames: ["Find decision-maker contacts"],
        tools: [{ name: "find_decision_maker_contacts", description: "" }]
      })
    );
    expect(unsupported).not.toContain("<details");
  });
});
