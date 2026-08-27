import {
  CONTACT_FUNCTIONS,
  SENIORITIES,
  companies,
  contacts as allContacts,
  formatEmployeeCount,
  type Company,
  type Contact
} from "../data";
import { countContacts, featuredCompanies, findContacts, getCompany, getContact, searchCompanies } from "../service";
import { companyHref, contactHref, hasActiveFilters, searchHref, type ContactFilters, type Route } from "./router";

/** One constant so the working name is trivial to change. */
export const APP_NAME = "SignalBase";
export const APP_TAGLINE = "Prospect intelligence for account teams";

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character
  );
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function breadcrumb(trail: Array<{ label: string; href?: string }>): string {
  const items = trail
    .map((entry, index) => {
      const isLast = index === trail.length - 1;
      const content = entry.href && !isLast
        ? `<a href="${entry.href}">${escapeHtml(entry.label)}</a>`
        : `<span${isLast ? ' aria-current="page"' : ""}>${escapeHtml(entry.label)}</span>`;
      return `<li>${content}</li>`;
    })
    .join("");
  return `<nav class="breadcrumb" aria-label="Breadcrumb"><ol>${items}</ol></nav>`;
}

function companyCard(company: Company): string {
  return `<li>
    <div class="card company-card">
      <h3><a href="${companyHref(company.id)}">${escapeHtml(company.name)}</a></h3>
      <p class="card-meta">${escapeHtml(company.industry)} · ${escapeHtml(
        formatEmployeeCount(company.employeeCount)
      )} employees · ${escapeHtml(company.headquarters)}</p>
      <p class="card-body">${escapeHtml(company.description)}</p>
      <p class="card-footer">${plural(countContacts(company.id), "mapped contact")}</p>
    </div>
  </li>`;
}

function contactRow(contact: Contact): string {
  return `<li>
    <div class="card contact-card">
      <h3><a href="${contactHref(contact.id)}">${escapeHtml(contact.name)}</a></h3>
      <p class="card-meta">${escapeHtml(contact.title)}</p>
      <p class="badges">
        <span class="badge badge-function">${escapeHtml(contact.function)}</span>
        <span class="badge">${escapeHtml(contact.seniority)}</span>
        <span class="badge badge-quiet">${escapeHtml(contact.location)}</span>
      </p>
    </div>
  </li>`;
}

function options(values: readonly string[], selected: string | undefined, allLabel: string): string {
  const head = `<option value="">${escapeHtml(allLabel)}</option>`;
  return (
    head +
    values
      .map(
        (value) =>
          `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`
      )
      .join("")
  );
}

function searchView(query: string): string {
  const trimmed = query.trim();
  const results = trimmed ? searchCompanies(trimmed) : featuredCompanies();
  const heading = trimmed ? `Results for “${escapeHtml(trimmed)}”` : "Recently viewed accounts";

  const list = results.length
    ? `<ul class="card-list">${results.map(companyCard).join("")}</ul>`
    : `<p class="empty">No companies match that search. Try an account name such as “Acme”, or an industry such as “Logistics”.</p>`;

  return `
    <section class="hero" aria-labelledby="search-heading">
      <h1 id="search-heading">Find the person who can move the deal.</h1>
      <p class="lede">Search ${plural(companies.length, "account")} and ${plural(
        allContacts.length,
        "mapped contact"
      )}, then narrow by function and seniority.</p>
      <form id="company-search" class="search-form" role="search">
        <label for="company-query">Company name, domain, or industry</label>
        <div class="search-row">
          <input
            id="company-query"
            name="q"
            type="search"
            value="${escapeHtml(trimmed)}"
            placeholder="e.g. Acme"
            autocomplete="off"
            spellcheck="false"
          />
          <button type="submit">Search companies</button>
        </div>
      </form>
    </section>

    <section class="results" aria-labelledby="company-results-heading">
      <div class="results-heading">
        <h2 id="company-results-heading">${heading}</h2>
        <p class="count" aria-live="polite"><output form="company-search" name="company-count">${plural(
          results.length,
          "company",
          "companies"
        )}</output></p>
      </div>
      ${list}
    </section>`;
}

function companyView(companyId: string, filters: ContactFilters): string {
  const company = getCompany(companyId);
  if (!company) return notFoundView(`company ${companyId}`);

  const total = countContacts(company.id);
  const results = findContacts({
    company_id: company.id,
    function: filters.function,
    seniority: filters.seniority,
    title_keywords: filters.titleKeywords
  });

  const list = results.length
    ? `<ul class="card-list contact-list">${results.map(contactRow).join("")}</ul>`
    : `<p class="empty">No contacts at ${escapeHtml(company.name)} match these filters.</p>`;

  return `
    ${breadcrumb([{ label: "Companies", href: searchHref("") }, { label: company.name }])}

    <section class="company-header" aria-labelledby="company-heading">
      <h1 id="company-heading">${escapeHtml(company.name)}</h1>
      <p class="lede">${escapeHtml(company.description)}</p>
      <dl class="facts">
        <div><dt>Industry</dt><dd>${escapeHtml(company.industry)}</dd></div>
        <div><dt>Employees</dt><dd>${escapeHtml(formatEmployeeCount(company.employeeCount))}</dd></div>
        <div><dt>Headquarters</dt><dd>${escapeHtml(company.headquarters)}</dd></div>
        <div><dt>Domain</dt><dd>${escapeHtml(company.domain)}</dd></div>
      </dl>
    </section>

    <section class="results" aria-labelledby="contacts-heading">
      <div class="results-heading">
        <h2 id="contacts-heading">Contacts</h2>
        <p class="count" aria-live="polite"><output id="contact-count" form="contact-filters">Showing ${
          results.length
        } of ${plural(total, "contact")}</output></p>
      </div>

      <form id="contact-filters" class="filter-form" aria-label="Filter contacts">
        <div class="field">
          <label for="filter-function">Function</label>
          <select id="filter-function" name="function">${options(
            CONTACT_FUNCTIONS,
            filters.function,
            "All functions"
          )}</select>
        </div>
        <div class="field">
          <label for="filter-seniority">Seniority</label>
          <select id="filter-seniority" name="seniority">${options(
            SENIORITIES,
            filters.seniority,
            "All seniority levels"
          )}</select>
        </div>
        <div class="field">
          <label for="filter-title">Title contains</label>
          <input id="filter-title" name="title" type="text" value="${escapeHtml(
            filters.titleKeywords ?? ""
          )}" placeholder="e.g. procurement" autocomplete="off" />
        </div>
        <div class="field field-actions">
          <button type="submit">Apply filters</button>
          ${
            hasActiveFilters(filters)
              ? `<a class="link-button" id="clear-filters" href="${companyHref(company.id)}">Clear filters</a>`
              : ""
          }
        </div>
      </form>

      ${list}
    </section>`;
}

function contactView(contactId: string): string {
  const contact = getContact(contactId);
  if (!contact) return notFoundView(`contact ${contactId}`);
  const company = getCompany(contact.companyId);

  return `
    ${breadcrumb([
      { label: "Companies", href: searchHref("") },
      { label: company?.name ?? contact.companyId, href: companyHref(contact.companyId) },
      { label: contact.name }
    ])}

    <article class="contact-detail" aria-labelledby="contact-heading">
      <h1 id="contact-heading">${escapeHtml(contact.name)}</h1>
      <p class="lede">${escapeHtml(contact.title)}${
        company ? ` · <a href="${companyHref(company.id)}">${escapeHtml(company.name)}</a>` : ""
      }</p>

      <dl class="facts">
        <div><dt>Function</dt><dd>${escapeHtml(contact.function)}</dd></div>
        <div><dt>Seniority</dt><dd>${escapeHtml(contact.seniority)}</dd></div>
        <div><dt>Location</dt><dd>${escapeHtml(contact.location)}</dd></div>
        <div><dt>Email</dt><dd><a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(
          contact.email
        )}</a></dd></div>
        <div><dt>Phone</dt><dd>${escapeHtml(contact.phone)}</dd></div>
      </dl>

      <section aria-labelledby="responsibility-heading">
        <h2 id="responsibility-heading">Role and responsibility</h2>
        <p>${escapeHtml(contact.responsibilitySummary)}</p>
      </section>
    </article>`;
}

function notFoundView(what: string): string {
  return `
    <section class="results" aria-labelledby="not-found-heading">
      <h1 id="not-found-heading">Nothing here</h1>
      <p class="empty">We could not find ${escapeHtml(what)}.</p>
      <p><a href="${searchHref("")}">Back to company search</a></p>
    </section>`;
}

export function renderRoute(route: Route): string {
  switch (route.view) {
    case "search":
      return searchView(route.query);
    case "company":
      return companyView(route.companyId, route.filters);
    case "contact":
      return contactView(route.contactId);
    case "not-found":
      return notFoundView(route.path);
  }
}

export function renderShell(body: string, webmcpStatus: string): string {
  return `
    <header class="topbar">
      <a class="brand" href="${searchHref("")}" aria-label="${escapeHtml(APP_NAME)} home">
        <span class="brand-mark" aria-hidden="true">◆</span>
        <span class="brand-name">${escapeHtml(APP_NAME)}</span>
      </a>
      <p class="tagline">${escapeHtml(APP_TAGLINE)}</p>
      <p class="webmcp-status" data-status="${escapeHtml(webmcpStatus)}">
        <span class="dot" aria-hidden="true"></span>
        WebMCP ${webmcpStatus === "registered" ? "tools registered" : "unavailable in this browser"}
      </p>
    </header>
    <main id="content">${body}</main>
    <footer class="sitefoot">
      <p>${escapeHtml(APP_NAME)} is a controlled demo application with synthetic data. No real people or companies are represented.</p>
    </footer>`;
}
