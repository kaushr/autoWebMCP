import { describe, expect, it } from "vitest";
import { confirmCandidate } from "../src/training/semanticizer";
import { localRegistryBindingProvider, resolveAdvertisedBinding } from "../src/training/bindingProvider";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import { assertPublishable } from "../src/webmcp/publication";
import type { SemanticCapability } from "../src/semantic/model";

const publishable = (capability: SemanticCapability): boolean =>
  capability.provenance.confirmedByHuman && Boolean(resolveAdvertisedBinding(capability));

/**
 * The capability a real Teach Mode session produced from a Salesforce
 * Opportunity. AutoWebMCP understands it and has no idea how to run it, and
 * both of those are true at once.
 */
const salesforceCandidate: SemanticCapability = {
  id: "update_opportunity_close_date_and_description",
  name: "Update opportunity close date and description",
  description: "Modify an opportunity record by changing its close date and description, then save the updated record.",
  inputs: [
    { name: "close_date", description: "The new close date.", type: "string", required: true },
    { name: "description", description: "The new description.", type: "string", required: false }
  ],
  outputs: [{ name: "opportunity", description: "The updated opportunity.", type: "object" }],
  provenance: {
    source: "inferred",
    observationIds: ["click-1", "field_change-2", "submit-3"],
    confirmedByHuman: false,
    sourceApplication: sourceApplicationFor("salesforce-lightning", "acme.lightning.force.com")
  },
  safety: { readOnly: false, requiresConfirmation: true }
};

describe("A capability learned where we cannot execute", () => {
  it("identifies the application it was learned from", () => {
    expect(salesforceCandidate.provenance.sourceApplication).toEqual({
      id: "salesforce-lightning",
      label: "Salesforce"
    });
  });

  it("is offered no execution bindings at all, least of all another application's", () => {
    const offered = localRegistryBindingProvider.getBindings(salesforceCandidate.provenance.sourceApplication);
    expect(offered).toEqual([]);
    expect(offered.some((binding) => binding.application === "prospect-intelligence")).toBe(false);
  });

  it("can still be confirmed, because confirmation judges meaning", () => {
    const confirmed = confirmCandidate(salesforceCandidate);
    expect(confirmed.provenance.confirmedByHuman).toBe(true);
    expect(confirmed.provenance.source).toBe("confirmed");
    expect(confirmed.name).toBe("Update opportunity close date and description");
  });

  it("stays unpublishable after confirmation", () => {
    const confirmed = confirmCandidate(salesforceCandidate);
    expect(resolveAdvertisedBinding(confirmed)).toBeUndefined();
    expect(publishable(confirmed)).toBe(false);
    expect(() => assertPublishable(confirmed)).toThrow(/no execution binding/);
  });

  it("cannot be rescued by pointing it at an action from somewhere else", () => {
    const borrowed = confirmCandidate({
      ...salesforceCandidate,
      binding: { application: "prospect-intelligence", action: "find_relevant_contacts" }
    });
    expect(resolveAdvertisedBinding(borrowed)).toBeUndefined();
    expect(publishable(borrowed)).toBe(false);
    expect(() => assertPublishable(borrowed)).toThrow(/must belong to the application/);
  });
});

describe("A capability learned where we can execute", () => {
  const signalbaseCandidate: SemanticCapability = {
    id: "find_decision_maker_contact",
    name: "Find decision maker contact",
    description: "Find relevant contacts at a company by business function and seniority.",
    inputs: [
      { name: "company", description: "The company to research.", type: "string", required: true },
      { name: "function", description: "Business function.", type: "string", required: false },
      { name: "seniority", description: "Seniority.", type: "string", required: false }
    ],
    outputs: [{ name: "contacts", description: "Matching contacts.", type: "array" }],
    provenance: {
      source: "inferred",
      observationIds: ["navigate-1"],
      confirmedByHuman: false,
      sourceApplication: sourceApplicationFor("prospect-intelligence", "127.0.0.1:5173")
    },
    safety: { readOnly: true, requiresConfirmation: false }
  };

  it("is offered its own application's bindings", () => {
    const offered = localRegistryBindingProvider.getBindings(signalbaseCandidate.provenance.sourceApplication);
    expect(offered.map((binding) => binding.action)).toContain("find_relevant_contacts");
    expect(offered.every((binding) => binding.application === "prospect-intelligence")).toBe(true);
  });

  it("can be confirmed before a binding is chosen, and is not publishable yet", () => {
    const confirmed = confirmCandidate(signalbaseCandidate);
    expect(confirmed.provenance.confirmedByHuman).toBe(true);
    expect(publishable(confirmed)).toBe(false);
  });

  it("becomes publishable once the human binds it, in either order", () => {
    const confirmedThenBound: SemanticCapability = {
      ...confirmCandidate(signalbaseCandidate),
      binding: { application: "prospect-intelligence", action: "find_relevant_contacts" }
    };
    const boundThenConfirmed = confirmCandidate({
      ...signalbaseCandidate,
      binding: { application: "prospect-intelligence", action: "find_relevant_contacts" }
    });

    expect(publishable(confirmedThenBound)).toBe(true);
    expect(publishable(boundThenConfirmed)).toBe(true);
    expect(() => assertPublishable(confirmedThenBound)).not.toThrow();
    expect(() => assertPublishable(boundThenConfirmed)).not.toThrow();
  });

  it("is not publishable on a binding alone", () => {
    const boundOnly: SemanticCapability = {
      ...signalbaseCandidate,
      binding: { application: "prospect-intelligence", action: "find_relevant_contacts" }
    };
    expect(publishable(boundOnly)).toBe(false);
    expect(() => assertPublishable(boundOnly)).toThrow(/human-confirmed/);
  });
});
