/* ------------------------------------------------------------------ *
 * The agent-facing description, and who is allowed to write which part.
 *
 * A description is not documentation. It is the part of the semantic
 * contract an agent reads before deciding whether to call a tool at all,
 * and — for anything it cannot see in the schema — the only place it
 * learns how the tool behaves. So the honest question is not "is this
 * text nice", it is WHO KNOWS THIS.
 *
 * Two parties know different halves:
 *
 *   THE MODEL   what the human was trying to DO. A demonstration that
 *               edits Stage and Close Date and saves is evidence of
 *               business intent, and inferring "updates a deal's stage and
 *               close date" from it is exactly what a language model is
 *               for.
 *
 *   THE SYSTEM  what the runtime will actually DO. Whether a target
 *               identity is required, whether a mismatch refuses, whether
 *               anything is written at all, whether one result comes back
 *               or several. A model has no way to know any of it, and
 *               every one of those sentences is a promise something later
 *               has to keep.
 *
 * The failure this module exists to prevent is the model writing the
 * second half. "Safely updates the record" and "finds the record
 * matching a name" are both plausible sentences and both lies — the first
 * promises a guarantee nothing enforces, the second promises a uniqueness
 * a search cannot offer. An agent that believes either behaves worse than
 * one told nothing.
 *
 * So composition here is subtractive before it is additive: guarantee-
 * shaped sentences are taken OUT of what the model proposed, and only the
 * guarantees the system can actually name enforcement for are put back.
 *
 * Pure and platform-free by construction. Nothing here knows what any
 * particular application or record type is; it is handed statements and
 * returns text.
 * ------------------------------------------------------------------ */

/**
 * One statement about runtime behaviour that this system actually enforces.
 *
 * `enforcedBy` is not commentary. A guarantee with nothing real to name
 * there is precisely the kind of sentence this module exists to keep out
 * of the contract, so the field is required and every producer has to
 * answer it.
 */
export interface ExecutionGuarantee {
  /** Stable across wording changes, so a guarantee can be asserted on without matching prose. */
  id: string;
  /** The sentence an agent reads. One sentence, ending in a full stop. */
  statement: string;
  /** The code that makes the statement true. */
  enforcedBy: string;
}

export interface ComposedDescription {
  /** The final agent-facing text: inferred intent first, enforced guarantees after. */
  text: string;
  /** The model's (or a human's) contribution, with any guarantee claim removed. */
  intent: string;
  /** The system's contribution, in the order it appears in `text`. */
  guarantees: ExecutionGuarantee[];
  /**
   * Sentences that claimed runtime behaviour and were dropped.
   *
   * Kept rather than discarded because "the model tried to promise
   * something" is worth seeing in the Studio, and because a guarantee
   * whose wording changed between versions lands here too — an old
   * sentence stops being carried forward instead of quietly outliving the
   * code that once backed it.
   */
  rejectedClaims: string[];
}

/**
 * What a sentence has to look like before it counts as a claim about
 * runtime behaviour rather than about business intent.
 *
 * Deliberately blunt. The cost of dropping a legitimate sentence is a
 * slightly thinner description; the cost of keeping an illegitimate one is
 * an agent acting on a promise nothing keeps. Where a real guarantee is
 * being described, the system re-adds it immediately afterwards, so an
 * over-broad match usually costs nothing at all.
 *
 * These are matched per sentence, never against the whole description, so
 * one bad sentence never removes a good one.
 */
const GUARANTEE_CLAIMS: readonly RegExp[] = [
  /\bread[-\s]?only\b/i,
  /\bwrite[-\s]?only\b/i,
  /\bdoes not\s+(create|modify|change|write|update|delete|alter|persist|save|select|choose|return)/i,
  /\bwithout\s+(modifying|changing|writing|updating|deleting|persisting|saving)\b/i,
  /\bnever\s+(creates?|modifies|changes?|writes?|updates?|deletes?|alters?|persists?|saves?|selects?|chooses?|fails?)/i,
  /\brefus(e|es|ed|ing|al)\b/i,
  /\brequire(s|d|ment|ments)?\b/i,
  /\bverif(y|ies|ied|ication)\b/i,
  /\bvalidat(e|es|ed|ion)\b/i,
  /\bguarantee(s|d)?\b/i,
  /\bidempotent\b/i,
  /\batomic(ally)?\b/i,
  /\brolls? back\b/i,
  /\bsafe(ly)? to (retry|call|invoke)\b/i,
  /\bsafely\b/i,
  /\b(exactly one|a single|the single|the unique|the only|at most one)\b/i,
  /\b(returns?|returning|may return)\b[^.!?]*\b(zero|one or more|multiple|several|candidates?|matches?|identit(y|ies)|ids?)\b/i
];

/** Whether a sentence promises runtime behaviour, and so is not the model's to write. */
export function claimsRuntimeBehaviour(sentence: string): boolean {
  return GUARANTEE_CLAIMS.some((pattern) => pattern.test(sentence));
}

/** Sentence-per-element, punctuation preserved, blank entries dropped. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Builds the description an agent will receive from what the model
 * proposed and what the system can prove.
 *
 * IDEMPOTENT, and that is load-bearing rather than tidy. Grounding is
 * re-runnable — answering one question and grounding again is the whole
 * interaction model — so composing an already-composed description has to
 * produce the same text, or every re-run would append another copy of the
 * guarantees and a confirmed contract would drift away from what was
 * confirmed. Two mechanisms give it: an exact match against the
 * guarantees about to be re-added is skipped silently, and anything else
 * guarantee-shaped is removed by the guard above.
 */
export function composeDescription(
  proposed: string | undefined,
  guarantees: readonly ExecutionGuarantee[]
): ComposedDescription {
  const alreadyComposed = new Set(guarantees.map((guarantee) => guarantee.statement));
  const intentParts: string[] = [];
  const rejectedClaims: string[] = [];

  for (const sentence of sentences(proposed ?? "")) {
    if (alreadyComposed.has(sentence)) continue;
    if (claimsRuntimeBehaviour(sentence)) {
      rejectedClaims.push(sentence);
      continue;
    }
    intentParts.push(sentence);
  }

  const intent = intentParts.join(" ");
  const text = [intent, ...guarantees.map((guarantee) => guarantee.statement)]
    .filter((part) => part.length > 0)
    .join(" ");

  return { text, intent, guarantees: [...guarantees], rejectedClaims };
}

/** `close_date` → `Close date`. The last-resort label when nothing described an input. */
export function humanizeInputName(name: string): string {
  const words = name.split("_").filter((word) => word.length > 0);
  if (words.length === 0) return "";
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}
