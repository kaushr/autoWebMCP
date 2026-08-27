import { describe, expect, it } from "vitest";
import { confirmCandidate, parseSemanticizationResponse } from "../src/training/semanticizer";

describe("semanticizer contract", () => {
  it("accepts a bounded semanticizer candidate and confirms it", () => {
    const candidate = parseSemanticizationResponse({
      candidate: {
        id: "find_relevant_contacts",
        name: "Find Relevant Contacts",
        description: "Find contacts at a company by function.",
        inputs: [{ name: "company", description: "Company name.", type: "string", required: true }],
        outputs: [{ name: "contacts", description: "Matching contacts.", type: "array" }],
        binding: { application: "prospect-intelligence", action: "find_contacts" },
        provenance: { source: "inferred", observationIds: ["event-1"], confirmedByHuman: false },
        safety: { readOnly: true, requiresConfirmation: false }
      },
      ambiguities: []
    });

    expect(confirmCandidate(candidate.candidate).provenance).toMatchObject({
      source: "confirmed",
      confirmedByHuman: true
    });
  });
});
