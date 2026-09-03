import type { TestFormField } from "./executionTestForm";
import type { BrowserExecutionBinding } from "../binding/browserExecution/model";

/* ------------------------------------------------------------------ *
 * Resolving an unknown value domain, without asking the user to
 * orchestrate it.
 *
 * "Which values does this field accept?" is a knowledge gap the system
 * already identifies for itself: the input is grounded to a specific
 * application field, that field is known to be constrained, and safe
 * execution needs its domain. Handing the user a "Get valid choices"
 * button made them the orchestrator of an acquisition they have no
 * special ability to perform — the system knows better than they do which
 * sources exist and which is most authoritative.
 *
 * So the gap is a NEED, and the need is satisfied automatically from the
 * most contextually authoritative source available:
 *
 *   A  tenant intelligence   already materialized on the binding —
 *                            answers without touching the application
 *   B  standard knowledge    identifies the field as constrained; it must
 *                            NOT supply values, because what a vendor
 *                            ships is not what an org configured
 *   C  live application      what this control currently offers for THIS
 *                            record, user, and context — read-only
 *   D  a human               only once the machine-accessible sources
 *                            cannot answer
 *
 * This is deliberately a small planner over one kind of need, not an
 * epistemic framework. It exists so that the future layer which owns
 * "what do I need to know, and where can I get it" has an obvious place
 * to take this over from.
 * ------------------------------------------------------------------ */

/** Where a resolved domain came from. Retained even when acquisition is invisible to the user. */
export type ValueDomainSource =
  | "tenant-metadata"
  /**
   * What the control was offering when the human used it.
   *
   * The strongest evidence available without touching the application
   * again, and it costs nothing: the person opened the picklist to make
   * their choice, so the whole set was on screen and was recorded with
   * everything else. Weaker than a live read only in one respect — an org
   * can reconfigure a picklist after a demonstration — which is why a live
   * acquisition still supersedes it.
   */
  | "demonstrated"
  | "live-application-state"
  | "human-confirmed";

/** One field whose valid values are needed before it can safely be given a value. */
export interface ValueDomainNeed {
  inputName: string;
  label: string;
  objectApiName?: string;
  /** The application's own field identity, e.g. `StageName`. */
  apiName?: string;
  required: boolean;
}

export interface ValueDomainPlan {
  /** Needs that can be satisfied by reading the live application, read-only. */
  acquirable: ValueDomainNeed[];
  /**
   * Needs no available source can satisfy. These escalate to a human,
   * because there is nothing left for the machine to try.
   */
  unresolvable: ValueDomainNeed[];
  /** A line per decision, kept for diagnostics even though the user sees none of it. */
  trail: string[];
}

/**
 * Decides, per constrained input, whether anything still needs acquiring
 * and whether the live application can answer it.
 *
 * Deliberately does no I/O: the caller performs the acquisition. Keeping
 * the decision separate from the mechanism is what lets the precedence be
 * tested without a browser, and what will let a future epistemic layer
 * replace the decision without touching the mechanism.
 */
export function planValueDomainAcquisition(
  fields: readonly TestFormField[],
  binding: BrowserExecutionBinding,
  /** False when nothing can drive the live application — no adapter, no extension. */
  liveAcquisitionAvailable = true
): ValueDomainPlan {
  const acquirable: ValueDomainNeed[] = [];
  const unresolvable: ValueDomainNeed[] = [];
  const trail: string[] = [];

  for (const field of fields) {
    if (field.control !== "select") continue;
    const bound = binding.inputs.find((input) => input.semanticInput === field.name);
    const applicationField = bound?.applicationField;
    const identity = applicationField
      ? `${applicationField.objectApiName ? `${applicationField.objectApiName}.` : ""}${applicationField.apiName}`
      : field.label;

    if (!field.domainUnknown) {
      // A — already answered, and by something more authoritative than a
      // live reading would be cheap to get. Do not open the application to
      // rediscover what the org's own metadata already told us.
      trail.push(
        `Need: valid value domain for ${identity}. ` +
          `Already known from ${applicationField?.optionsSource ?? "the capability's own contract"}; no acquisition needed.`
      );
      continue;
    }

    const need: ValueDomainNeed = {
      inputName: field.name,
      label: field.label,
      ...(applicationField?.objectApiName ? { objectApiName: applicationField.objectApiName } : {}),
      ...(applicationField?.apiName ? { apiName: applicationField.apiName } : {}),
      required: field.required
    };

    trail.push(`Need: valid value domain for ${identity} in the current execution context.`);
    trail.push("Tenant intelligence: no values available.");
    // B — standard knowledge is what told us this field is constrained at
    // all. It deliberately stops there: vendor defaults are not this org's
    // configuration, and pretending otherwise would be inventing values.
    trail.push("Standard application knowledge: field identified as a fixed set of choices; tenant domain unknown.");

    if (liveAcquisitionAvailable) {
      trail.push("Live application acquisition: available; will read the control's current choices.");
      acquirable.push(need);
    } else {
      trail.push("Live application acquisition: unavailable.");
      unresolvable.push(need);
    }
  }

  return { acquirable, unresolvable, trail };
}

/** Whether any required input is still waiting on a domain nobody has supplied. */
export function hasUnresolvedRequiredDomain(plan: ValueDomainPlan): boolean {
  return [...plan.acquirable, ...plan.unresolvable].some((need) => need.required);
}
