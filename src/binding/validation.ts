import type { SourceApplication } from "../semantic/model";
import type { PlatformIntelligenceTrace } from "../platformIntelligence";
import type { BindingCandidateProposal } from "./model";

/* ------------------------------------------------------------------ *
 * Binding validation.
 *
 *   EXECUTION EVIDENCE        what the application appeared to do
 *   BINDING CANDIDATE         a mechanism worth investigating
 *   VALIDATED BINDING         a mechanism proven usable safely   ← here
 *
 * A candidate becomes a binding only through deterministic proof. A model
 * saying "UI API seems appropriate" is not validation; an actual supported
 * read, write, and read-back is. Nothing here executes anything on its own,
 * and a validator that cannot prove its case says so.
 * ------------------------------------------------------------------ */

export type BindingValidationStatus = "validated" | "failed" | "inconclusive" | "requires-setup";

export type CheckStatus = "pass" | "fail" | "blocked" | "skipped";

/** One gate in the validation sequence, recorded whether or not it passed. */
export interface ValidationCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** How the runtime obtains the record a capability should act on. */
export interface ContextRequirement {
  name: string;
  description: string;
  satisfiedBy: string | null;
}

/**
 * A mechanism proven usable. Deliberately a description, not a script: it names
 * an operation and how inputs reach it, and carries no URL, payload, header, or
 * code. A runtime consumes this; validation never becomes one.
 */
export interface ExecutionBinding {
  id: string;
  application: string;
  bindingFamily: string;
  operation: string;
  /** Semantic input name → the application field it drives. */
  inputMapping: Record<string, string>;
  contextRequirements: ContextRequirement[];
  safety: {
    usesSupportedInterface: boolean;
    replaysPrivateTransport: false;
    extractsCredentials: false;
    runsAsCurrentUser: boolean;
  };
  validationEvidence: string[];
}

export interface BindingValidationResult {
  capabilityId: string;
  sourceApplication: SourceApplication;
  adapter: string;
  status: BindingValidationStatus;
  /** Present only when status is `validated`. */
  binding?: ExecutionBinding;
  checks: ValidationCheck[];
  evidence: string[];
  warnings: string[];
  /** What a human would have to arrange before validation could proceed. */
  requirements: string[];
  /** Which platform intelligence entries informed the adapter's decision, if any. */
  platformIntelligence?: PlatformIntelligenceTrace;
  validatedAt: string;
}

export interface ValidationContext {
  capabilityId: string;
  capabilityInputs: Array<{ name: string; required: boolean }>;
  sourceApplication: SourceApplication;
  candidate: BindingCandidateProposal;
  /** Deterministic field evidence recovered from the capture. */
  fieldMapping: Record<string, string>;
  fieldMappingAmbiguities: string[];
  /** Object/record type observed in the capture, when the path revealed one. */
  observedRecordType?: string;
  validatedAt: string;
}

/** Platform-specific proof lives in adapters; generic code stays vendor-free. */
export interface BindingValidator {
  id: string;
  supports(context: ValidationContext): boolean;
  validate(context: ValidationContext): Promise<BindingValidationResult>;
}

export function inconclusive(
  context: ValidationContext,
  adapter: string,
  detail: string,
  checks: ValidationCheck[] = []
): BindingValidationResult {
  return {
    capabilityId: context.capabilityId,
    sourceApplication: context.sourceApplication,
    adapter,
    status: "inconclusive",
    checks,
    evidence: [],
    warnings: [detail],
    requirements: [],
    validatedAt: context.validatedAt
  };
}

/**
 * Runs the first validator that claims the case. No validator means the
 * capability is on an application nothing knows how to prove, which is an
 * honest inconclusive rather than a reason to try something unsupported.
 */
export async function runBindingValidation(
  context: ValidationContext,
  validators: readonly BindingValidator[]
): Promise<BindingValidationResult> {
  const validator = validators.find((entry) => entry.supports(context));
  if (!validator) {
    return inconclusive(
      context,
      "none",
      `No validator claims ${context.sourceApplication.label}; a supported execution mechanism has not been established for it.`
    );
  }
  return validator.validate(context);
}

/**
 * Validation proves a mechanism works. It does not decide the mechanism should
 * be used — that stays a human judgement, so a validated result is offered for
 * acceptance rather than installed.
 */
export type ValidatedBindingState = "none" | "validated" | "accepted" | "rejected";

export interface BindingValidationRecord {
  state: ValidatedBindingState;
  result: BindingValidationResult;
}

/** The gate publication reads. Acceptance, not validation, unlocks it. */
export function acceptedBinding(record: BindingValidationRecord | undefined): ExecutionBinding | undefined {
  if (!record || record.state !== "accepted") return undefined;
  return record.result.binding;
}
