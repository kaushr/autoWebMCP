import type { SemanticCapability } from "./model";

/** The first useful Salesforce capability is read-only and page-context bound. */
export const getOpportunityContextCapability: SemanticCapability = {
  id: "get_opportunity_context",
  name: "Get Opportunity Context",
  description: "Get structured business context for the Salesforce Opportunity represented by the current page.",
  inputs: [],
  outputs: [{
    name: "opportunity_context",
    description: "The current Opportunity and its Account, stage, close date, amount, and forecast category.",
    type: "object"
  }],
  binding: { application: "salesforce", action: "GET_OPPORTUNITY_CONTEXT" },
  provenance: { source: "configured", observationIds: [], confirmedByHuman: false },
  safety: { readOnly: true, requiresConfirmation: false }
};
