import { SALESFORCE_PLATFORM_ID, defaultPlatformIntelligenceProvider } from "../../platformIntelligence";
import type { BindingValidator, BindingValidationResult, ValidationCheck, ValidationContext } from "../validation";

/**
 * Salesforce record update.
 *
 * The supported mechanism is UI API / Lightning Data Service. It enforces the
 * running user's CRUD, FLS and sharing, and it is what Lightning itself uses —
 * exactly the "existing execution path" the architecture wants to bind to
 * rather than reimplement.
 *
 * The obstacle is reach, not suitability. UI API is not callable from an
 * extension content script or a generic browser runtime: it lives on the
 * instance host rather than the Lightning host, and authenticates with a bearer
 * token rather than the page's cookies. Every route to it needs something this
 * project has ruled out or not approved — Salesforce-hosted code, an OAuth
 * Connected App, or extracting the session id.
 *
 * So this validator gets as far as it honestly can. It proves the field mapping
 * and the record-context contract deterministically, then reports the reach gate
 * as `requires-setup` and names precisely what would unblock it. It never falls
 * back to replaying `/aura`: a validation failure is not a licence to use the
 * private transport the candidate warned about.
 */
const ADAPTER = "salesforce-record-update/0.1";

export const salesforceRecordUpdateValidator: BindingValidator = {
  id: ADAPTER,

  supports(context: ValidationContext): boolean {
    return (
      context.sourceApplication.id === "salesforce-lightning" &&
      context.candidate.candidate?.bindingFamily === "salesforce-record-update"
    );
  },

  async validate(context: ValidationContext): Promise<BindingValidationResult> {
    const checks: ValidationCheck[] = [];
    const evidence: string[] = [];
    const warnings: string[] = [];
    const supportedInterfaces = defaultPlatformIntelligenceProvider.getSupportedInterfaces(SALESFORCE_PLATFORM_ID, {
      family: "salesforce-record-update"
    });
    const pack = defaultPlatformIntelligenceProvider.getPack(SALESFORCE_PLATFORM_ID);
    const platformIntelligence =
      pack && supportedInterfaces.length > 0
        ? {
            packId: pack.packId,
            packVersion: pack.packVersion,
            schemaVersion: pack.schemaVersion,
            knowledgeEntryIds: supportedInterfaces.map((entry) => entry.id),
            sourceReferenceIds: [...new Set(supportedInterfaces.flatMap((entry) => entry.sourceReferenceIds))]
          }
        : undefined;

    /* --- record context ------------------------------------------------ */
    const recordType = context.observedRecordType;
    checks.push(
      recordType
        ? {
            name: "Record type observed",
            status: "pass",
            detail: `The capture occurred on a ${recordType} record page.`
          }
        : {
            name: "Record type observed",
            status: "fail",
            detail: "The capture did not reveal which object type the workflow acted on."
          }
    );
    if (recordType) evidence.push(`Object type resolved from the captured page path: ${recordType}.`);

    /* --- field mapping -------------------------------------------------- */
    const mapped = Object.keys(context.fieldMapping);
    const unmapped = context.capabilityInputs.filter((input) => !mapped.includes(input.name));

    if (context.fieldMappingAmbiguities.length > 0) {
      checks.push({
        name: "Field mapping",
        status: "fail",
        detail: context.fieldMappingAmbiguities.join(" ")
      });
    } else if (unmapped.length > 0) {
      checks.push({
        name: "Field mapping",
        status: "fail",
        detail: `No application field identifier was established for: ${unmapped
          .map((input) => input.name)
          .join(", ")}.`
      });
    } else {
      checks.push({
        name: "Field mapping",
        status: "pass",
        detail: Object.entries(context.fieldMapping)
          .map(([input, field]) => `${input} → ${recordType ?? "record"}.${field}`)
          .join(", ")
      });
      for (const [input, field] of Object.entries(context.fieldMapping)) {
        evidence.push(`"${input}" maps to the application's own field identifier "${field}".`);
      }
    }

    /* --- reach: the gate that actually blocks --------------------------- */
    checks.push({
      name: "Supported mechanism reachable",
      status: "blocked",
      detail:
        `${supportedInterfaces[0]?.interface.label ?? "UI API / Lightning Data Service"} is the supported mechanism, but it is not reachable from the ` +
        "browser context AutoWebMCP runs in. It is hosted on the instance origin rather than the Lightning " +
        "origin and authenticates with a bearer token, not the page session cookie."
    });
    checks.push({ name: "Permission check", status: "skipped", detail: "Not attempted: the mechanism was unreachable." });
    checks.push({ name: "Controlled write", status: "skipped", detail: "Not attempted: the mechanism was unreachable." });
    checks.push({ name: "Read-back verification", status: "skipped", detail: "Not attempted: no write was made." });
    checks.push({ name: "Restore original value", status: "skipped", detail: "Not attempted: no write was made." });

    warnings.push(
      "No Salesforce record was read or written. No credential, cookie, session id, or token was accessed.",
      "The observed /aura transport remains prohibited; an unreachable supported mechanism is not a reason to use it."
    );

    return {
      capabilityId: context.capabilityId,
      sourceApplication: context.sourceApplication,
      adapter: ADAPTER,
      status: "requires-setup",
      checks,
      evidence,
      warnings,
      requirements: [
        "A supported way to reach UI API / Lightning Data Service from the runtime context, which today means one of: Salesforce-hosted code invoking lightning/uiRecordApi, an OAuth Connected App, or a delegated mechanism that does not expose session material.",
        "Confirmation of object and field-level permissions for the intended user once a mechanism is reachable.",
        "A sandbox record and a test-safe value before any controlled write is attempted."
      ],
      ...(platformIntelligence ? { platformIntelligence } : {}),
      validatedAt: context.validatedAt
    };
  }
};
