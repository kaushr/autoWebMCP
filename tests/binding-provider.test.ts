import { describe, expect, it } from "vitest";
import { localRegistryBindingProvider, resolveAdvertisedBinding } from "../src/training/bindingProvider";
import { findRelevantContactsProposal } from "../src/prospect/capabilities";
import { prospectBindings } from "../src/prospect/bindings";
import type { SemanticCapability } from "../src/semantic/model";

describe("Binding provider adapter", () => {
  it("advertises exactly the execution bindings the taught site implements", () => {
    const advertised = localRegistryBindingProvider.list();
    expect(advertised.map((binding) => binding.action).sort()).toEqual(Object.keys(prospectBindings).sort());
    expect(advertised.every((binding) => binding.application === "prospect-intelligence")).toBe(true);
  });

  it("names the parameters each binding reads, so a human can rename inputs to match", () => {
    expect(localRegistryBindingProvider.find("prospect-intelligence", "find_relevant_contacts")?.parameters).toEqual([
      "company",
      "function",
      "seniority",
      "title_keywords"
    ]);
  });

  it("does not advertise an action the site cannot run", () => {
    expect(localRegistryBindingProvider.find("prospect-intelligence", "find_decision_maker_contacts")).toBeUndefined();
    expect(localRegistryBindingProvider.find("salesforce-lightning", "find_relevant_contacts")).toBeUndefined();
  });
});

describe("Binding resolution", () => {
  const taught: SemanticCapability = {
    ...findRelevantContactsProposal,
    id: "find_decision_maker_contacts",
    name: "Find decision-maker contacts"
  };

  it("leaves a capability the semanticizer could not bind unbound", () => {
    expect(taught.binding).toBeUndefined();
    expect(resolveAdvertisedBinding(taught)).toBeUndefined();
  });

  it("never guesses: a name that merely resembles an action does not resolve", () => {
    const guessy: SemanticCapability = {
      ...taught,
      binding: { application: "prospect-intelligence", action: "find_decision_maker_contacts" }
    };
    expect(resolveAdvertisedBinding(guessy)).toBeUndefined();
  });

  it("resolves once a human maps it to an advertised action", () => {
    const bound: SemanticCapability = {
      ...taught,
      binding: { application: "prospect-intelligence", action: "find_relevant_contacts" }
    };
    expect(resolveAdvertisedBinding(bound)?.action).toBe("find_relevant_contacts");
  });

  it("is swappable: another provider changes nothing about the capability", () => {
    const bound: SemanticCapability = {
      ...taught,
      binding: { application: "acme-erp", action: "lookup_buyers" }
    };
    const future = {
      list: () => [{ application: "acme-erp", action: "lookup_buyers", parameters: ["account"] }],
      find(application: string, action: string) {
        return this.list().find((b) => b.application === application && b.action === action);
      }
    };

    expect(resolveAdvertisedBinding(bound)).toBeUndefined();
    expect(resolveAdvertisedBinding(bound, future)?.parameters).toEqual(["account"]);
  });
});
