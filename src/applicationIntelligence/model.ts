/* ------------------------------------------------------------------ *
 * Application Intelligence — what the application *is*.
 *
 * Deliberately separate from Platform Intelligence, which describes how a
 * platform *behaves*: shadow-DOM traversal, edit/view state, toast versus
 * validation, prohibited transports. Salesforce Lightning's component
 * mechanics are platform facts and belong there. `Opportunity.StageName is
 * a picklist labelled "Stage"` is an application fact and belongs here.
 * Conflating them was what made a Lightning picklist unresolvable: the
 * platform layer correctly said "this host exposes no native name", and no
 * layer existed to say what the field actually *was*.
 *
 * Two knowledge layers live in this vocabulary:
 *
 *   STANDARD  what the vendor ships in a given release ("summer-26").
 *             Versioned, because vendor application shape evolves.
 *             Carries no tenant configuration — notably no picklist
 *             values, which are a tenant fact even for a standard field.
 *
 *   TENANT    how one customer's org differs: renamed labels, custom
 *             fields and objects, configured picklist values, and
 *             eventually record types, dependencies, and validation rules.
 *
 * Tenant knowledge REFINES standard knowledge. It never reaches platform
 * safety policy — that is structural here, not a rule someone must
 * remember: nothing in these types can express a transport, a policy, a
 * traversal rule, or a safety constraint.
 * ------------------------------------------------------------------ */

/**
 * The application's own declared type for a field.
 *
 * Vendor-neutral on purpose: `picklist` is what Salesforce calls a closed
 * value domain, but the concept (and this name) is not Salesforce-specific
 * enough to matter, and every other vendor's equivalent maps onto it.
 */
export type ApplicationFieldType =
  | "string"
  | "date"
  | "datetime"
  | "number"
  | "currency"
  | "boolean"
  | "picklist"
  | "reference";

/** One field as the vendor ships it. Standard knowledge, no tenant configuration. */
export interface StandardFieldSchema {
  /** The application's own field identity, e.g. `StageName`. */
  apiName: string;
  /** The label the vendor ships, which a tenant may rename. */
  defaultLabel: string;
  type: ApplicationFieldType;
}

export interface StandardObjectSchema {
  /** The application's own object identity, e.g. `Opportunity`. */
  apiName: string;
  fields: StandardFieldSchema[];
}

/**
 * Vendor-shipped application knowledge for one release.
 *
 * `release` is what makes this refutable over time: a fact true in Summer
 * '26 is not automatically true later, and knowledge that cannot be dated
 * cannot be retired.
 */
export interface StandardApplicationSchema {
  release: string;
  objects: StandardObjectSchema[];
}

/**
 * One field as a particular tenant has it configured.
 *
 * `label` (not `defaultLabel`) because a tenant's label is the one a human
 * actually saw during Teach Mode. `options` are tenant configuration even
 * for a standard field — Salesforce ships `StageName` but each org decides
 * what its stages are.
 */
export interface TenantFieldSchema {
  apiName: string;
  label: string;
  type: ApplicationFieldType;
  /**
   * The configured value domain, when metadata exposed one.
   *
   * LONG TERM this is not a static property of the field: the legal set
   * can narrow by record type, by a controlling field's current value, and
   * by the running user's permissions. See `docs/APPLICATION_INTELLIGENCE.md`.
   * Absent means "not known", never "no restriction".
   */
  options?: string[];
  /** A field this tenant added, which no standard release knows about. */
  custom?: boolean;
}

export interface TenantObjectSchema {
  apiName: string;
  fields: TenantFieldSchema[];
}

/**
 * A tenant's application intelligence as captured at one moment.
 *
 * A snapshot, deliberately: whoever obtained it — an admin at setup, a
 * rep's own limited describe access, a central org service — hands over
 * the same shape, and the resolver never learns which. That is the seam
 * the future installation modes plug into.
 */
export interface TenantIntelligenceSnapshot {
  /** Which platform this describes, e.g. `salesforce-lightning`. */
  platform: string;
  /** Opaque org identity for provenance. Never a session, token, or credential. */
  orgId?: string;
  capturedAt?: string;
  /** The vendor release this org was running when captured, when known. */
  release?: string;
  /** How this snapshot was obtained, for provenance, e.g. "injected-demo-snapshot". */
  mechanism?: string;
  objects: TenantObjectSchema[];
}

/**
 * The seam. V0.1 ships an empty source and an in-memory snapshot source;
 * a future org-level service implements the same two methods and nothing
 * downstream changes.
 */
export interface TenantIntelligenceSource {
  /** Provenance for whatever this source knows, or `undefined` when it knows nothing. */
  describe(platform: string): { orgId?: string; capturedAt?: string; mechanism?: string } | undefined;
  getObject(platform: string, objectApiName: string): TenantObjectSchema | undefined;
}

/* ----------------------------- resolution ----------------------------- */

/** Which observed signal identified the field. Evidence, not knowledge. */
export type FieldEvidenceKind = "application-identifier" | "visible-label";

/**
 * Which knowledge layer explained what the observed signal meant.
 *
 * `human-confirmed` sits deliberately below both metadata layers: a person
 * telling us their org's field is `Region__c` is scoped local knowledge,
 * not the vendor documenting it, and it is only ever consulted once tenant
 * and standard knowledge have both declined.
 */
export type FieldKnowledgeSource = "tenant" | "standard" | "human-confirmed" | "observation-only";

/**
 * A field the system has grounded: the application's own identity for
 * something a human demonstrably interacted with.
 */
export interface ResolvedApplicationField {
  objectApiName?: string;
  apiName: string;
  label: string;
  type: ApplicationFieldType;
  /**
   * MATERIALIZED APPLICATION INTELLIGENCE, not a permanent property of the
   * field. Correct for the context it was resolved in; see `options` on
   * `TenantFieldSchema`.
   */
  options?: string[];
  optionsSource?: FieldKnowledgeSource;
  custom?: boolean;
}

/** How a resolution was reached — both halves, because they are different claims. */
export interface FieldGrounding {
  /** What the human demonstrably did. */
  evidence: FieldEvidenceKind;
  /** What explained it. */
  knowledge: FieldKnowledgeSource;
  /** The standard release consulted, when standard knowledge was used. */
  release?: string;
  /** A sentence a human can audit. */
  detail: string;
}

/* --------------------------- epistemic need --------------------------- */

/**
 * What happened when the system tried to understand an observed field.
 *
 * `resolved` or `null` was too coarse. When Stage could not be grounded,
 * the system was not simply defeated — it knew precisely what it was
 * missing ("the underlying Salesforce field identity") and could have
 * asked. Collapsing that into failure threw away the most useful thing it
 * knew.
 *
 *   resolved           enough grounded evidence to proceed safely
 *   needs-information  a specific missing fact would let this continue
 *   needs-setup        the gap needs configuration, not a one-line answer
 *   ambiguous          several readings survive; a human must choose
 *   blocked            no safe path exists under current constraints
 *
 * `blocked` is deliberately not an epistemic need: learning another field
 * name does not make a prohibited execution mechanism safe.
 */
export type ResolutionStatus = "resolved" | "needs-information" | "needs-setup" | "ambiguous" | "blocked";

/** Where an answer could legitimately come from, cheapest-authority-first. */
export type ResolutionSource =
  | "tenant-metadata"
  | "standard-application-knowledge"
  | "runtime-context"
  | "human";

/** One candidate answer, and where it came from. A suggestion is never a fact. */
export interface SuggestedAnswer {
  value: string;
  label?: string;
  source: FieldKnowledgeSource;
  detail: string;
}

/**
 * A specific thing the system does not know, stated well enough to act on.
 *
 * Generated from the unresolved fact itself, never improvised: the
 * question names only the residual unknown, and `knownEvidence` carries
 * everything already established so nothing is asked twice.
 */
export interface EpistemicNeed {
  status: Exclude<ResolutionStatus, "resolved">;
  /** What kind of fact is missing. */
  kind: "field-api-name" | "field-choice" | "tenant-metadata";
  /** The question, as a human would be asked it. */
  question: string;
  /** Why it matters — what cannot happen until it is answered. */
  reason: string;
  /** Whether resolution is stuck without it. A non-blocking need is a note, not a gate. */
  blocking: boolean;
  /** Already known. Never ask for any of this. */
  knownEvidence: {
    inputName: string;
    platform?: string;
    objectApiName?: string;
    observedLabel?: string;
    observedIdentifier?: string;
  };
  suggestedAnswers?: SuggestedAnswer[];
  /** Who or what could settle this. */
  resolutionSources: ResolutionSource[];
}

/**
 * A fact a human supplied, kept as what it is.
 *
 * Scoped to this tenant and object, never promoted into standard vendor
 * knowledge: a person telling us their org's field is `Region__c` is not
 * Salesforce documenting it. If application knowledge later confirms the
 * same identity the fact gains stronger provenance; if it contradicts,
 * the contradiction is surfaced rather than silently resolved either way.
 */
export interface FieldClarification {
  platform: string;
  objectApiName?: string;
  /** The observed label this answers for. */
  observedLabel: string;
  /** The application field identity the human supplied. */
  apiName: string;
  type?: ApplicationFieldType;
  source: "human-confirmed";
  answeredAt?: string;
  /** Never "platform" or "vendor" — a human answer is tenant-local at best. */
  scope: "capability" | "tenant";
}

export type FieldResolution =
  | {
      status: "resolved";
      ok: true;
      field: ResolvedApplicationField;
      grounding: FieldGrounding;
      /** A non-blocking gap noticed while resolving, e.g. an unknown value domain. */
      need?: EpistemicNeed;
      /**
       * The observed signal this resolution rests on. The caller resolves
       * the control at runtime by what is actually on screen, so the
       * observed label and identifier travel with the answer — the
       * application's API name says what the field *is*, never how to find
       * it in the DOM.
       */
      observed: ObservedFieldSignal;
    }
  | {
      status: Exclude<ResolutionStatus, "resolved">;
      ok: false;
      reason: string;
      /** Present whenever the system can name what it is missing. */
      need?: EpistemicNeed;
    };

/** One field the capture observed a human interact with. */
export interface ObservedFieldSignal {
  /** The application's own identifier, when the control exposed one. */
  applicationIdentifier?: string;
  /** The visible label, as the human read it. */
  label?: string;
  section?: string;
  /** A `field_change` outranks a `click`; higher wins. */
  strength: number;
}

/** `close_date`, `CloseDate`, and `*Close Date` all reduce to `closedate`. */
export function foldIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
