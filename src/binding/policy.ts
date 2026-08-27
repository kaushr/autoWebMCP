import type { SourceApplication } from "../semantic/model";
import {
  SALESFORCE_PLATFORM_ID,
  defaultPlatformIntelligenceProvider,
  type PlatformIntelligenceProvider,
  type PlatformIntelligenceTrace
} from "../platformIntelligence";
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
  /** Which pack entries influenced this deterministic policy view. */
  platformIntelligence?: PlatformIntelligenceTrace;
}

/** Platform policy view, kept out of the evidence engine. */
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

function packBackedPolicyNotes(
  source: SourceApplication,
  transport: TransportObservation | undefined,
  intelligence: PlatformIntelligenceProvider
): PolicyNotes | undefined {
  if (source.id !== SALESFORCE_PLATFORM_ID) return undefined;
  if (!transport) return NO_TRANSPORT_NOTES(SALESFORCE_PLATFORM_ID);

  const policy = intelligence.getBindingPolicy(source.id, transport);
  if (!policy) return undefined;

  return {
    platform: policy.platform,
    transportClass: policy.transportClass ?? "unknown",
    maximumEligibility: policy.maximumEligibility ?? "unresolved",
    ...(policy.preferredBindingFamily ? { preferredBindingFamily: policy.preferredBindingFamily } : {}),
    notes:
      policy.notes.length > 0
        ? policy.notes
        : ["The observed transport is not a recognized Salesforce interface."],
    warnings: policy.warnings,
    validationRequired: policy.validationRequired,
    platformIntelligence: policy.provenance
  };
}

export function createPackBackedBindingPolicyProvider(
  intelligence: PlatformIntelligenceProvider = defaultPlatformIntelligenceProvider
): BindingPolicyProvider {
  return {
    notesFor(source, transport) {
      return packBackedPolicyNotes(source, transport, intelligence) ?? genericPolicy.notesFor(source, transport);
    }
  }
}

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
export const defaultBindingPolicyProvider: BindingPolicyProvider = createPackBackedBindingPolicyProvider();

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
