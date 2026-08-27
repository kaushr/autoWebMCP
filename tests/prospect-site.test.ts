import { describe, expect, it } from "vitest";
import { companyHref, contactHref, parseRoute, searchHref } from "../src/prospect/app/router";
import { renderRoute, renderShell } from "../src/prospect/app/views";
import { describeReadiness } from "../src/prospect/app/agentReadiness";

describe("SignalBase routing", () => {
  it("treats an empty hash as company search", () => {
    expect(parseRoute("")).toEqual({ view: "search", query: "" });
    expect(parseRoute("#/")).toEqual({ view: "search", query: "" });
    expect(parseRoute("#/?q=Acme")).toEqual({ view: "search", query: "Acme" });
  });

  it("parses a company route with contact filters", () => {
    expect(parseRoute("#/company/acme?function=Procurement&seniority=VP&title=vp%20procurement")).toEqual({
      view: "company",
      companyId: "acme",
      filters: { function: "Procurement", seniority: "VP", titleKeywords: "vp procurement" }
    });
  });

  it("omits blank filters rather than carrying empty values", () => {
    expect(parseRoute("#/company/acme?function=&seniority=VP")).toEqual({
      view: "company",
      companyId: "acme",
      filters: { function: undefined, seniority: "VP", titleKeywords: undefined }
    });
    expect(companyHref("acme", { function: "", seniority: "VP" })).toBe("#/company/acme?seniority=VP");
  });

  it("round-trips every route through its href builder", () => {
    expect(parseRoute(searchHref("Acme"))).toEqual({ view: "search", query: "Acme" });
    expect(parseRoute(contactHref("contact-acme-01"))).toEqual({
      view: "contact",
      contactId: "contact-acme-01"
    });
    expect(parseRoute(companyHref("acme", { function: "Procurement" }))).toEqual({
      view: "company",
      companyId: "acme",
      filters: { function: "Procurement", seniority: undefined, titleKeywords: undefined }
    });
  });

  it("reports unknown paths instead of guessing a view", () => {
    expect(parseRoute("#/opportunities/42")).toEqual({ view: "not-found", path: "/opportunities/42" });
  });
});

describe("SignalBase views", () => {
  it("renders company search results as links into the company route", () => {
    const html = renderRoute({ view: "search", query: "Acme" });
    expect(html).toContain('href="#/company/acme"');
    expect(html).toContain("Acme Industrial");
    expect(html).toContain("1 company");
  });

  it("narrows the contact list and reports the visible count as the filters tighten", () => {
    const all = renderRoute({ view: "company", companyId: "acme", filters: {} });
    expect(all).toContain("Showing 8 of 8 contacts");

    const procurement = renderRoute({
      view: "company",
      companyId: "acme",
      filters: { function: "Procurement" }
    });
    expect(procurement).toContain("Showing 3 of 8 contacts");
    expect(procurement).toContain("Maya Chen");
    expect(procurement).not.toContain("Elena Garcia");

    const executive = renderRoute({
      view: "company",
      companyId: "acme",
      filters: { function: "Procurement", seniority: "VP" }
    });
    expect(executive).toContain("Showing 1 of 8 contacts");
    expect(executive).toContain('href="#/contact/contact-acme-01"');
  });

  it("marks the selected facet values so state is readable from the DOM", () => {
    const html = renderRoute({ view: "company", companyId: "acme", filters: { seniority: "VP" } });
    expect(html).toContain('<option value="VP" selected>VP</option>');
    expect(html).toContain('<option value="Procurement">Procurement</option>');
  });

  it("gives the recorder labelled controls and a live result count", () => {
    const html = renderRoute({ view: "company", companyId: "acme", filters: {} });
    expect(html).toContain('<label for="filter-function">Function</label>');
    expect(html).toContain('<label for="filter-seniority">Seniority</label>');
    expect(html).toContain('<select id="filter-function" name="function">');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-labelledby="contacts-heading"');
  });

  it("renders the contact detail an agent would read", () => {
    const html = renderRoute({ view: "contact", contactId: "contact-acme-01" });
    expect(html).toContain("Maya Chen");
    expect(html).toContain("VP Procurement");
    expect(html).toContain("maya.chen@acmeindustrial.example");
    expect(html).toContain("Columbus, OH");
    expect(html).toContain('href="#/company/acme"');
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
});
