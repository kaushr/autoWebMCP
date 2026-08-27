import { describe, expect, it } from "vitest";
import { findRelevantContactsProposal, referenceCapabilities } from "../src/prospect/capabilities";
import { bindingActionFor, invokeProspectBinding, prospectBindings } from "../src/prospect/bindings";
import { confirmCandidate } from "../src/training/semanticizer";
import { assertPublishable, parsePublicationList } from "../src/webmcp/publication";
import { compileCapability, registerCapability } from "../src/webmcp/compiler";
import type { WebMcpTool } from "../src/webmcp/types";
import { describeReadiness } from "../src/prospect/app/agentReadiness";
import type { SemanticCapability } from "../src/semantic/model";

describe("Publication gate", () => {
  it("refuses to publish a capability the model merely proposed", () => {
    expect(() => assertPublishable(findRelevantContactsProposal)).toThrow(/human-confirmed/);
  });

  it("refuses a capability whose provenance claims confirmation without a human", () => {
    const forged: SemanticCapability = {
      ...findRelevantContactsProposal,
      provenance: { source: "confirmed", observationIds: [], confirmedByHuman: false }
    };
    expect(() => assertPublishable(forged)).toThrow(/human-confirmed/);
  });

  it("accepts a capability a human confirmed", () => {
    expect(() => assertPublishable(confirmCandidate(findRelevantContactsProposal))).not.toThrow();
  });

  it("rejects an unconfirmed capability arriving from the control plane", () => {
    const list = { publications: [{ capability: findRelevantContactsProposal, publishedAt: "2026-08-26T18:00:00Z" }] };
    expect(() => parsePublicationList(list)).toThrow(/human-confirmed/);
  });

  it("reads back a confirmed publication", () => {
    const list = {
      publications: [
        { capability: confirmCandidate(findRelevantContactsProposal), publishedAt: "2026-08-26T18:00:00Z" }
      ]
    };
    expect(parsePublicationList(list)[0].capability.id).toBe("find_relevant_contacts");
  });
});

describe("Binding resolution on the taught site", () => {
  it("binds a taught capability that carries no binding, by its id", () => {
    expect(findRelevantContactsProposal.binding).toBeUndefined();
    expect(bindingActionFor(findRelevantContactsProposal)).toBe("find_relevant_contacts");
  });

  it("refuses a capability taught on some other application", () => {
    const elsewhere: SemanticCapability = {
      ...findRelevantContactsProposal,
      binding: { application: "salesforce-lightning", action: "find_relevant_contacts" }
    };
    expect(bindingActionFor(elsewhere)).toBeUndefined();
    expect(() => invokeProspectBinding(elsewhere, { company: "Acme" })).toThrow(/No execution binding/);
  });

  it("refuses a capability this site has no implementation for", () => {
    const unknown: SemanticCapability = { ...findRelevantContactsProposal, id: "create_opportunity" };
    expect(bindingActionFor(unknown)).toBeUndefined();
  });

  it("never exposes a binding that has not been published", () => {
    // The registry exists so a published capability has something to run.
    // Membership in it is not exposure.
    expect(Object.keys(prospectBindings)).toContain("get_company");
    expect(referenceCapabilities.every((capability) => capability.provenance.source === "configured")).toBe(true);
  });
});

describe("Published capability execution", () => {
  const published = confirmCandidate(findRelevantContactsProposal);

  it("compiles to a tool named for the confirmed capability", () => {
    const tool = compileCapability(published, invokeProspectBinding);
    expect(tool.name).toBe("find_relevant_contacts");
    expect(tool.inputSchema.required).toEqual(["company"]);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["company", "function", "seniority"]);
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it("runs the whole research workflow through the site's own service", async () => {
    const tool = compileCapability(published, invokeProspectBinding);
    const result = await tool.execute({ company: "Acme", function: "Procurement", seniority: "VP" });
    const payload = JSON.parse(result.content[0].text) as {
      company: { id: string } | null;
      contacts: Array<{ name: string; title: string; email: string }>;
    };

    expect(payload.company?.id).toBe("acme");
    expect(payload.contacts).toHaveLength(1);
    expect(payload.contacts[0].name).toBe("Maya Chen");
    expect(payload.contacts[0].title).toBe("VP Procurement");
    expect(payload.contacts[0].email).toBe("maya.chen@acmeindustrial.example");
  });

  it("resolves the company the way the human typed it, not by internal id", async () => {
    const tool = compileCapability(published, invokeProspectBinding);
    for (const company of ["Acme", "acme industrial", "ACME"]) {
      const result = await tool.execute({ company });
      expect(JSON.parse(result.content[0].text).company.id).toBe("acme");
    }
  });

  it("tolerates an input a human renamed during confirmation", async () => {
    const renamed: SemanticCapability = {
      ...published,
      inputs: published.inputs.map((input) => (input.name === "company" ? { ...input, name: "company_name" } : input))
    };
    const result = await compileCapability(renamed, invokeProspectBinding).execute({
      company_name: "Acme",
      function: "Procurement"
    });
    expect(JSON.parse(result.content[0].text).contacts).toHaveLength(3);
  });

  it("returns an empty result rather than guessing at an unknown company", async () => {
    const result = await compileCapability(published, invokeProspectBinding).execute({ company: "Nonexistent Inc" });
    expect(JSON.parse(result.content[0].text)).toEqual({ company: null, contacts: [] });
  });
});

describe("Registration into WebMCP", () => {
  function withModelContext(run: (tools: WebMcpTool[]) => void): void {
    const tools: WebMcpTool[] = [];
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { modelContext: { registerTool: (tool: WebMcpTool) => tools.push(tool) } };
    try {
      run(tools);
    } finally {
      (globalThis as { document?: unknown }).document = previous;
    }
  }

  it("registers a published capability and nothing else", async () => {
    await new Promise<void>((resolve) => {
      withModelContext((tools) => {
        const result = registerCapability(confirmCandidate(findRelevantContactsProposal), invokeProspectBinding);
        expect(result).toBe("registered");
        expect(tools.map((tool) => tool.name)).toEqual(["find_relevant_contacts"]);
        resolve();
      });
    });
  });

  it("reports unavailable rather than throwing when the browser has no WebMCP", () => {
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {};
    try {
      expect(registerCapability(confirmCandidate(findRelevantContactsProposal), invokeProspectBinding)).toBe(
        "unavailable"
      );
    } finally {
      (globalThis as { document?: unknown }).document = previous;
    }
  });
});

describe("Agent readiness states", () => {
  it("separates an unsupported browser from an unpublished site", () => {
    expect(describeReadiness({ webmcpAvailable: false, publishedNames: [] })).toEqual({
      state: "unsupported",
      label: "WebMCP unavailable in this browser"
    });
    expect(describeReadiness({ webmcpAvailable: true, publishedNames: [] })).toEqual({
      state: "unpublished",
      label: "Agent capabilities: Not published"
    });
  });

  it("reports an unsupported browser even once something is published", () => {
    expect(describeReadiness({ webmcpAvailable: false, publishedNames: ["Find Relevant Contacts"] }).state).toBe(
      "unsupported"
    );
  });

  it("names what is published", () => {
    expect(describeReadiness({ webmcpAvailable: true, publishedNames: ["Find Relevant Contacts"] })).toEqual({
      state: "published",
      label: "Agent capabilities: 1 published",
      detail: "Find Relevant Contacts"
    });
  });
});
