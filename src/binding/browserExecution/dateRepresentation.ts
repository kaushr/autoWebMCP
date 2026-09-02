/* ------------------------------------------------------------------ *
 * How this tenant writes dates.
 *
 * A tenant fact, not a platform one. Salesforce renders `03/04/2027` as
 * 4 March to one org's users and 3 April to another's, entirely from that
 * org's locale configuration — the platform behaves identically in both.
 *
 * This existed as a hardcoded `M/D/YYYY` on both the write and the
 * read-back, which is worse than an unhandled case. Verification would
 * report `match` for a record holding 3 April when 4 March had been asked
 * for: a wrong record, confirmed as correct, with no signal anywhere. A
 * false alarm blocks and can be retried; a false confirmation cannot.
 *
 * So ordering is ESTABLISHED from what the application itself displays,
 * carried with the provenance that established it, and where it cannot be
 * established the ambiguity is reported rather than assumed away.
 * ------------------------------------------------------------------ */

/** Which component a slash/dash date puts first. */
export type DateOrder = "month-first" | "day-first";

/** How an ordering was arrived at. `unknown` and `conflicting` both mean: do not assume. */
export type DateOrderSource = "unambiguous-sample" | "tenant-declared" | "no-evidence" | "conflicting";

export interface DateRepresentation {
  /** Absent means genuinely undetermined. Never defaulted. */
  order?: DateOrder;
  source: DateOrderSource;
  /** What was considered, so a Studio or a debug bundle can show the reasoning. */
  evidence: string[];
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DELIMITED = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** `2026-12-15` → parts. The canonical wire format; carries no ordering question. */
export function parseIsoDate(value: string): DateParts | undefined {
  const match = ISO.exec(value.trim());
  if (!match) return undefined;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * What one displayed date can tell us about this org's ordering, on its own.
 *
 * A component above 12 cannot be a month, which pins the order with no
 * configuration and no guessing. `08/09/2027` pins nothing and says so.
 */
export function orderFromSample(value: string): DateOrder | undefined {
  const match = DELIMITED.exec(value.trim());
  if (!match) return undefined;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (first > 12 && second <= 12) return "day-first";
  if (second > 12 && first <= 12) return "month-first";
  return undefined;
}

/**
 * Establishes the tenant's date ordering from values the application is
 * already displaying.
 *
 * Samples that pin nothing are not evidence of anything and never lower
 * confidence; samples that pin OPPOSITE orders are `conflicting`, which is
 * a refusal rather than a majority vote. Two fields in one org do not
 * disagree about locale, so a disagreement means something was misread —
 * and acting on a misreading is what this whole module exists to prevent.
 */
export function inferDateRepresentation(samples: readonly string[]): DateRepresentation {
  const evidence: string[] = [];
  const pinned = new Set<DateOrder>();

  for (const sample of samples) {
    if (!sample?.trim()) continue;
    if (ISO.test(sample.trim())) {
      evidence.push(`"${sample}" is ISO and carries no ordering information.`);
      continue;
    }
    const order = orderFromSample(sample);
    if (order) {
      pinned.add(order);
      evidence.push(`"${sample}" can only be ${order}: one component is above 12.`);
    } else if (DELIMITED.test(sample.trim())) {
      evidence.push(`"${sample}" is ambiguous: both components could be a month.`);
    }
  }

  if (pinned.size === 1) {
    return { order: [...pinned][0], source: "unambiguous-sample", evidence };
  }
  if (pinned.size > 1) {
    return {
      source: "conflicting",
      evidence: [...evidence, "Samples pin opposite orders; no ordering can be trusted from them."]
    };
  }
  return {
    source: "no-evidence",
    evidence: evidence.length > 0 ? evidence : ["No displayed date was available to establish this org's ordering."]
  };
}

/** A tenant that told us directly — an admin-supplied or metadata-supplied fact. */
export function declaredDateRepresentation(order: DateOrder): DateRepresentation {
  return { order, source: "tenant-declared", evidence: [`This org declares ${order} date ordering.`] };
}

/**
 * Reads a displayed date into parts, or says it cannot.
 *
 * `"ambiguous"` is deliberately distinct from `undefined`: a value that is
 * plainly not a date and a value we could read if only we knew this org's
 * ordering are different problems, and only the second is worth reporting
 * to a user as something to configure.
 */
export function parseDisplayedDate(value: string, order: DateOrder | undefined): DateParts | "ambiguous" | undefined {
  const iso = parseIsoDate(value);
  if (iso) return iso;

  const match = DELIMITED.exec(value.trim());
  if (!match) return undefined;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);

  // The value can settle its own ordering regardless of what we know.
  const selfEvident = orderFromSample(value);
  const effective = selfEvident ?? order;
  if (!effective) return "ambiguous";

  return effective === "month-first"
    ? { year, month: first, day: second }
    : { year, month: second, day: first };
}

/**
 * Whether a date can be typed into a display-format text input without
 * risking a silently wrong record.
 *
 * When the ordering is known, always. When it is not, only if the date is
 * self-disambiguating: writing `3/15/2027` into a day-first org asks for
 * month 15, which that org rejects outright — a visible failure, not a
 * wrong save. `3/4/2027` would be accepted by both and mean different
 * days, so it must not be typed blind.
 */
export function canTypeDisplayDate(date: DateParts, order: DateOrder | undefined): boolean {
  return order !== undefined || date.day > 12;
}

/** Formats parts the way this org reads them. Requires a known order — there is no safe default. */
export function formatDisplayDate(date: DateParts, order: DateOrder): string {
  return order === "month-first"
    ? `${date.month}/${date.day}/${date.year}`
    : `${date.day}/${date.month}/${date.year}`;
}
