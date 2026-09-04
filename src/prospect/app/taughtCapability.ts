import { parsePublicationList, type PublicationRecord } from "../../webmcp/publication";

/* ------------------------------------------------------------------ *
 * The result of a real teaching session, shipped as a file.
 *
 * Only for a copy of this site served without a control plane behind it,
 * which is what a static deployment is. There the publish endpoint 404s,
 * so a visitor can read the site but has no way to see what a published
 * capability looks like on an agent's tool surface.
 *
 * It is an EXPORT, not a fixture written by hand: the same record the
 * control plane stored when a human taught this workflow and confirmed
 * the contract, provenance and observation ids intact. It goes through
 * the same parser and the same registration path as anything the control
 * plane serves, so nothing here is a second way to publish.
 *
 * Deliberately NOT registered on load. The site starting with no agent
 * capability is the demonstration, not an inconvenience to route around,
 * so this is offered and a person presses the button — the hosted stand-in
 * for pressing Publish in the Studio.
 * ------------------------------------------------------------------ */

/** Where the export is served from. Same origin, so a static host is enough. */
const TAUGHT_CAPABILITY_URL = "/taught-capability.json";

/**
 * The capability a human already taught this site, or nothing.
 *
 * Every failure is the same answer: there is nothing to offer. A missing
 * file is the normal case when running locally, where the control plane
 * is the real source and this path is never needed.
 */
export async function loadTaughtCapability(
  fetchImpl: typeof fetch = fetch
): Promise<PublicationRecord | undefined> {
  try {
    const response = await fetchImpl(TAUGHT_CAPABILITY_URL);
    if (!response.ok) return undefined;
    const records = parsePublicationList(await response.json());
    // One capability, because the offer is a single button. A file with
    // several would need a choice this page has no way to present.
    return records[0];
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Remembering that someone accepted it.
 *
 * The control plane persists a publication to disk and re-registers it
 * when the page loads again, so a capability does not evaporate on
 * refresh. A hosted copy has nowhere to write but this browser, and
 * without it the demonstration lasted exactly one page view: register,
 * reload, gone, with the badge back to claiming nothing was ever
 * published.
 *
 * Per-browser rather than per-visitor by design. It records a local
 * decision, not a publication -- nobody else's copy of this site changes
 * because one person pressed a button here.
 * ------------------------------------------------------------------ */

const ACCEPTED_KEY = "autowebmcp.signalbase.accepted";

/** Capability ids this browser has accepted. Empty whenever storage is unavailable. */
export function acceptedCapabilityIds(): Set<string> {
  try {
    const stored = window.localStorage.getItem(ACCEPTED_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    // Private browsing, disabled storage, or corrupt contents. Remembering
    // nothing is the safe answer: the offer simply appears again.
    return new Set();
  }
}

/** Records an acceptance, or does nothing at all if storage refuses. */
export function rememberAcceptance(id: string): void {
  try {
    const ids = acceptedCapabilityIds();
    ids.add(id);
    window.localStorage.setItem(ACCEPTED_KEY, JSON.stringify([...ids]));
  } catch {
    // The tool is registered on this document either way; only surviving a
    // reload is lost, which is the same tradeoff the control plane makes
    // when it cannot write its own state file.
  }
}

/** Forgets an acceptance, so a reload returns the site to offering it. */
export function forgetAcceptance(id: string): void {
  try {
    const ids = acceptedCapabilityIds();
    ids.delete(id);
    window.localStorage.setItem(ACCEPTED_KEY, JSON.stringify([...ids]));
  } catch {
    // Nothing to do. The reload that follows re-reads whatever survived.
  }
}
