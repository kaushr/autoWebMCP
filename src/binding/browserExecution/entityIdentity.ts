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
  /** Matches a path referring to a record, including its sub-pages. Named group `id`, optional `entity`. */
  routePattern: string;
  /** Matches a path that is the record's OWN page. Same groups. */
  canonicalRoutePattern: string;
  /**
   * Entity type per identifier prefix, for routes that omit the object.
   *
   * A live list view linked `/lightning/r/0065w00002AZ0GeAAL/view` — no
   * object segment anywhere in it. The type has to come from the
   * identifier, or the link cannot be filtered by entity at all.
   */
  identifierPrefixes?: Record<string, string>;
  trustworthyForMutation: boolean;
  routeTemplate: string;
}

/** The entity type an identifier's own prefix implies, when the platform declares one. */
function typeFromIdentifier(id: string, policy: EntityIdentityPolicy): string | undefined {
  const prefixes = policy.identifierPrefixes;
  if (!prefixes) return undefined;
  for (const [prefix, entity] of Object.entries(prefixes)) {
    if (id.startsWith(prefix)) return entity;
  }
  return undefined;
}

function matchRoute(path: string, pattern: string, policy: EntityIdentityPolicy): EntityIdentity | undefined {
  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch {
    return undefined;
  }
  const match = expression.exec(path);
  const id = match?.groups?.["id"];
  if (!id) return undefined;
  // The route's own object segment when it has one; otherwise whatever the
  // identifier's prefix implies. An unrecognized prefix leaves the type
  // unknown rather than guessed — `sameEntity` then compares on id alone.
  const entityType = match?.groups?.["entity"] ?? typeFromIdentifier(id, policy);
  return { id, ...(entityType ? { entityType } : {}) };
}

/**
 * Extracts the identity a path encodes, or `undefined` when it encodes none.
 *
 * A malformed pattern yields `undefined` rather than throwing: a pack that
 * declares a bad regex should make identity unobservable — and therefore
 * make mutation refuse — not crash an execution midway.
 */
export function identityFromPath(path: string, policy: EntityIdentityPolicy): EntityIdentity | undefined {
  return matchRoute(path, policy.routePattern, policy);
}

/**
 * The identity a path points at, when that path is the record's OWN page.
 *
 * `undefined` for a sub-page. A live Lightning list carried
 * `/lightning/r/<id>/related/Products/view`, which identifies a record
 * perfectly well and is not a result for it — offering that as a candidate
 * would name an Opportunity "Products(4)".
 */
export function canonicalIdentityFromPath(
  path: string,
  policy: EntityIdentityPolicy
): EntityIdentity | undefined {
  return matchRoute(path, policy.canonicalRoutePattern, policy);
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

/** How a caller would reach this entity, for an explanation a human can act on. */
export function routeFor(identity: EntityIdentity, policy: EntityIdentityPolicy): string {
  return policy.routeTemplate
    .replace("{entity}", identity.entityType ?? "")
    .replace("{id}", identity.id);
}
