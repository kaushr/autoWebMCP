import type { SourceApplication } from "../semantic/model";
import type { BindingEligibility } from "./model";

/** The one transport fact a policy reasons about. Metadata only, as always. */
export interface TransportObservation {
  method: string;
  pathPattern: string;
  origin: string;
  status: number;
}

export type TransportClass =
  | "private-internal"
  | "documented-rest"
  | "graphql"
  | "form-submission"
  | "in-process"
  | "unknown";

export interface PolicyNotes {
  platform: string;
  transportClass: TransportClass;
  /** The ceiling a proposal may reach. The model can never exceed it. */
  maximumEligibility: BindingEligibility;
  preferredBindingFamily?: string;
  notes: string[];
  warnings: string[];
  validationRequired: string[];
}

/**
 * Platform knowledge, kept out of the evidence engine.
 *
 * Correlation can tell you a request carried a Save. Only knowledge of a
 * platform can tell you whether that request is a supported interface or an
 * internal one that happens to work today. Nothing in `capture/` knows what
 * Salesforce is, and nothing in it should.
 */
export interface BindingPolicyProvider {
  notesFor(source: SourceApplication, transport: TransportObservation | undefined): PolicyNotes;
}

const NO_TRANSPORT_NOTES = (platform: string): PolicyNotes => ({
  platform,
  transportClass: "in-process",
  maximumEligibility: "unresolved",
  notes: ["The workflow produced no network mechanism; the application appears to act in-process."],
  warnings: [],
  validationRequired: [
    "Confirm whether the application exposes a cooperative binding for this capability"
  ]
});

/**
 * Salesforce Lightning.
 *
 * Aura is how Lightning talks to itself. It is unversioned, undocumented, and
 * carries framework state, so an observed `RecordUi.updateRecord` is excellent
 * evidence of *what happened* and no basis at all for calling it. The lead it
 * gives is the family — a record update — which supported platform interfaces
 * also cover. Which one, and whether it applies here, is unvalidated.
 */
const salesforcePolicy: BindingPolicyProvider = {
  notesFor(_source, transport) {
    if (!transport) return NO_TRANSPORT_NOTES("salesforce-lightning");

    const aura = /\/aura\b/.test(transport.pathPattern);
    const recordMutation = /RecordUi\.(update|create|delete)Record/i.test(transport.pathPattern);

    return {
      platform: "salesforce-lightning",
      transportClass: aura ? "private-internal" : "unknown",
      maximumEligibility: "needs-validation",
      ...(recordMutation ? { preferredBindingFamily: "salesforce-record-update" } : {}),
      notes: [
        aura
          ? "The observed transport is Salesforce's internal Aura endpoint."
          : "The observed transport is not a recognized Salesforce interface.",
        ...(recordMutation
          ? ["The Aura operation name indicates a record mutation rather than a read."]
          : [])
      ],
      warnings: [
        "Aura is an internal, unversioned Salesforce transport and must never be replayed directly.",
        "A supported Salesforce record interface is the candidate family; the specific interface is unvalidated."
      ],
      validationRequired: [
        "Identify the supported Salesforce interface equivalent to the observed operation",
        "Verify object and field-level permissions for the intended user",
        "Verify how the capability's inputs map onto that interface"
      ]
    };
  }
};

/** Everything else, by transport shape alone. No vendor knowledge involved. */
const genericPolicy: BindingPolicyProvider = {
  notesFor(source, transport) {
    if (!transport) return NO_TRANSPORT_NOTES(source.id);

    if (/\/graphql\b/.test(transport.pathPattern)) {
      return {
        platform: source.id,
        transportClass: "graphql",
        maximumEligibility: "needs-validation",
        preferredBindingFamily: "graphql-operation",
        notes: ["The observed transport is a GraphQL endpoint."],
        warnings: ["The specific operation and its schema are unverified."],
        validationRequired: ["Identify the operation name and its input types", "Verify authorization"]
      };
    }

    if (/^(POST|PUT|PATCH|DELETE)$/i.test(transport.method) && /^\/(api|rest|v\d)/.test(transport.pathPattern)) {
      return {
        platform: source.id,
        transportClass: "documented-rest",
        maximumEligibility: "needs-validation",
        preferredBindingFamily: "rest-resource-update",
        notes: [`The observed transport looks like a REST resource operation (${transport.method}).`],
        warnings: ["Whether this endpoint is a supported public interface is unverified."],
        validationRequired: [
          "Confirm the endpoint is a supported, documented interface",
          "Verify authentication and authorization requirements",
          "Verify how the capability's inputs map onto the request"
        ]
      };
    }

    return {
      platform: source.id,
      transportClass: "unknown",
      maximumEligibility: "unresolved",
      notes: ["The observed transport does not match a recognized interface shape."],
      warnings: ["An unrecognized transport is assumed private until proven otherwise."],
      validationRequired: ["Determine whether the application offers a supported interface for this capability"]
    };
  }
};

/** Dispatches on source application; unknown platforms fall back to shape. */
export const defaultBindingPolicyProvider: BindingPolicyProvider = {
  notesFor(source, transport) {
    if (source.id === "salesforce-lightning") return salesforcePolicy.notesFor(source, transport);
    return genericPolicy.notesFor(source, transport);
  }
};

const ELIGIBILITY_RANK: Record<BindingEligibility, number> = {
  "no-safe-candidate": 0,
  unresolved: 1,
  "unsafe-to-replay": 2,
  "private-observed-transport": 3,
  "needs-validation": 4,
  "supported-candidate": 5
};

/** Policy is a ceiling. A model may be more cautious, never less. */
export function capEligibility(proposed: BindingEligibility, ceiling: BindingEligibility): BindingEligibility {
  return ELIGIBILITY_RANK[proposed] > ELIGIBILITY_RANK[ceiling] ? ceiling : proposed;
}
