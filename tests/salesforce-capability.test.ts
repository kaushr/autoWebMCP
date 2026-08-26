import { describe, expect, it } from "vitest";
import { assertSemanticCapability } from "../src/semantic/model";
import { getOpportunityContextCapability } from "../src/semantic/salesforce";

describe("get_opportunity_context capability", () => {
  it("has a deterministic, read-only Salesforce contract", () => {
    expect(assertSemanticCapability(getOpportunityContextCapability)).toEqual(getOpportunityContextCapability);
    expect(getOpportunityContextCapability.id).toBe("get_opportunity_context");
    expect(getOpportunityContextCapability.inputs).toEqual([]);
    expect(getOpportunityContextCapability.binding).toBeUndefined();
    expect(getOpportunityContextCapability.safety).toEqual({ readOnly: true, requiresConfirmation: false });
  });
});
