import type { EntityIdentity } from "./engine";

/* ------------------------------------------------------------------ *
 * Reading the identity of the entity a page is showing.
 *
 * Generic by construction: everything platform-specific arrives as a
 * declared pattern from Platform Intelligence, so this file contains no
 * Salesforce knowledge — no `/lightning/r/`, no assumption that an id is
 * 15 or 18 characters, no assumption that every platform even has one.
 *
 * The identity is read from the ROUTE rather than from anything rendered.
 * A record's visible name is not an identity: two Opportunities may share
 * one, which is the entire reason a name-based search must hand back an id
 * before anything is written.
 * ------------------------------------------------------------------ */

/** How one platform exposes entity identity, compiled from its pack. */
export interface EntityIdentityPolicy {
  /** A regular expression over the page path with named groups `entity` and `id`. */
  routePattern: string;
  trustworthyForMutation: boolean;
  /** Path template using `{entity}` and `{id}`, for explaining what navigation would be. */
  routeTemplate: string;
}

/**
 * Extracts the identity a path encodes, or `undefined` when it encodes none.
 *
 * A malformed pattern yields `undefined` rather than throwing: a pack that
 * declares a bad regex should make identity unobservable — and therefore
 * make mutation refuse — not crash an execution midway.
 */
export function identityFromPath(path: string, policy: EntityIdentityPolicy): EntityIdentity | undefined {
  let pattern: RegExp;
  try {
    pattern = new RegExp(policy.routePattern);
  } catch {
    return undefined;
  }
  const match = pattern.exec(path);
  const id = match?.groups?.["id"];
  if (!id) return undefined;
  const entityType = match?.groups?.["entity"];
  return { id, ...(entityType ? { entityType } : {}) };
}

/**
 * Whether two identities refer to the same entity.
 *
 * Exact on the id — no normalization, no case folding, no prefix matching.
 * A platform whose ids have equivalent forms (Salesforce's 15- and
 * 18-character ids are the classic case) would need that declared as
 * platform knowledge rather than assumed here; treating unequal strings as
 * equal is precisely the shortcut that puts a write on the wrong record.
 *
 * `entityType` is compared only when both sides state one, so an identity
 * observed without a type still matches one carrying it.
 */
export function sameEntity(a: EntityIdentity, b: EntityIdentity): boolean {
  if (a.id !== b.id) return false;
  if (a.entityType && b.entityType) return a.entityType === b.entityType;
  return true;
}

/**
 * Whether a path is the entity's OWN page, rather than somewhere beneath it.
 *
 * A live Lightning page carries links like
 * `/lightning/r/Opportunity/<id>/related/Products/view` — the record's id,
 * on a link to one of its related lists. Reading identity from that is
 * correct for "which record am I on"; treating it as a search RESULT is
 * not, and would have handed an agent an Opportunity named "Products(4)".
 *
 * The canonical shape comes from the pack's own `routeTemplate`, so this
 * stays as declared as the pattern that found the id in the first place.
 */
export function isCanonicalRoute(path: string, identity: EntityIdentity, policy: EntityIdentityPolicy): boolean {
  const canonical = routeFor(identity, policy);
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === canonical.replace(/\/+$/, "");
}

/** How a caller would reach this entity, for an explanation a human can act on. */
export function routeFor(identity: EntityIdentity, policy: EntityIdentityPolicy): string {
  return policy.routeTemplate
    .replace("{entity}", identity.entityType ?? "")
    .replace("{id}", identity.id);
}
