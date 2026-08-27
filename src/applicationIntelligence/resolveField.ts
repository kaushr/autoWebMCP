import type {
  EpistemicNeed,
  FieldClarification,
  FieldResolution,
  ObservedFieldSignal,
  SuggestedAnswer,
  ResolvedApplicationField,
  StandardApplicationSchema,
  TenantFieldSchema,
  TenantIntelligenceSource,
  TenantObjectSchema
} from "./model";
import { foldIdentity } from "./model";

/* ------------------------------------------------------------------ *
 * Grounding one capability input in the application's own model.
 *
 * The ordering here is a claim about responsibility, not a preference
 * ranking. Evidence and knowledge answer different questions and neither
 * substitutes for the other:
 *
 *   OBSERVED EVIDENCE      establishes WHAT THE HUMAN TAUGHT
 *   APPLICATION KNOWLEDGE  establishes WHAT THAT OBSERVED THING MEANS
 *
 * So the evidence gate runs FIRST and is absolute. Knowing that
 * `Opportunity.StageName` exists is never a reason to bind Stage; only a
 * human demonstrating Stage is. Metadata that was never demonstrated
 * cannot enter this function's candidate set at all, which is why that
 * invariant is structural rather than a check someone has to remember.
 *
 * Within application knowledge, tenant refines standard: a tenant's own
 * configuration describes the screen the human actually saw, so it wins
 * over what the vendor ships by default. Tenant knowledge cannot reach
 * platform safety policy — see `model.ts`.
 *
 * Runtime context (record type, controlling fields, permissions) is the
 * layer that would narrow a resolved value domain to what is legal *right
 * now*. V0.1 does not implement it; `materializeOptions` below is where it
 * attaches, and `docs/APPLICATION_INTELLIGENCE.md` records why the
 * distinction matters.
 * ------------------------------------------------------------------ */

/** One field the capture actually observed the human interact with. */
export type ObservedFieldCandidate = ObservedFieldSignal;

export interface FieldResolutionRequest {
  /** The capability input being grounded, e.g. `stage`. */
  inputName: string;
  /** The object the capture happened on, e.g. `Opportunity`. */
  objectApiName?: string;
  observed: readonly ObservedFieldCandidate[];
  platform?: string;
  standard?: StandardApplicationSchema;
  tenant?: TenantIntelligenceSource;
  /**
   * Facts a human already supplied for this capability. Consulted only
   * after tenant and standard knowledge have both failed — a person should
   * never be asked, or re-asked, for something the application's own model
   * can answer.
   */
  clarifications?: readonly FieldClarification[];
}

function tenantObjectFor(request: FieldResolutionRequest): TenantObjectSchema | undefined {
  if (!request.tenant || !request.platform || !request.objectApiName) return undefined;
  return request.tenant.getObject(request.platform, request.objectApiName);
}

function standardObjectFor(request: FieldResolutionRequest) {
  if (!request.standard || !request.objectApiName) return undefined;
  const wanted = foldIdentity(request.objectApiName);
  return request.standard.objects.find((object) => foldIdentity(object.apiName) === wanted);
}

/**
 * The value domain for a resolved field, as currently known.
 *
 * Deliberately its own step: today it copies whatever tenant metadata
 * listed, but the legal set can narrow by record type, by a controlling
 * picklist's value, and by field-level permissions. When runtime context
 * arrives it narrows here, and nothing upstream changes.
 */
function materializeOptions(field: TenantFieldSchema): Pick<ResolvedApplicationField, "options" | "optionsSource"> {
  if (!field.options || field.options.length === 0) return {};
  return { options: [...field.options], optionsSource: "tenant" };
}

function fromTenantField(
  field: TenantFieldSchema,
  objectApiName: string | undefined
): ResolvedApplicationField {
  return {
    ...(objectApiName ? { objectApiName } : {}),
    apiName: field.apiName,
    label: field.label,
    type: field.type,
    ...(field.custom ? { custom: true } : {}),
    ...materializeOptions(field)
  };
}

/** Candidates whose own signals name this input. The evidence gate. */
function observedMatchesFor(request: FieldResolutionRequest): ObservedFieldCandidate[] {
  const wanted = foldIdentity(request.inputName);
  return request.observed.filter(
    (candidate) =>
      (candidate.applicationIdentifier ? foldIdentity(candidate.applicationIdentifier) === wanted : false) ||
      (candidate.label ? foldIdentity(candidate.label) === wanted : false)
  );
}

/**
 * A failed attempt is `hard` when the failure is a genuine ambiguity —
 * knowledge that names two candidates for one thing. That must veto the
 * whole input even if another observed candidate did resolve.
 *
 * A `soft` failure only means *this* signal could not be explained. A
 * recording routinely carries several events for one field (a click that
 * exposed an identifier, a change that exposed only a label); one of them
 * being unexplainable is not a reason to discard a sibling that grounded
 * cleanly.
 */
type AttemptCore =
  | {
      ok: true;
      field: ResolvedApplicationField;
      evidence: "application-identifier" | "visible-label";
      knowledge: "tenant" | "standard" | "observation-only" | "human-confirmed";
    }
  | { ok: false; reason: string; hard: boolean; unknownLabel?: string; candidates?: SuggestedAnswer[] };

/** An attempt once the candidate it rests on has been attached. */
type Attempt = AttemptCore extends infer T ? (T extends { ok: true } ? T & { observed: ObservedFieldCandidate } : T) : never;

/**
 * What one observed candidate means, consulting tenant knowledge before
 * standard knowledge. An observed application identifier that no layer
 * recognizes still grounds the field — the application named its own
 * control, which is evidence in itself. An observed *label* that no layer
 * recognizes does not: a label alone is not a field identity, and
 * guessing one would be exactly the silent mapping this system refuses.
 */
function attemptFor(candidate: ObservedFieldCandidate, request: FieldResolutionRequest): AttemptCore {
  const tenantObject = tenantObjectFor(request);
  const standardObject = standardObjectFor(request);
  const identifier = candidate.applicationIdentifier;

  if (identifier) {
    const wanted = foldIdentity(identifier);
    const tenantField = tenantObject?.fields.filter((field) => foldIdentity(field.apiName) === wanted) ?? [];
    if (tenantField.length > 1) {
      return { ok: false, hard: true, reason: `Tenant metadata lists several fields with the identifier "${identifier}".` };
    }
    if (tenantField.length === 1) {
      return { ok: true, field: fromTenantField(tenantField[0], request.objectApiName), evidence: "application-identifier", knowledge: "tenant" };
    }

    const standardField = standardObject?.fields.find((field) => foldIdentity(field.apiName) === wanted);
    if (standardField) {
      return {
        ok: true,
        field: {
          ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
          apiName: standardField.apiName,
          label: candidate.label?.replace(/^\*/, "").trim() || standardField.defaultLabel,
          type: standardField.type
        },
        evidence: "application-identifier",
        knowledge: "standard"
      };
    }

    // No knowledge layer recognizes it, but the application itself named
    // the control the human used. That is weaker than schema knowledge and
    // is reported as such, never dressed up as an understood field.
    return {
      ok: true,
      field: {
        ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
        apiName: identifier,
        label: candidate.label?.replace(/^\*/, "").trim() || identifier,
        type: "string"
      },
      evidence: "application-identifier",
      knowledge: "observation-only"
    };
  }

  const label = candidate.label?.replace(/^\*/, "").trim();
  if (!label) return { ok: false, hard: false, reason: "The observed interaction carried neither an application identifier nor a visible label." };
  const wantedLabel = foldIdentity(label);

  const tenantByLabel = tenantObject?.fields.filter((field) => foldIdentity(field.label) === wantedLabel) ?? [];
  if (tenantByLabel.length > 1) {
    return { ok: false, hard: true, reason: `Tenant metadata lists several fields labelled "${label}".` };
  }
  if (tenantByLabel.length === 1) {
    return { ok: true, field: fromTenantField(tenantByLabel[0], request.objectApiName), evidence: "visible-label", knowledge: "tenant" };
  }

  const standardByLabel = standardObject?.fields.filter((field) => foldIdentity(field.defaultLabel) === wantedLabel) ?? [];
  if (standardByLabel.length > 1) {
    return { ok: false, hard: true, reason: `Standard application knowledge lists several fields labelled "${label}".` };
  }
  if (standardByLabel.length === 1) {
    return {
      ok: true,
      field: {
        ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
        apiName: standardByLabel[0].apiName,
        label,
        type: standardByLabel[0].type
      },
      evidence: "visible-label",
      knowledge: "standard"
    };
  }

  // Human clarification is the LAST resort, reached only now that tenant
  // and standard knowledge have both declined. Asking earlier would burden
  // a person with something the application's own model already knows.
  const answered = clarificationFor(label, request);
  if (answered) {
    return {
      ok: true,
      field: {
        ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
        apiName: answered.apiName,
        label,
        type: answered.type ?? "string",
        ...(answered.apiName.endsWith("__c") ? { custom: true } : {})
      },
      evidence: "visible-label",
      knowledge: "human-confirmed"
    };
  }

  return {
    ok: false,
    hard: false,
    unknownLabel: label,
    reason:
      `No application field identifier was observed for "${label}", and no application knowledge identifies that label` +
      `${request.objectApiName ? ` on ${request.objectApiName}` : ""}.`
  };
}

/** A human answer for this label on this object, if one has been given. */
function clarificationFor(label: string, request: FieldResolutionRequest): FieldClarification | undefined {
  const wanted = foldIdentity(label);
  return request.clarifications?.find(
    (entry) =>
      foldIdentity(entry.observedLabel) === wanted &&
      (!request.platform || entry.platform === request.platform) &&
      (!entry.objectApiName || !request.objectApiName || foldIdentity(entry.objectApiName) === foldIdentity(request.objectApiName))
  );
}

/**
 * How much authority a resolution carries.
 *
 * A tenant describes the org actually on screen; a vendor release
 * describes how the product ships; a human answer is scoped local
 * knowledge; an observed identifier alone is not application knowledge at
 * all. Ranking these matters because two observed signals for one field
 * can resolve through different layers, and treating them as peers made a
 * knowledge-backed answer "conflict" with a meaningless framework-
 * generated name and block the whole input.
 */
const KNOWLEDGE_AUTHORITY: Record<string, number> = {
  tenant: 4,
  standard: 3,
  "human-confirmed": 2,
  "observation-only": 1
};


/* ------------------------- epistemic need construction ------------------------- */

/**
 * The question to ask when the application's own model cannot name a field
 * a human demonstrably used.
 *
 * Built from the unresolved fact, never improvised: it names only the
 * residual unknown, and everything already established travels in
 * `knownEvidence` so no one is asked for the object, the label, or the
 * platform that the recording already proved.
 */
function missingApiNameNeed(request: FieldResolutionRequest, label: string): EpistemicNeed {
  const tenantKnown = Boolean(request.tenant?.describe(request.platform ?? ""));
  const onObject = request.objectApiName ? ` on ${request.objectApiName}` : "";
  return {
    status: "needs-information",
    kind: "field-api-name",
    question: `What is the API name for the field labelled "${label}"${onObject}?`,
    reason:
      tenantKnown
        ? `Tenant metadata is available but describes no field labelled "${label}"${onObject}, and the control exposed no identifier of its own. ` +
          "Without its API name this field cannot be bound durably."
        : `No tenant metadata is available in this installation, and "${label}" is not a field the vendor's standard model ships${onObject}. ` +
          "One answer unblocks this capability; full metadata access is not required.",
    blocking: true,
    knownEvidence: {
      inputName: request.inputName,
      ...(request.platform ? { platform: request.platform } : {}),
      ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
      observedLabel: label
    },
    resolutionSources: tenantKnown ? ["human"] : ["tenant-metadata", "human"]
  };
}

/** A choice, not a question: the system has candidates but no grounds to pick. */
function ambiguityNeed(
  request: FieldResolutionRequest,
  suggestions: SuggestedAnswer[],
  reason: string
): EpistemicNeed {
  return {
    status: "ambiguous",
    kind: "field-choice",
    question: `Which application field does "${request.inputName}" refer to?`,
    reason,
    blocking: true,
    knownEvidence: {
      inputName: request.inputName,
      ...(request.platform ? { platform: request.platform } : {}),
      ...(request.objectApiName ? { objectApiName: request.objectApiName } : {})
    },
    ...(suggestions.length > 0 ? { suggestedAnswers: suggestions } : {}),
    resolutionSources: ["human"]
  };
}

/**
 * The outcome when no observed signal could be explained.
 *
 * A label the system saw but cannot identify is a question worth asking. A
 * signal that carried nothing to reason about is not — there is no fact a
 * human could supply that would make an anonymous event meaningful.
 */
function unresolvedOutcome(
  request: FieldResolutionRequest,
  failures: Array<Extract<Attempt, { ok: false }>>
): FieldResolution {
  const unknownLabel = failures.find((failure) => failure.unknownLabel)?.unknownLabel;
  const reason = failures[0]?.reason ?? `"${request.inputName}" could not be grounded in the application's model.`;
  if (!unknownLabel) return { status: "blocked", ok: false, reason };
  return { status: "needs-information", ok: false, reason, need: missingApiNameNeed(request, unknownLabel) };
}

/** A human answer the application's own model disagrees with. */
function contradictingClarification(
  winner: Extract<Attempt, { ok: true }> & { observed: ObservedFieldCandidate },
  request: FieldResolutionRequest
): FieldClarification | undefined {
  if (winner.knowledge !== "tenant" && winner.knowledge !== "standard") return undefined;
  const label = winner.observed.label?.replace(/^\*/, "").trim();
  if (!label) return undefined;
  const answered = clarificationFor(label, request);
  return answered && foldIdentity(answered.apiName) !== foldIdentity(winner.field.apiName) ? answered : undefined;
}

/**
 * A gap worth recording that does not stop anything.
 *
 * A picklist whose value domain is unknown still binds and still executes —
 * the live control remains the authority on what it will accept. But the
 * typed form cannot offer a real choice, and that is a consequence of
 * missing tenant metadata rather than of anything the human did, so it is
 * reported as a non-blocking setup gap instead of disappearing.
 */
function unknownDomainNeed(
  request: FieldResolutionRequest,
  field: ResolvedApplicationField
): EpistemicNeed | undefined {
  if (field.type !== "picklist" || (field.options && field.options.length > 0)) return undefined;
  return {
    status: "needs-setup",
    kind: "tenant-metadata",
    question: `Which values are valid for "${field.label}"?`,
    reason:
      `${field.apiName} is a picklist, but no tenant metadata is available to say which values this org allows. ` +
      "The field still executes — the application validates the value — but the test form cannot offer a list to choose from. " +
      "This needs metadata access, not a one-line answer.",
    blocking: false,
    knownEvidence: {
      inputName: request.inputName,
      ...(request.platform ? { platform: request.platform } : {}),
      ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
      observedLabel: field.label
    },
    resolutionSources: ["tenant-metadata", "runtime-context"]
  };
}

/**
 * Grounds one capability input, or refuses.
 *
 * Refusal is a first-class outcome. An input that cannot be grounded
 * uniquely blocks the whole binding upstream, which is the behaviour that
 * keeps a wrong write from ever being attempted.
 */
export function resolveApplicationField(request: FieldResolutionRequest): FieldResolution {
  // STEP A — evidence gate. Knowledge cannot open this door.
  const matches = observedMatchesFor(request);
  if (matches.length === 0) {
    // Not an epistemic need: nothing is missing that a human could supply.
    // The recording simply does not show this field being used, and no
    // answer changes that without a new demonstration.
    return {
      status: "blocked",
      ok: false,
      reason: `No observed field identifier or visible label matches "${request.inputName}".`
    };
  }

  // STEP C — what the observed signals mean.
  // Ordered the way the platform pack declares identity priority:
  // an identifier the application exposed outranks an accessible name,
  // regardless of which event carried it. The live capture makes the
  // difference concrete — the *click* on Close Date named the control while
  // the stronger `field_change` was retargeted to a nameless shadow host,
  // so ranking by event strength alone would ground the field on its label
  // when the application had named it outright.
  const attempts = matches
    .slice()
    .sort((left, right) => {
      const named = Number(Boolean(right.applicationIdentifier)) - Number(Boolean(left.applicationIdentifier));
      return named !== 0 ? named : right.strength - left.strength;
    })
    .map((candidate) => {
      const attempt = attemptFor(candidate, request);
      return attempt.ok ? { ...attempt, observed: candidate } : attempt;
    });

  const failures = attempts.filter((attempt): attempt is Extract<Attempt, { ok: false }> => !attempt.ok);
  const hardBlock = failures.find((attempt) => attempt.hard);
  if (hardBlock) {
    return {
      status: "ambiguous",
      ok: false,
      reason: hardBlock.reason,
      need: ambiguityNeed(request, hardBlock.candidates ?? [], hardBlock.reason)
    };
  }

  const allResolved = attempts.filter((attempt): attempt is Extract<Attempt, { ok: true }> => attempt.ok);
  if (allResolved.length === 0) {
    return unresolvedOutcome(request, failures);
  }

  // STEP E — consistency and uniqueness, computed over EVERY reading.
  //
  // Authority decides which layer explains a field; it must not be used to
  // silence a disagreement. Two observed signals that name two different
  // application fields is a real conflict even when one of them resolved
  // through stronger knowledge — quietly preferring the recognized one
  // would be exactly the "silently choose a potentially wrong mapping"
  // failure this system exists to avoid. It is now a choice put to a human
  // rather than a dead end.
  const resolved = allResolved;
  const distinct = [...new Set(resolved.map((attempt) => attempt.field.apiName))];
  if (distinct.length > 1) {
    const reason = `"${request.inputName}" matches several observed fields resolving to different application fields: ${distinct.join(", ")}. A human must choose.`;
    return {
      status: "ambiguous",
      ok: false,
      reason,
      need: ambiguityNeed(
        request,
        resolved.map((attempt) => ({
          value: attempt.field.apiName,
          label: attempt.field.label,
          source: attempt.knowledge,
          detail: `Observed as "${attempt.observed.label ?? attempt.observed.applicationIdentifier}".`
        })),
        reason
      )
    };
  }
  // Every reading agrees on WHICH field this is; authority now decides
  // WHICH LAYER's account of it to keep. This is where a tenant's own
  // configuration supersedes the vendor default — same field, better
  // description: the org's real label, its configured type, its values.
  const winner = resolved
    .slice()
    .sort((left, right) => (KNOWLEDGE_AUTHORITY[right.knowledge] ?? 0) - (KNOWLEDGE_AUTHORITY[left.knowledge] ?? 0))[0];

  // A human answer that the application's own model contradicts is not
  // quietly overridden in either direction; the disagreement is the finding.
  const contradiction = contradictingClarification(winner, request);
  if (contradiction) {
    return {
      status: "ambiguous",
      ok: false,
      reason:
        `A human answered that "${contradiction.observedLabel}" is ${contradiction.apiName}, but ` +
        `${winner.knowledge === "tenant" ? "tenant metadata" : "standard application knowledge"} identifies it as ` +
        `${winner.field.apiName}. This contradiction must be settled before the field can be bound.`,
      need: ambiguityNeed(
        request,
        [
          { value: winner.field.apiName, label: winner.field.label, source: winner.knowledge, detail: "From application knowledge." },
          { value: contradiction.apiName, label: contradiction.observedLabel, source: "human-confirmed", detail: "Previously supplied by a human." }
        ],
        "Application knowledge and a human answer disagree."
      )
    };
  }
  const objectPrefix = winner.field.objectApiName ? `${winner.field.objectApiName}.` : "";
  const via =
    winner.evidence === "application-identifier"
      ? "the identifier the control exposed"
      : `the visible label "${winner.field.label}"`;
  const by =
    winner.knowledge === "tenant"
      ? "confirmed by tenant metadata"
      : winner.knowledge === "standard"
        ? `confirmed by standard application knowledge${request.standard ? ` (${request.standard.release})` : ""}`
        : winner.knowledge === "human-confirmed"
          ? "supplied by a human for this capability, and confirmed by no application metadata"
          : "not described by any application knowledge, so the observed identifier stands alone";

  const domainNeed = unknownDomainNeed(request, winner.field);
  return {
    status: "resolved",
    ok: true,
    field: winner.field,
    observed: winner.observed,
    ...(domainNeed ? { need: domainNeed } : {}),
    grounding: {
      evidence: winner.evidence,
      knowledge: winner.knowledge,
      ...(winner.knowledge === "standard" && request.standard ? { release: request.standard.release } : {}),
      detail:
        `"${request.inputName}" was observed in the recording and resolved through ${via} to ` +
        `${objectPrefix}${winner.field.apiName} (${winner.field.type}), ${by}.`
    }
  };
}
