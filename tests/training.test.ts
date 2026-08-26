import { describe, expect, it } from "vitest";
import { TrainingSession } from "../src/training/events";
import { confirmCandidate, parseSemanticizationResponse } from "../src/training/semanticizer";

describe("training capture and semanticizer contract", () => {
  it("captures normalized session observations", () => {
    const session = new TrainingSession();
    session.record({ type: "search", entity: "company", target: "company query", value: "Acme" });
    session.record({ type: "open", entity: "company", value: "acme" });
    session.record({ type: "filter", entity: "contact", target: "function", value: "Procurement" });

    expect(session.list()).toHaveLength(3);
    expect(session.list().map((event) => event.id)).toEqual(["event-1", "event-2", "event-3"]);
  });

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
