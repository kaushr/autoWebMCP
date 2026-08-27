/**
 * Hash routing.
 *
 * The site is one document with real URL changes. That matters for Teach Mode:
 * the recorder polls `location.href` to emit navigation evidence, but a full
 * document load would tear down the content script mid-session.
 */

export interface ContactFilters {
  function?: string;
  seniority?: string;
  titleKeywords?: string;
}

export type Route =
  | { view: "search"; query: string }
  | { view: "company"; companyId: string; filters: ContactFilters }
  | { view: "contact"; contactId: string }
  | { view: "not-found"; path: string };

function split(hash: string): { path: string; params: URLSearchParams } {
  const raw = hash.replace(/^#/, "") || "/";
  const separator = raw.indexOf("?");
  return separator === -1
    ? { path: raw, params: new URLSearchParams() }
    : { path: raw.slice(0, separator), params: new URLSearchParams(raw.slice(separator + 1)) };
}

function trimmed(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value : undefined;
}

export function parseRoute(hash: string): Route {
  const { path, params } = split(hash);
  const segments = path.split("/").filter(Boolean);

  if (segments.length === 0) {
    return { view: "search", query: trimmed(params, "q") ?? "" };
  }

  if (segments[0] === "company" && segments[1]) {
    return {
      view: "company",
      companyId: decodeURIComponent(segments[1]),
      filters: {
        function: trimmed(params, "function"),
        seniority: trimmed(params, "seniority"),
        titleKeywords: trimmed(params, "title")
      }
    };
  }

  if (segments[0] === "contact" && segments[1]) {
    return { view: "contact", contactId: decodeURIComponent(segments[1]) };
  }

  return { view: "not-found", path };
}

function withParams(path: string, entries: Array<[string, string | undefined]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value && value.trim()) params.set(key, value.trim());
  }
  const query = params.toString();
  return query ? `#${path}?${query}` : `#${path}`;
}

export function searchHref(query: string): string {
  return withParams("/", [["q", query]]);
}

export function companyHref(companyId: string, filters: ContactFilters = {}): string {
  return withParams(`/company/${encodeURIComponent(companyId)}`, [
    ["function", filters.function],
    ["seniority", filters.seniority],
    ["title", filters.titleKeywords]
  ]);
}

export function contactHref(contactId: string): string {
  return withParams(`/contact/${encodeURIComponent(contactId)}`, []);
}

export function hasActiveFilters(filters: ContactFilters): boolean {
  return Boolean(filters.function || filters.seniority || filters.titleKeywords);
}
