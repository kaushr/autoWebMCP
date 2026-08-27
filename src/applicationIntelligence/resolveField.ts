import type {
  FieldResolution,
  ObservedFieldSignal,
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
      knowledge: "tenant" | "standard" | "observation-only";
    }
  | { ok: false; reason: string; hard: boolean };

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

  return {
    ok: false,
    hard: false,
    reason:
      `No application field identifier was observed for "${label}", and no application knowledge identifies that label` +
      `${request.objectApiName ? ` on ${request.objectApiName}` : ""}. A custom or renamed field needs tenant metadata before it can be bound.`
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
    return {
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
  if (hardBlock) return { ok: false, reason: hardBlock.reason };

  const resolved = attempts.filter((attempt): attempt is Extract<Attempt, { ok: true }> => attempt.ok);
  if (resolved.length === 0) {
    return { ok: false, reason: failures[0]?.reason ?? `"${request.inputName}" could not be grounded in the application's model.` };
  }

  // STEP E — consistency and uniqueness. Two observed fields that mean two
  // different application fields is a question only a human can settle.
  const distinct = [...new Set(resolved.map((attempt) => attempt.field.apiName))];
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `"${request.inputName}" matches several observed fields resolving to different application fields: ${distinct.join(", ")}. A human must choose.`
    };
  }
  const winner = resolved[0];
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
        : "not described by any application knowledge, so the observed identifier stands alone";

  return {
    ok: true,
    field: winner.field,
    observed: winner.observed,
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
