import type { PlatformIntelligencePack } from "../schema";
import { PLATFORM_INTELLIGENCE_SCHEMA_VERSION } from "../schema";

export const SALESFORCE_PLATFORM_ID = "salesforce-lightning";

export const salesforceIntelligencePack: PlatformIntelligencePack = {
  packId: "salesforce-intelligence-pack",
  packVersion: "0.5.0",
  schemaVersion: PLATFORM_INTELLIGENCE_SCHEMA_VERSION,
  platform: {
    id: SALESFORCE_PLATFORM_ID,
    label: "Salesforce Lightning",
    vendor: "Salesforce"
  },
  sourceReferences: [
    {
      id: "sf-lwc-event-propagation",
      kind: "official-doc",
      title: "Lightning Web Components event propagation",
      url: "https://developer.salesforce.com/docs/platform/lwc/guide/events-propagation.html",
      reviewedAt: "2026-08-26"
    },
    {
      id: "sf-ui-record-api",
      kind: "official-doc",
      title: "Lightning UI Record API",
      url: "https://developer.salesforce.com/docs/platform/lwc/guide/reference-lightning-ui-api-record.html",
      reviewedAt: "2026-08-26"
    },
    {
      id: "sf-rest-record-api",
      kind: "official-doc",
      title: "Salesforce REST API record resources",
      url: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_sobject_basic_info.htm",
      reviewedAt: "2026-08-26"
    },
    {
      id: "sf-graphql-api",
      kind: "official-doc",
      title: "Salesforce GraphQL API",
      url: "https://developer.salesforce.com/docs/platform/graphql/guide/graphql-about.html",
      reviewedAt: "2026-08-26"
    },
    {
      id: "sf-standard-opportunity-fields",
      kind: "official-doc",
      title: "Salesforce standard objects: Opportunity",
      url: "https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_opportunity.htm",
      reviewedAt: "2026-08-27",
      note: "Standard field API names, default labels, and types for the fields this proving ground demonstrates."
    },
    {
      id: "awmcp-application-intelligence",
      kind: "internal-architecture",
      title: "AutoWebMCP Application Intelligence architecture",
      document: "docs/APPLICATION_INTELLIGENCE.md",
      reviewedAt: "2026-08-27"
    },
    {
      id: "awmcp-platform-intelligence",
      kind: "internal-architecture",
      title: "AutoWebMCP Platform Intelligence architecture",
      document: "docs/PLATFORM_INTELLIGENCE.md",
      reviewedAt: "2026-08-26"
    },
    {
      id: "awmcp-binding-decisions",
      kind: "internal-architecture",
      title: "AutoWebMCP binding and validation ADRs",
      document: "docs/DECISIONS.md",
      reviewedAt: "2026-08-26"
    },
    {
      id: "awmcp-salesforce-recording",
      kind: "internal-evidence",
      title: "AutoWebMCP first Salesforce recording findings",
      document: "docs/RECORDING_FOUNDATION.md",
      reviewedAt: "2026-08-26"
    }
  ],
  knowledge: [
    {
      id: "sf-lwc-host-event-retargeting",
      category: "observation-semantics",
      strength: "documented-fact",
      summary: "Lightning Web Component events may be retargeted at component hosts across shadow boundaries.",
      appliesTo: "events",
      sourceReferenceIds: ["sf-lwc-event-propagation", "awmcp-salesforce-recording"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["lightning", "events", "shadow-dom"]
    },
    {
      id: "sf-native-controls-may-be-encapsulated",
      category: "component-framework-behavior",
      strength: "documented-fact",
      summary: "Underlying native controls may be hidden behind Lightning component and shadow DOM boundaries.",
      appliesTo: "shadow-dom",
      sourceReferenceIds: ["sf-lwc-event-propagation", "awmcp-salesforce-recording"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["lightning", "controls", "shadow-dom"]
    },
    {
      id: "sf-composed-tree-resolution-required",
      category: "resolution-policy",
      strength: "validated-platform-rule",
      summary:
        "Lightning UI must be resolved across the composed tree: controls, their labels and their actions routinely sit inside component shadow roots, and application field identifiers are the strongest identity evidence available.",
      resolution: {
        traversal: "composed-tree",
        shadowRoots: "recursive",
        eventRetargeting: true,
        identityPriority: ["applicationIdentifier", "accessibleName", "section"]
      },
      sourceReferenceIds: ["sf-lwc-event-propagation", "awmcp-salesforce-recording", "awmcp-platform-intelligence"],
      lifecycle: { status: "active", since: "0.2.0" },
      tags: ["lightning", "shadow-dom", "resolution", "execution"]
    },
    {
      id: "sf-record-edit-surface-semantics",
      category: "page-state-semantics",
      strength: "validated-platform-rule",
      summary:
        "A visible dialog is not evidence that a record is being edited: Lightning record pages carry dialog-role surfaces (docked utility bar, panels) in plain read-only view. A record-edit surface is established by Salesforce's record-edit component, or structurally by a surface holding multiple editable record fields together with a Save commit action; a Cancel action is supporting evidence only.",
      pageState: {
        genericDialogIsNotEditEvidence: true,
        editSurface: {
          componentEvidence: ["lightning-record-edit-form", "records-record-edit", "record-edit-form"],
          minimumEditableFields: 2,
          commitActionLabels: ["save"],
          dismissActionLabels: ["cancel"]
        }
      },
      sourceReferenceIds: ["sf-lwc-event-propagation", "awmcp-salesforce-recording"],
      lifecycle: { status: "active", since: "0.3.0" },
      tags: ["lightning", "page-state", "record-edit", "execution"]
    },
    {
      id: "sf-save-verification-semantics",
      category: "verification-semantics",
      strength: "validated-platform-rule",
      summary:
        "A blocking validation error keeps the record-edit surface open with the error rendered inside it; once the edit surface has closed, the save was not blocked. Salesforce's post-save success notification itself carries alert semantics, so a generic role=alert sweep misreads a successful save as a validation failure — notification components are never validation evidence.",
      verification: {
        blockingValidationHoldsEditSurfaceOpen: true,
        successNotificationMatchesAlertRole: true,
        notificationComponentClasses: ["slds-notify", "toast", "slds-notify_container", "forceToastMessage"],
        notificationRoles: ["status", "log"]
      },
      sourceReferenceIds: ["awmcp-salesforce-recording", "awmcp-platform-intelligence"],
      lifecycle: { status: "active", since: "0.4.0" },
      tags: ["lightning", "verification", "toast", "validation", "execution"]
    },
    {
      id: "sf-standard-application-model",
      category: "application-schema",
      strength: "documented-fact",
      summary:
        "Salesforce Summer '26 standard object model, limited to the fields this proving ground has demonstrated. " +
        "Standard knowledge carries no picklist values: what an org's stages actually are is tenant configuration, " +
        "even for a standard field.",
      sourceReferenceIds: ["sf-standard-opportunity-fields", "awmcp-application-intelligence"],
      applicationSchema: {
        release: "summer-26",
        objects: [
          {
            apiName: "Opportunity",
            fields: [
              { apiName: "CloseDate", defaultLabel: "Close Date", type: "date" },
              { apiName: "StageName", defaultLabel: "Stage", type: "picklist" }
            ]
          }
        ]
      }
    },
    {
      id: "sf-missing-value-is-not-no-value",
      category: "observation-semantics",
      strength: "validated-platform-rule",
      summary: "A missing captured value does not prove that no value exists; it may indicate component encapsulation.",
      appliesTo: "values",
      sourceReferenceIds: ["awmcp-platform-intelligence", "awmcp-salesforce-recording"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["values", "capture"]
    },
    {
      id: "sf-dom-text-not-field-value",
      category: "deterministic-rule",
      strength: "validated-platform-rule",
      summary: "Component or container text is not a reliable field value for durable binding decisions.",
      rule: {
        id: "sf-dom-text-not-field-value",
        when: "Lightning component text is the only apparent value source.",
        effect: "require-validation"
      },
      sourceReferenceIds: ["awmcp-binding-decisions", "awmcp-salesforce-recording"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["values", "capture", "binding"]
    },
    {
      id: "sf-observed-transport-requires-validation",
      category: "deterministic-rule",
      strength: "documented-policy",
      summary: "An observed Salesforce transport cannot become a supported binding without validation.",
      rule: {
        id: "sf-observed-transport-requires-validation",
        when: "A Salesforce execution transport was observed for a candidate binding.",
        effect: "cap-eligibility",
        maximumEligibility: "needs-validation"
      },
      sourceReferenceIds: ["awmcp-platform-intelligence", "awmcp-binding-decisions"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["binding", "eligibility", "policy"]
    },
    {
      id: "sf-aura-many-posts",
      category: "execution-semantics",
      strength: "observed-pattern",
      summary: "Salesforce Lightning may emit many POST /aura requests around one visible user action.",
      transport: { method: "POST", pathPattern: /\/aura\b/ },
      sourceReferenceIds: ["awmcp-salesforce-recording", "awmcp-platform-intelligence"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["aura", "execution-evidence"]
    },
    {
      id: "sf-post-alone-not-business-mutation",
      category: "deterministic-rule",
      strength: "validated-platform-rule",
      summary: "HTTP POST alone does not establish that a business mutation occurred.",
      rule: {
        id: "sf-post-alone-not-business-mutation",
        when: "The only execution evidence is a POST method.",
        effect: "require-validation",
        maximumEligibility: "needs-validation"
      },
      transport: { method: "POST" },
      sourceReferenceIds: ["awmcp-binding-decisions", "awmcp-salesforce-recording"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["execution-evidence", "eligibility"]
    },
    {
      id: "sf-aura-private-internal",
      category: "deterministic-rule",
      strength: "documented-policy",
      summary: "The observed transport is Salesforce's internal Aura endpoint.",
      rule: {
        id: "sf-aura-private-internal",
        when: "A causal candidate uses the /aura endpoint.",
        effect: "classify-transport",
        transportClass: "private-internal",
        maximumEligibility: "needs-validation"
      },
      transport: { pathPattern: /\/aura\b/ },
      sourceReferenceIds: ["awmcp-platform-intelligence", "awmcp-binding-decisions"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["aura", "private-transport"]
    },
    {
      id: "sf-operation-names-inform-evidence",
      category: "heuristic",
      strength: "heuristic",
      summary: "Operation names in observed Lightning traffic can provide useful execution evidence, without proving a supported binding.",
      transport: { pathPattern: /\/aura\b/ },
      sourceReferenceIds: ["awmcp-platform-intelligence", "awmcp-salesforce-recording"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["aura", "operation-name"]
    },
    {
      id: "sf-recordui-update-record-suggests-record-update",
      category: "binding-knowledge",
      strength: "heuristic",
      summary: "An observed RecordUi.updateRecord operation suggests a Salesforce record-update binding family.",
      binding: {
        observedOperationPattern: /RecordUi\.(update|create|delete)Record/i,
        preferredBindingFamily: "salesforce-record-update",
        eligibilityCeiling: "needs-validation",
        mechanism: "A supported Salesforce record-update interface",
        validationRequired: [
          "Identify the supported Salesforce interface equivalent to the observed operation",
          "Verify object and field-level permissions for the intended user",
          "Verify how the capability's inputs map onto that interface"
        ]
      },
      transport: {
        pathPattern: /\/aura\b/,
        operationPattern: /RecordUi\.(update|create|delete)Record/i
      },
      sourceReferenceIds: ["sf-ui-record-api", "sf-rest-record-api", "awmcp-platform-intelligence"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["binding", "record-update"]
    },
    {
      id: "sf-lds-ui-api-supported",
      category: "supported-interface",
      strength: "documented-fact",
      summary: "Lightning Data Service and the UI API family are supported Salesforce record interfaces.",
      interface: {
        id: "salesforce-lds-ui-api",
        family: "salesforce-record-update",
        label: "Lightning Data Service / UI API",
        status: "supported",
        operationFamilies: ["record-read", "record-update"],
        notes: ["Use through an approved Salesforce runtime context such as Lightning UI Record API."]
      },
      sourceReferenceIds: ["sf-ui-record-api"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["supported-interface", "record-update"]
    },
    {
      id: "sf-rest-record-api-supported",
      category: "supported-interface",
      strength: "documented-fact",
      summary: "Salesforce REST record APIs are supported interfaces for record operations where authentication and permissions are established.",
      interface: {
        id: "salesforce-rest-record-api",
        family: "salesforce-record-update",
        label: "REST record APIs",
        status: "supported",
        operationFamilies: ["record-read", "record-update"],
        notes: ["Requires supported authentication and permission checks before validation can pass."]
      },
      sourceReferenceIds: ["sf-rest-record-api"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["supported-interface", "record-update"]
    },
    {
      id: "sf-graphql-supported",
      category: "supported-interface",
      strength: "documented-fact",
      summary: "Salesforce GraphQL is a supported interface family where it fits the operation and runtime context.",
      interface: {
        id: "salesforce-graphql",
        family: "salesforce-query",
        label: "Salesforce GraphQL API",
        status: "supported",
        operationFamilies: ["query"],
        notes: ["Relevant for supported query use cases, not a direct substitute for unvalidated Aura replay."]
      },
      sourceReferenceIds: ["sf-graphql-api"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["supported-interface", "graphql"]
    },
    {
      id: "sf-no-aura-replay",
      category: "policy",
      strength: "documented-policy",
      summary: "Observed Aura transport must not be directly replayed merely because it correlated with a user action.",
      policy: {
        id: "sf-no-aura-replay",
        effect: "prohibit-direct-replay",
        warning: "Aura is an internal, unversioned Salesforce transport and must never be replayed directly.",
        validationRequired: ["Identify the supported Salesforce interface equivalent to the observed operation"]
      },
      transport: { pathPattern: /\/aura\b/ },
      sourceReferenceIds: ["awmcp-platform-intelligence", "awmcp-binding-decisions"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["aura", "policy", "direct-replay"]
    },
    {
      id: "sf-no-session-credential-extraction",
      category: "policy",
      strength: "documented-policy",
      summary: "AutoWebMCP must not extract Salesforce session credentials.",
      policy: {
        id: "sf-no-session-credential-extraction",
        effect: "prohibit-credential-extraction",
        warning: "Do not extract Salesforce session credentials, cookies, bearer tokens, or CSRF material.",
        validationRequired: ["Use a supported authenticated runtime path that does not expose session material"]
      },
      sourceReferenceIds: ["awmcp-binding-decisions"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["credentials", "policy"]
    },
    {
      id: "sf-dom-internals-not-contract",
      category: "policy",
      strength: "documented-policy",
      summary: "Lightning DOM internals are not durable runtime execution contracts.",
      policy: {
        id: "sf-dom-internals-not-contract",
        effect: "require-validation",
        warning: "Do not treat Lightning DOM internals as durable runtime execution contracts.",
        validationRequired: ["Validate the binding through a supported Salesforce interface"]
      },
      sourceReferenceIds: ["awmcp-platform-intelligence", "awmcp-binding-decisions"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["dom", "policy", "binding"]
    },
    {
      id: "sf-antipattern-aura-replay",
      category: "anti-pattern",
      strength: "documented-policy",
      summary: "Aura replay is an anti-pattern and cannot be promoted to an execution binding.",
      antiPattern: {
        id: "sf-antipattern-aura-replay",
        prohibited: true,
        warning: "Never promote observed Aura replay into an execution binding."
      },
      transport: { pathPattern: /\/aura\b/ },
      sourceReferenceIds: ["awmcp-platform-intelligence", "awmcp-binding-decisions"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["anti-pattern", "aura"]
    },
    {
      id: "sf-antipattern-selector-contract",
      category: "anti-pattern",
      strength: "documented-policy",
      summary: "DOM-selector-based durable binding contracts are an anti-pattern for Salesforce Lightning.",
      antiPattern: {
        id: "sf-antipattern-selector-contract",
        prohibited: true,
        warning: "Do not create durable Salesforce bindings from Lightning DOM selectors."
      },
      sourceReferenceIds: ["awmcp-platform-intelligence", "awmcp-binding-decisions"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["anti-pattern", "dom"]
    },
    {
      id: "sf-reference-recording-close-date",
      category: "reference",
      strength: "observed-pattern",
      summary: "The first Salesforce recording showed a Close Date edit followed by Aura RecordUi update evidence and a visible Save reaction.",
      sourceReferenceIds: ["awmcp-salesforce-recording"],
      lifecycle: { status: "active", since: "0.1.0" },
      tags: ["reference", "salesforce-recording"]
    }
  ]
};
