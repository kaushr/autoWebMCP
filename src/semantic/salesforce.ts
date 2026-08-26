import type { SemanticCapability } from "./model";

/** A semantic candidate retained independently of its execution binding. */
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
  provenance: { source: "configured", observationIds: [], confirmedByHuman: false },
  safety: { readOnly: true, requiresConfirmation: false }
};
