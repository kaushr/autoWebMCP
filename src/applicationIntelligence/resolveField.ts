import type {
  ApplicationFieldType,
  ValueDomainState,
  EpistemicNeed,
  FieldClarification,
  FieldResolution,
  ObservedFieldSignal,
  ResolvedApplicationField,
  StandardApplicationSchema,
  SuggestedAnswer,
  TenantFieldSchema,
  TenantIntelligenceSource,
  TenantObjectSchema
} from "./model";
import { foldIdentity } from "./model";

/* ------------------------------------------------------------------ *
 * Grounding one capability input in the application's own model.
 *
 * Three sources answer three different questions, and forcing them into a
 * single authority ranking loses the distinction:
 *
 *   METADATA     what exists, and its technical properties
 *   OBSERVATION  what actually happened
 *   A HUMAN      what they MEANT, when evidence cannot distinguish it
 *
 * So the evidence gate runs first and absolutely — knowing that
 * `Opportunity.StageName` exists is never a reason to bind Stage; only a
 * human demonstrating Stage is — and then the work is candidate-shaped
 * rather than lookup-shaped:
 *
 *   gather every plausible interpretation
 *     → discriminate with evidence already in hand
 *       → ask a person only about what genuinely remains
 *
 * That ordering matters. Two tenant fields both labelled "Stage" is not a
 * failure and not a coin toss; it is a set of two known candidates, and an
 * identifier observed anywhere else in the same recording settles it
 * without troubling anyone. Asking "what is the API name of Stage?" when
 * both API names are already known is the thing to avoid.
 * ------------------------------------------------------------------ */

export type ObservedFieldCandidate = ObservedFieldSignal;

export interface FieldResolutionRequest {
  /** The capability input being grounded, e.g. `stage`. */
  inputName: string;
  /** The object the capture happened on, e.g. `Opportunity`. */
  objectApiName?: string;
  observed: readonly ObservedFieldCandidate[];
  platform?: string;
  /** The capability's own declared type, used only to rule a candidate out. */
  inputType?: ApplicationFieldType;
  standard?: StandardApplicationSchema;
  tenant?: TenantIntelligenceSource;
  /**
   * Answers a human has already given for this capability. Read as
   * disambiguating INTENT, not as an assertion about the application's
   * technical model — see `applyClarification`.
   */
  clarifications?: readonly FieldClarification[];
}

/** One plausible reading of what the human interacted with. */
interface Candidate {
  field: ResolvedApplicationField;
  /**
   * Where this reading comes from. `observed` means the application named
   * a control that no knowledge layer recognizes — real evidence of a
   * distinct field, but not an account of what that field is.
   */
  source: "tenant" | "standard" | "observed";
  /** Whether the application itself named it in the recording. */
  matchedByIdentifier: boolean;
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

/** Whether this installation has tenant knowledge at all — different from it being silent on one field. */
function tenantIsAvailable(request: FieldResolutionRequest): boolean {
  return Boolean(request.tenant?.describe(request.platform ?? ""));
}

function cleanLabel(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/^\*/, "").trim();
  return trimmed || undefined;
}

/**
 * The value domain for a resolved field, as currently known.
 *
 * Deliberately its own step: today it copies whatever tenant metadata
 * listed, but the legal set can narrow by record type, by a controlling
 * picklist's value, and by field-level permissions. When runtime context
 * arrives it narrows here, and nothing upstream changes.
 */
function materializeOptions(
  field: TenantFieldSchema
): Pick<ResolvedApplicationField, "options" | "optionsSource" | "domain"> {
  if (!field.options || field.options.length === 0) return {};
  // An observation stays an observation. Values read from a running control
  // describe this record, this user, and this moment; values from metadata
  // describe the org's configuration. Reporting the first as the second
  // would make a reading that expires look like a fact that does not.
  if (field.source === "observed-live") {
    return { options: [...field.options], optionsSource: "live-application-state", domain: "known-live" };
  }
  return { options: [...field.options], optionsSource: "tenant", domain: "known-tenant" };
}

/**
 * The domain status of a resolved field.
 *
 * A closed-domain field whose values nobody has listed is `discoverable-live`,
 * not `unknown`: the live control itself is authoritative about what it
 * currently offers, and asking it is both cheaper and more correct than
 * asking a person — record type, dependent picklists, and permissions can
 * all narrow the set in ways no static snapshot captures.
 */
function domainStateFor(field: ResolvedApplicationField): ValueDomainState | undefined {
  if (field.type !== "picklist") return undefined;
  if (field.options && field.options.length > 0) return field.domain ?? "known-tenant";
  return "discoverable-live";
}

function fromTenantField(field: TenantFieldSchema, objectApiName: string | undefined): ResolvedApplicationField {
  return {
    ...(objectApiName ? { objectApiName } : {}),
    apiName: field.apiName,
    label: field.label,
    type: field.type,
    ...(field.custom ? { custom: true } : {}),
    ...materializeOptions(field)
  };
}

/* ----------------------------- STEP A: evidence ----------------------------- */

/**
 * The signals in this recording that correspond to this input. The
 * evidence gate.
 *
 * A signal qualifies when it names the input directly — the observed label
 * `*Stage` for input `stage`, or an identifier that folds to it like
 * `CloseDate` for `close_date` — or when application knowledge says the
 * control it named IS this input: `StageName` does not look like `stage`,
 * but metadata knows that field is labelled "Stage".
 *
 * That second route uses knowledge to INTERPRET an interaction, never to
 * invent one. The human still had to touch the control; metadata only
 * explains which input the control corresponds to. Metadata alone can
 * still never put a field into a capability, which is the invariant this
 * gate exists to hold.
 */
function observedMatchesFor(request: FieldResolutionRequest): ObservedFieldCandidate[] {
  const wanted = foldIdentity(request.inputName);
  const tenantObject = tenantObjectFor(request);
  const standardObject = standardObjectFor(request);

  /**
   * Every name by which a capability input may legitimately refer to one
   * field identity.
   *
   * The vendor label is in here, and that is the whole point: a tenant that
   * renames Stage to "Sales Stage" has changed its own vocabulary, not the
   * field. An input named for the vendor's concept must still reach it, or
   * the agent contract silently inherits one org's configuration — see
   * `canonicalInputs.ts` for the other half of that invariant.
   *
   * The tenant's own label stays in the set too, so a capability taught
   * where no knowledge layer recognizes the field keeps working exactly as
   * before.
   */
  const namesForApiName = (apiName: string): string[] => {
    const key = foldIdentity(apiName);
    const names = [key];
    const tenantField = tenantObject?.fields.find((field) => foldIdentity(field.apiName) === key);
    if (tenantField) names.push(foldIdentity(tenantField.label));
    const standardField = standardObject?.fields.find((field) => foldIdentity(field.apiName) === key);
    if (standardField) names.push(foldIdentity(standardField.defaultLabel));
    return names;
  };

  const identifierMeansThisInput = (identifier: string): boolean =>
    namesForApiName(identifier).includes(wanted);

  /**
   * A label reaches the input through the field it names.
   *
   * Only a field whose label this observation actually carried is
   * consulted, so knowledge still explains an interaction and never
   * invents one: the human had to have touched a control labelled this way
   * for any of it to be reachable at all.
   */
  const labelMeansThisInput = (label: string): boolean => {
    const key = foldIdentity(label);
    const identities = [
      ...(tenantObject?.fields.filter((field) => foldIdentity(field.label) === key) ?? []),
      ...(standardObject?.fields.filter((field) => foldIdentity(field.defaultLabel) === key) ?? [])
    ].map((field) => field.apiName);

    // A person who has already said "this label is that field" has supplied
    // identity, and identity is what this gate resolves names through.
    // Without it, answering the question would ground the input and then
    // canonicalizing it — the very next step — would rename it to something
    // this gate could no longer reach, leaving a capability that is
    // understood and unbindable.
    //
    // Still only ever interpretation, never invention: the human had to have
    // demonstrated a control carrying this label for it to be considered.
    const clarified = clarificationFor([label], request)?.apiName;
    if (clarified) identities.push(clarified);

    return identities.some((apiName) => namesForApiName(apiName).includes(wanted));
  };

  return request.observed.filter(
    (candidate) =>
      (candidate.applicationIdentifier
        ? foldIdentity(candidate.applicationIdentifier) === wanted ||
          identifierMeansThisInput(candidate.applicationIdentifier)
        : false) ||
      (candidate.label ? foldIdentity(candidate.label) === wanted || labelMeansThisInput(candidate.label) : false)
  );
}

/* --------------------------- STEP C: interpretations --------------------------- */

/**
 * Every reading the application's model supports for what was observed.
 *
 * Gathered across ALL the matched signals at once rather than one signal
 * at a time. That is the fix for the real Lightning shape: the click named
 * `StageName` while the retargeted change carried only the label, and
 * resolving each signal in isolation meant an identifier sitting in the
 * same recording could not narrow a label that matched two fields.
 */
function gatherCandidates(
  matches: readonly ObservedFieldCandidate[],
  request: FieldResolutionRequest,
  path: string[]
): Candidate[] {
  const tenantObject = tenantObjectFor(request);
  const standardObject = standardObjectFor(request);
  const byApiName = new Map<string, Candidate>();

  const add = (field: ResolvedApplicationField, source: Candidate["source"], matchedByIdentifier: boolean): void => {
    const key = foldIdentity(field.apiName);
    const existing = byApiName.get(key);
    if (existing) {
      // Same field, two accounts of it: tenant describes the org actually
      // on screen, so its account supersedes the vendor default. An
      // identifier match is remembered wherever it came from.
      if (matchedByIdentifier) existing.matchedByIdentifier = true;
      if (existing.source !== "tenant" && source === "tenant") existing.field = field;
      return;
    }
    byApiName.set(key, { field, source, matchedByIdentifier });
  };

  const identifiers = [...new Set(matches.map((match) => match.applicationIdentifier).filter(Boolean) as string[])];
  const labels = [...new Set(matches.map((match) => cleanLabel(match.label)).filter(Boolean) as string[])];
  const observedLabel = labels[0];

  for (const identifier of identifiers) {
    const wanted = foldIdentity(identifier);
    for (const field of tenantObject?.fields.filter((entry) => foldIdentity(entry.apiName) === wanted) ?? []) {
      add(fromTenantField(field, request.objectApiName), "tenant", true);
    }
    for (const field of standardObject?.fields.filter((entry) => foldIdentity(entry.apiName) === wanted) ?? []) {
      add(
        {
          ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
          apiName: field.apiName,
          label: observedLabel ?? field.defaultLabel,
          type: field.type
        },
        "standard",
        true
      );
    }
  }

  for (const label of labels) {
    const wanted = foldIdentity(label);
    for (const field of tenantObject?.fields.filter((entry) => foldIdentity(entry.label) === wanted) ?? []) {
      add(fromTenantField(field, request.objectApiName), "tenant", false);
    }
    for (const field of standardObject?.fields.filter((entry) => foldIdentity(entry.defaultLabel) === wanted) ?? []) {
      add(
        {
          ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
          apiName: field.apiName,
          label,
          type: field.type
        },
        "standard",
        false
      );
    }
  }

  // An identifier the application exposed that no knowledge layer
  // recognizes is still evidence of a real, distinct control. Dropping it
  // would let a recognized field quietly stand in for a second one the
  // human also touched.
  for (const identifier of identifiers) {
    const key = foldIdentity(identifier);
    if (byApiName.has(key)) continue;
    byApiName.set(key, {
      field: {
        ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
        apiName: identifier,
        label: observedLabel ?? identifier,
        type: request.inputType ?? "string"
      },
      source: "observed",
      matchedByIdentifier: true
    });
  }

  const candidates = [...byApiName.values()];
  if (candidates.length > 0) {
    const fromTenant = candidates.some((candidate) => candidate.source === "tenant");
    path.push(
      `Found ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} in ` +
        `${fromTenant ? "tenant metadata" : "standard application knowledge"}: ` +
        `${candidates.map((candidate) => candidate.field.apiName).join(", ")}.`
    );
  }
  return candidates;
}

/* ---------------------------- STEP D: discriminate ---------------------------- */

/** Types that can plausibly describe the same control. Conservative on purpose. */
function typesCompatible(declared: ApplicationFieldType | undefined, candidate: ApplicationFieldType): boolean {
  // `string` is what an unconfirmed capability input looks like; it rules
  // nothing out. Only a specific declared type can eliminate anything.
  if (!declared || declared === "string") return true;
  if (declared === candidate) return true;
  if (declared === "number") return candidate === "currency";
  if (declared === "currency") return candidate === "number";
  if (declared === "date") return candidate === "datetime";
  if (declared === "datetime") return candidate === "date";
  return false;
}

/** What the capture's control classification implies, when it implies anything. */
function controlSuggestsType(control: string | undefined): ApplicationFieldType | undefined {
  if (control === "date") return "date";
  if (control === "number") return "number";
  if (control === "checkbox") return "boolean";
  if (control === "select" || control === "combobox" || control === "radio") return "picklist";
  // "other"/"text" say nothing: Lightning reports "other" for a datepicker
  // and a picklist alike, which is what made this whole layer necessary.
  return undefined;
}

/**
 * Narrows the candidate set using evidence already captured.
 *
 * Every rule here must ELIMINATE on incompatibility or IDENTIFY directly.
 * "More likely because it is standard" is not a discriminator, and there is
 * no scoring or confidence weighting here by design. A rule that would
 * eliminate every candidate is treated as non-discriminating rather than as
 * proof of nothing: evidence contradicting everything is more likely to be
 * evidence we misread.
 */
function discriminate(
  candidates: Candidate[],
  matches: readonly ObservedFieldCandidate[],
  request: FieldResolutionRequest,
  path: string[]
): Candidate[] {
  let surviving = candidates;
  const narrow = (next: Candidate[], explain: string): void => {
    if (next.length === 0 || next.length === surviving.length) return;
    surviving = next;
    path.push(explain);
  };

  // 1. The application named it — but an identifier no knowledge layer
  //    recognizes must never eliminate one that metadata explains. That
  //    would let a framework-generated name outrank the application's own
  //    model, which is the inversion this ordering exists to prevent.
  const described = surviving.filter((candidate) => candidate.source !== "observed");
  const named = surviving.filter((candidate) => candidate.matchedByIdentifier);
  const namedKeepsDescribed = described.length === 0 || named.some((candidate) => candidate.source !== "observed");
  if (named.length > 0 && namedKeepsDescribed) {
    const identifiers = [...new Set(matches.map((match) => match.applicationIdentifier).filter(Boolean))];
    narrow(
      named,
      `Observed identifier ${identifiers.map((entry) => `"${entry}"`).join(", ")} matched ${named.length} of them.`
    );
    if (surviving.length === 1) return surviving;
  }

  // 2. A value the human actually set must be inside the candidate's own domain.
  const observedValue = matches.map((match) => match.value).find(Boolean);
  if (observedValue && surviving.some((candidate) => (candidate.field.options?.length ?? 0) > 0)) {
    const accepts = surviving.filter(
      (candidate) =>
        !candidate.field.options ||
        candidate.field.options.some((option) => foldIdentity(option) === foldIdentity(observedValue))
    );
    narrow(accepts, `The observed value "${observedValue}" is offered by ${accepts.length} of them.`);
    if (surviving.length === 1) return surviving;
  }

  // 3. The declared type, or the control the capture classified, can rule a
  //    candidate out — never rule one in.
  const declared = request.inputType ?? controlSuggestsType(matches.map((match) => match.control).find(Boolean));
  if (declared) {
    const compatible = surviving.filter((candidate) => typesCompatible(declared, candidate.field.type));
    narrow(compatible, `Only ${compatible.length} of them can hold a ${declared} value.`);
  }

  return surviving;
}

/* ------------------------- STEP D2: human intent ------------------------- */

/** A human answer for one of these labels on this object, if one has been given. */
function clarificationFor(
  labels: readonly string[],
  request: FieldResolutionRequest
): FieldClarification | undefined {
  const wanted = labels.map(foldIdentity);
  return request.clarifications?.find(
    (entry) =>
      wanted.includes(foldIdentity(entry.observedLabel)) &&
      (!request.platform || entry.platform === request.platform) &&
      (!entry.objectApiName ||
        !request.objectApiName ||
        foldIdentity(entry.objectApiName) === foldIdentity(request.objectApiName))
  );
}

type ClarificationOutcome =
  /** The person picked one of the readings the model already knew: intent, not a technical claim. */
  | { kind: "selects-candidate"; candidate: Candidate }
  /** No metadata knows what they named, and none contradicts it either. */
  | { kind: "asserts-identity"; apiName: string }
  /** Authoritative tenant metadata describes this label and does not include their answer. */
  | { kind: "contradicts-tenant"; apiName: string; known: Candidate[] };

/**
 * What a human answer means, given what the model already knows.
 *
 * The same answer is three different things depending on context, which is
 * exactly why a single authority ranking was the wrong shape:
 *
 *   picking `Custom_Stage__c` from two tenant-known fields
 *     → disambiguating intent. Resolve it; the field's technical
 *       properties still come from tenant metadata, not from the person.
 *
 *   naming `Custom_Stage__c` when tenant metadata describes this label and
 *   knows no such field
 *     → an unverified assertion against authoritative metadata. Surface it.
 *
 *   naming `Custom_Stage__c` when tenant metadata is unavailable and only
 *   the vendor default suggested otherwise
 *     → legitimate: standard knowledge describes how Salesforce ships, not
 *       how this org is configured. Resolve, marked tenant-unverified.
 */
function applyClarification(
  answer: FieldClarification,
  candidates: readonly Candidate[],
  request: FieldResolutionRequest
): ClarificationOutcome {
  const wanted = foldIdentity(answer.apiName);
  const chosen = candidates.find((candidate) => foldIdentity(candidate.field.apiName) === wanted);
  if (chosen) return { kind: "selects-candidate", candidate: chosen };

  const tenantCandidates = candidates.filter((candidate) => candidate.source === "tenant");
  if (tenantIsAvailable(request) && tenantCandidates.length > 0) {
    return { kind: "contradicts-tenant", apiName: answer.apiName, known: tenantCandidates };
  }
  return { kind: "asserts-identity", apiName: answer.apiName };
}

/* --------------------- technical facts, sourced separately --------------------- */

/**
 * The application's own account of a field, looked up by identity.
 *
 * Deliberately independent of how that identity was settled. A person may
 * tell us WHICH field they used; they do not get to tell us what its
 * datatype is. So a human answer naming a field the metadata knows still
 * takes its type and value domain from the metadata.
 */
function technicalFactsFor(
  apiName: string,
  request: FieldResolutionRequest
): { field: ResolvedApplicationField; source: "tenant" | "standard" } | undefined {
  const wanted = foldIdentity(apiName);
  const tenantField = tenantObjectFor(request)?.fields.find((field) => foldIdentity(field.apiName) === wanted);
  if (tenantField) return { field: fromTenantField(tenantField, request.objectApiName), source: "tenant" };

  const standardField = standardObjectFor(request)?.fields.find((field) => foldIdentity(field.apiName) === wanted);
  if (standardField) {
    return {
      field: {
        ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
        apiName: standardField.apiName,
        label: standardField.defaultLabel,
        type: standardField.type
      },
      source: "standard"
    };
  }
  return undefined;
}

/* ------------------------------ needs ------------------------------ */

function suggestionsFrom(candidates: readonly Candidate[]): SuggestedAnswer[] {
  return candidates.map((candidate) => ({
    value: candidate.field.apiName,
    label: candidate.field.label,
    source: candidate.source === "observed" ? "observation-only" : candidate.source,
    type: candidate.field.type,
    detail:
      candidate.source === "tenant"
        ? `Tenant metadata: ${candidate.field.custom ? "custom" : "standard"} field, ${candidate.field.type}.`
        : candidate.source === "standard"
          ? `Standard Salesforce field, ${candidate.field.type}.`
          : "Named by the application in the recording; no metadata describes it."
  }));
}

function needBase(request: FieldResolutionRequest, label: string | undefined, path: readonly string[]) {
  return {
    blocking: true as const,
    knownEvidence: {
      inputName: request.inputName,
      ...(request.platform ? { platform: request.platform } : {}),
      ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
      ...(label ? { observedLabel: label } : {})
    },
    resolutionPath: [...path]
  };
}

/**
 * The question when several known candidates survive.
 *
 * It names them, with their sources and types, because the system already
 * knows them. Asking "what is the API name?" here would be asking a person
 * to repeat information we possess.
 */
function choiceNeed(
  request: FieldResolutionRequest,
  label: string | undefined,
  candidates: readonly Candidate[],
  path: readonly string[]
): EpistemicNeed {
  return {
    ...needBase(request, label, path),
    status: "ambiguous",
    kind: "field-choice",
    subreason: "insufficient-evidence",
    question: `Which field did you change${label ? ` when you edited "${label}"` : ""}?`,
    reason:
      `${candidates.length} fields${request.objectApiName ? ` on ${request.objectApiName}` : ""} match what was observed, ` +
      "and this recording contains nothing that distinguishes them — no identifier, no value, and no type difference.",
    suggestedAnswers: suggestionsFrom(candidates),
    resolutionSources: ["human"]
  };
}

/** The question when nothing in the model matches at all. */
function missingApiNameNeed(request: FieldResolutionRequest, label: string, path: readonly string[]): EpistemicNeed {
  const tenantKnown = tenantIsAvailable(request);
  const onObject = request.objectApiName ? ` on ${request.objectApiName}` : "";
  return {
    ...needBase(request, label, path),
    status: "needs-information",
    kind: "field-api-name",
    subreason: tenantKnown ? "unknown" : "knowledge-unavailable",
    question: `What is the API name for the field labelled "${label}"${onObject}?`,
    reason: tenantKnown
      ? `Tenant metadata is available for this org but describes no field labelled "${label}"${onObject}, and the control ` +
        "exposed no identifier of its own. The fact is genuinely unknown, not merely out of reach."
      : `No tenant metadata is available in this installation, and "${label}" is not a field the vendor's standard model ` +
        `ships${onObject}. This is being asked because org metadata is unavailable, not because the field is unknowable — ` +
        "one answer unblocks this capability, and full metadata access is not required.",
    resolutionSources: tenantKnown ? ["human"] : ["tenant-metadata", "human"]
  };
}

/** The question when a human answer and authoritative tenant metadata disagree. */
function conflictNeed(
  request: FieldResolutionRequest,
  label: string | undefined,
  answered: string,
  known: readonly Candidate[],
  path: readonly string[]
): EpistemicNeed {
  return {
    ...needBase(request, label, path),
    status: "ambiguous",
    kind: "field-choice",
    subreason: "conflicting",
    question: `Which field did you change${label ? ` when you edited "${label}"` : ""}?`,
    reason:
      `A human answer names ${answered}, but tenant metadata for this org lists ` +
      `${known.map((candidate) => candidate.field.apiName).join(", ")} for that label and knows no such field. ` +
      "Authoritative org metadata is not overridden silently.",
    suggestedAnswers: [
      ...suggestionsFrom(known),
      {
        value: answered,
        source: "human-confirmed" as const,
        detail: "Previously supplied by a human; unverified by tenant metadata."
      }
    ],
    resolutionSources: ["human", "tenant-metadata"]
  };
}

/**
 * A gap worth recording that does not stop anything.
 *
 * A picklist whose value domain is unknown still binds and still executes —
 * the live control remains the authority on what it will accept. But the
 * typed form cannot offer a real choice, and that is a consequence of
 * missing tenant metadata rather than of anything the human did.
 */
function unknownDomainNeed(
  request: FieldResolutionRequest,
  field: ResolvedApplicationField,
  path: readonly string[]
): EpistemicNeed | undefined {
  if (field.type !== "picklist" || (field.options && field.options.length > 0)) return undefined;
  return {
    status: "needs-setup",
    kind: "tenant-metadata",
    subreason: "knowledge-unavailable",
    question: `Which values are valid for "${field.label}"?`,
    reason:
      `${field.apiName} is a picklist, but no tenant metadata says which values this org allows. ` +
      "The live control can be asked directly, which is more accurate than any snapshot — record type, dependent " +
      "picklists, and permissions all narrow what is actually offered. Values are read from the application before " +
      "the test form is shown; this need remains only if that inspection cannot be performed.",
    blocking: false,
    knownEvidence: {
      inputName: request.inputName,
      ...(request.platform ? { platform: request.platform } : {}),
      ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
      observedLabel: field.label
    },
    resolutionPath: [...path],
    resolutionSources: ["tenant-metadata", "runtime-context"]
  };
}

/* ------------------------------ resolution ------------------------------ */

function resolvedWith(
  request: FieldResolutionRequest,
  identity: ResolvedApplicationField,
  observed: ObservedFieldCandidate,
  knowledge: "tenant" | "standard" | "human-confirmed" | "observation-only",
  path: string[],
  extras: { intentDisambiguatedByHuman?: boolean; tenantUnverified?: boolean } = {}
): FieldResolution {
  const objectPrefix = identity.objectApiName ? `${identity.objectApiName}.` : "";
  const by =
    knowledge === "tenant"
      ? "with technical properties from tenant metadata"
      : knowledge === "standard"
        ? `with technical properties from standard application knowledge${request.standard ? ` (${request.standard.release})` : ""}`
        : knowledge === "human-confirmed"
          ? "on an identity supplied by a human, which no application metadata has confirmed"
          : "not described by any application knowledge, so the observed identifier stands alone";

  path.push(`Resolved ${objectPrefix}${identity.apiName}.`);
  path.push(
    extras.intentDisambiguatedByHuman
      ? "Resolved demonstrated intent; technical properties sourced from application metadata."
      : "No user clarification required."
  );

  const domain = domainStateFor(identity);
  const resolved: ResolvedApplicationField = domain ? { ...identity, domain } : identity;
  const domainNeed = unknownDomainNeed(request, resolved, path);
  return {
    status: "resolved",
    ok: true,
    field: resolved,
    observed,
    ...(domainNeed ? { need: domainNeed } : {}),
    grounding: {
      evidence: observed.applicationIdentifier ? "application-identifier" : "visible-label",
      knowledge,
      ...(knowledge === "standard" && request.standard ? { release: request.standard.release } : {}),
      ...(extras.intentDisambiguatedByHuman ? { intentDisambiguatedByHuman: true } : {}),
      ...(extras.tenantUnverified ? { tenantUnverified: true } : {}),
      path: [...path],
      detail:
        `"${request.inputName}" was observed in the recording and resolved to ${objectPrefix}${identity.apiName} ` +
        `(${identity.type}), ${by}.` +
        (extras.intentDisambiguatedByHuman ? " A person identified which candidate they used." : "") +
        (extras.tenantUnverified ? " Tenant metadata has not verified this." : "")
    }
  };
}

function blocked(reason: string): FieldResolution {
  return { status: "blocked", ok: false, reason };
}

/**
 * Grounds one capability input, or says precisely what it still needs.
 *
 * Refusal is a first-class outcome, but so is a question: an input that
 * cannot be grounded blocks the binding upstream either way, and the
 * difference between "this failed" and "one specific fact would fix this"
 * is the difference between a dead end and a next step.
 */
export function resolveApplicationField(request: FieldResolutionRequest): FieldResolution {
  const path: string[] = [];

  // STEP A — evidence gate. Knowledge cannot open this door.
  const matches = observedMatchesFor(request);
  if (matches.length === 0) {
    // Not an epistemic need: no answer makes an undemonstrated field part
    // of what the human taught. Only a new recording would.
    return blocked(`No observed field identifier or visible label matches "${request.inputName}".`);
  }

  const labels = [...new Set(matches.map((match) => cleanLabel(match.label)).filter(Boolean) as string[])];
  const primaryLabel = labels[0];
  path.push(`Observed "${primaryLabel ?? request.inputName}"${request.objectApiName ? ` on ${request.objectApiName}` : ""}.`);

  // The signal used to describe how the control is found on screen. An
  // identifier the application exposed outranks an accessible name, which
  // mirrors the platform pack's declared identity priority.
  const observed =
    matches.find((match) => match.applicationIdentifier && match.label) ??
    matches.find((match) => match.applicationIdentifier) ??
    matches.slice().sort((left, right) => right.strength - left.strength)[0];

  // STEP C — gather every reading the application's model supports.
  const candidates = gatherCandidates(matches, request, path);
  const answer = clarificationFor(labels, request);

  if (candidates.length === 0) {
    if (observed.applicationIdentifier && !answer) {
      // The application named a control no knowledge layer recognizes. The
      // name itself is evidence; it is reported as standing alone.
      path.push("No application knowledge describes it; the observed identifier stands alone.");
      return resolvedWith(
        request,
        {
          ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
          apiName: observed.applicationIdentifier,
          label: cleanLabel(observed.label) ?? observed.applicationIdentifier,
          type: request.inputType ?? "string"
        },
        observed,
        "observation-only",
        path
      );
    }
    if (!primaryLabel) {
      return blocked("The observed interaction carried neither an application identifier nor a visible label.");
    }

    path.push("No application knowledge describes that label.");
    if (answer) {
      // Nothing in the model to contradict, so the human answer stands. Its
      // technical facts still come from metadata if metadata knows the field.
      const facts = technicalFactsFor(answer.apiName, request);
      path.push(`A person identified it as ${answer.apiName}.`);
      return resolvedWith(
        request,
        facts?.field ?? {
          ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
          apiName: answer.apiName,
          label: primaryLabel,
          type: answer.type ?? request.inputType ?? "string",
          ...(answer.apiName.endsWith("__c") ? { custom: true } : {})
        },
        observed,
        facts?.source ?? "human-confirmed",
        path,
        { tenantUnverified: true }
      );
    }
    const need = missingApiNameNeed(request, primaryLabel, path);
    return {
      status: "needs-information",
      ok: false,
      reason:
        `No application field identifier was observed for "${primaryLabel}", and no application knowledge identifies ` +
        `that label${request.objectApiName ? ` on ${request.objectApiName}` : ""}.`,
      need
    };
  }

  // STEP D — discriminate with what the recording already contains.
  const surviving = discriminate(candidates, matches, request, path);

  // STEP D2 — a human answer is the last discriminator, never the first.
  if (answer) {
    const outcome = applyClarification(answer, surviving, request);
    if (outcome.kind === "selects-candidate") {
      path.push(`A person identified ${outcome.candidate.field.apiName} as the field they changed.`);
      return resolvedWith(
        request,
        outcome.candidate.field,
        observed,
        outcome.candidate.source === "observed" ? "observation-only" : outcome.candidate.source,
        path,
        { intentDisambiguatedByHuman: true }
      );
    }
    if (outcome.kind === "contradicts-tenant") {
      path.push(`A person named ${outcome.apiName}, which tenant metadata does not list for this label.`);
      const need = conflictNeed(request, primaryLabel, outcome.apiName, outcome.known, path);
      return { status: "ambiguous", ok: false, reason: need.reason, need };
    }
    // Standard knowledge describes the vendor default, not this org, so a
    // person naming a field it does not ship is not contradicting anything
    // authoritative about this tenant.
    const facts = technicalFactsFor(outcome.apiName, request);
    path.push(`A person identified it as ${outcome.apiName}; no tenant metadata is available to verify that.`);
    return resolvedWith(
      request,
      facts?.field ?? {
        ...(request.objectApiName ? { objectApiName: request.objectApiName } : {}),
        apiName: outcome.apiName,
        label: primaryLabel ?? outcome.apiName,
        type: answer.type ?? request.inputType ?? "string",
        ...(outcome.apiName.endsWith("__c") ? { custom: true } : {})
      },
      observed,
      facts?.source ?? "human-confirmed",
      path,
      { tenantUnverified: true }
    );
  }

  if (surviving.length > 1) {
    path.push("Available evidence could not distinguish them.");
    const need = choiceNeed(request, primaryLabel, surviving, path);
    return {
      status: "ambiguous",
      ok: false,
      reason:
        `"${request.inputName}" matches several application fields: ` +
        `${surviving.map((candidate) => candidate.field.apiName).join(", ")}. A human must choose.`,
      need
    };
  }

  // STEP E — one reading survives. Its technical facts are the candidate's own.
  const winner = surviving[0];
  return resolvedWith(
    request,
    winner.field,
    observed,
    winner.source === "observed" ? "observation-only" : winner.source,
    path
  );
}
