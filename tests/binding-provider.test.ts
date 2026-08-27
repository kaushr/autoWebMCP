import { describe, expect, it } from "vitest";
import { localRegistryBindingProvider, resolveAdvertisedBinding } from "../src/training/bindingProvider";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import { findRelevantContactsProposal } from "../src/prospect/capabilities";
import { prospectBindings } from "../src/prospect/bindings";
import type { SemanticCapability, SourceApplication } from "../src/semantic/model";

const SIGNALBASE = sourceApplicationFor("prospect-intelligence", "127.0.0.1:5173");
const SALESFORCE = sourceApplicationFor("salesforce-lightning", "acme.lightning.force.com");

function taughtOn(source: SourceApplication, overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  return {
    ...findRelevantContactsProposal,
    ...overrides,
    provenance: { ...findRelevantContactsProposal.provenance, sourceApplication: source }
  };
}

describe("Source application identity", () => {
  it("labels the platforms Teach Mode recognizes", () => {
    expect(SIGNALBASE).toEqual({ id: "prospect-intelligence", label: "SignalBase" });
    expect(SALESFORCE).toEqual({ id: "salesforce-lightning", label: "Salesforce" });
  });

  it("falls back to the host for an application it does not recognize", () => {
    expect(sourceApplicationFor("generic", "erp.example.com")).toEqual({
      id: "generic",
      label: "erp.example.com"
    });
  });
});

describe("Binding provider adapter", () => {
  it("advertises exactly the execution bindings the taught site implements", () => {
    const advertised = localRegistryBindingProvider.getBindings(SIGNALBASE);
    expect(advertised.map((binding) => binding.action).sort()).toEqual(Object.keys(prospectBindings).sort());
    expect(advertised.every((binding) => binding.application === "prospect-intelligence")).toBe(true);
  });

  it("names the parameters each binding reads, so a human can rename inputs to match", () => {
    const find = localRegistryBindingProvider
      .getBindings(SIGNALBASE)
      .find((binding) => binding.action === "find_relevant_contacts");
    expect(find?.parameters).toEqual(["company", "function", "seniority", "title_keywords"]);
  });

  it("offers nothing for an application it knows no execution path for", () => {
    expect(localRegistryBindingProvider.getBindings(SALESFORCE)).toEqual([]);
    expect(localRegistryBindingProvider.getBindings(sourceApplicationFor("generic", "erp.example.com"))).toEqual([]);
    expect(localRegistryBindingProvider.getBindings(undefined)).toEqual([]);
  });
});

describe("Binding resolution", () => {
  it("leaves a capability the semanticizer could not bind unbound", () => {
    const taught = taughtOn(SIGNALBASE);
    expect(taught.binding).toBeUndefined();
    expect(resolveAdvertisedBinding(taught)).toBeUndefined();
  });

  it("never guesses: a name that merely resembles an action does not resolve", () => {
    const guessy = taughtOn(SIGNALBASE, {
      id: "find_decision_maker_contacts",
      binding: { application: "prospect-intelligence", action: "find_decision_maker_contacts" }
    });
    expect(resolveAdvertisedBinding(guessy)).toBeUndefined();
  });

  it("resolves once a human maps it to an advertised action", () => {
    const bound = taughtOn(SIGNALBASE, {
      binding: { application: "prospect-intelligence", action: "find_relevant_contacts" }
    });
    expect(resolveAdvertisedBinding(bound)?.action).toBe("find_relevant_contacts");
  });

  it("refuses to lend one application's actions to a capability taught on another", () => {
    const borrowed = taughtOn(SALESFORCE, {
      id: "update_opportunity_close_date_and_description",
      binding: { application: "prospect-intelligence", action: "find_relevant_contacts" }
    });
    expect(resolveAdvertisedBinding(borrowed)).toBeUndefined();
  });

  it("is swappable: another provider changes nothing about the capability", () => {
    const erp = sourceApplicationFor("generic", "erp.example.com");
    const bound: SemanticCapability = taughtOn(erp, {
      binding: { application: "generic", action: "lookup_buyers" }
    });
    const future = {
      getBindings: (source: SourceApplication | undefined) =>
        source?.id === "generic" ? [{ application: "generic", action: "lookup_buyers", parameters: ["account"] }] : []
    };

    expect(resolveAdvertisedBinding(bound)).toBeUndefined();
    expect(resolveAdvertisedBinding(bound, future)?.parameters).toEqual(["account"]);
  });
});
