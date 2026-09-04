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
