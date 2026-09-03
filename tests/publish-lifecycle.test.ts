import { describe, expect, it } from "vitest";
import { withResolvedValueDomains } from "../src/webmcp/publication";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import { findRelevantContactsProposal, referenceCapabilities } from "../src/prospect/capabilities";
import { bindingActionFor, invokeProspectBinding, prospectBindings } from "../src/prospect/bindings";
import { confirmCandidate } from "../src/training/semanticizer";
import { assertPublishable, parsePublicationList } from "../src/webmcp/publication";
import { compileCapability, registerCapability } from "../src/webmcp/compiler";
import type { WebMcpTool } from "../src/webmcp/types";
import { describeReadiness } from "../src/prospect/app/agentReadiness";
import type { SemanticCapability } from "../src/semantic/model";

const SIGNALBASE = sourceApplicationFor("prospect-intelligence", "127.0.0.1:5173");

/** What the Studio hands over: taught on SignalBase and bound by a human. */
function taughtAndBound(overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  return {
    ...findRelevantContactsProposal,
    binding: { application: "prospect-intelligence", action: "find_relevant_contacts" },
    ...overrides,
    provenance: {
      ...findRelevantContactsProposal.provenance,
      sourceApplication: SIGNALBASE,
      ...(overrides.provenance ?? {})
    }
  };
}

describe("Publication gate", () => {
  it("refuses to publish a capability the model merely proposed", () => {
    expect(() => assertPublishable(taughtAndBound())).toThrow(/human-confirmed/);
  });

  it("refuses to publish a confirmed capability that has no execution binding", () => {
    const understood = confirmCandidate(taughtAndBound({ binding: undefined }));
    expect(understood.provenance.confirmedByHuman).toBe(true);
    expect(() => assertPublishable(understood)).toThrow(/no execution binding/);
  });

  it("refuses a binding borrowed from another application", () => {
    const borrowed = confirmCandidate({
      ...taughtAndBound(),
      provenance: {
        ...findRelevantContactsProposal.provenance,
        sourceApplication: sourceApplicationFor("salesforce-lightning", "tesla.lightning.force.com")
      }
    });
    expect(() => assertPublishable(borrowed)).toThrow(/must belong to the application/);
  });

  it("refuses a capability whose provenance claims confirmation without a human", () => {
    const forged = taughtAndBound({
      provenance: { source: "confirmed", observationIds: [], confirmedByHuman: false }
    });
    expect(() => assertPublishable(forged)).toThrow(/human-confirmed/);
  });

  it("accepts a capability that is both confirmed and bound", () => {
    expect(() => assertPublishable(confirmCandidate(taughtAndBound()))).not.toThrow();
  });

  it("rejects an unconfirmed capability arriving from the control plane", () => {
    const list = { publications: [{ capability: taughtAndBound(), publishedAt: "2026-08-26T18:00:00Z" }] };
    expect(() => parsePublicationList(list)).toThrow(/human-confirmed/);
  });

  it("reads back a confirmed publication", () => {
    const list = {
      publications: [{ capability: confirmCandidate(taughtAndBound()), publishedAt: "2026-08-26T18:00:00Z" }]
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
    expect(() => invokeProspectBinding(elsewhere, { company: "Tesla" })).toThrow(/No execution binding/);
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
  const published = confirmCandidate(taughtAndBound());

  it("compiles to a tool named for the confirmed capability", () => {
    const tool = compileCapability(published, invokeProspectBinding);
    expect(tool.name).toBe("find_relevant_contacts");
    expect(tool.inputSchema.required).toEqual(["company"]);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["company", "function", "seniority"]);
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it("runs the whole research workflow through the site's own service", async () => {
    const tool = compileCapability(published, invokeProspectBinding);
    const result = await tool.execute({ company: "Tesla", function: "Procurement", seniority: "VP" });
    const payload = JSON.parse(result.content[0].text) as {
      company: { id: string } | null;
      contacts: Array<{ name: string; title: string; email: string }>;
    };

    expect(payload.company?.id).toBe("tesla");
    expect(payload.contacts).toHaveLength(1);
    expect(payload.contacts[0].name).toBe("Maya Chen");
    expect(payload.contacts[0].title).toBe("VP Procurement");
    expect(payload.contacts[0].email).toBe("maya.chen@teslamotors.example");
  });

  it("resolves the company the way the human typed it, not by internal id", async () => {
    const tool = compileCapability(published, invokeProspectBinding);
    for (const company of ["Tesla", "tesla motors", "TESLA"]) {
      const result = await tool.execute({ company });
      expect(JSON.parse(result.content[0].text).company.id).toBe("tesla");
    }
  });

  it("tolerates an input a human renamed during confirmation", async () => {
    const renamed: SemanticCapability = {
      ...published,
      inputs: published.inputs.map((input) => (input.name === "company" ? { ...input, name: "company_name" } : input))
    };
    const result = await compileCapability(renamed, invokeProspectBinding).execute({
      company_name: "Tesla",
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
        const result = registerCapability(confirmCandidate(taughtAndBound()), invokeProspectBinding);
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
      expect(registerCapability(confirmCandidate(taughtAndBound()), invokeProspectBinding)).toBe(
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

describe("a published contract carries the value domain that was resolved", () => {
  const base: SemanticCapability = {
    id: "update_opportunity",
    name: "Update opportunity",
    description: "Change an opportunity.",
    inputs: [
      { name: "stage", description: "The stage to set.", type: "string", required: true },
      { name: "close_date", description: "The close date to set.", type: "date", required: false },
      { name: "note", description: "Free text.", type: "string", required: false }
    ],
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true },
    safety: { readOnly: false, requiresConfirmation: true }
  };

  it("fills a constrained input's legal values, so an agent does not have to guess", () => {
    const enriched = withResolvedValueDomains(base, { stage: ["Engage", "Confirm", "Closed Won"] });
    expect(enriched.inputs.find((i) => i.name === "stage")?.enum).toEqual(["Engage", "Confirm", "Closed Won"]);
    // An unconstrained input is left exactly as it was.
    expect(enriched.inputs.find((i) => i.name === "note")?.enum).toBeUndefined();
    expect(enriched.inputs.find((i) => i.name === "close_date")?.enum).toBeUndefined();
  });

  it("never invents a domain, and never overrides one the contract already declares", () => {
    expect(withResolvedValueDomains(base, {}).inputs).toEqual(base.inputs);
    expect(withResolvedValueDomains(base, { stage: [] }).inputs).toEqual(base.inputs);

    const declared: SemanticCapability = {
      ...base,
      inputs: base.inputs.map((i) => (i.name === "stage" ? { ...i, enum: ["Only This"] } : i))
    };
    expect(withResolvedValueDomains(declared, { stage: ["Something", "Else"] }).inputs.find((i) => i.name === "stage")?.enum)
      .toEqual(["Only This"]);
  });

  it("reaches the compiled tool schema, which is the only thing an agent reads", () => {
    const enriched = withResolvedValueDomains(base, { stage: ["Engage", "Confirm"] });
    const tool = compileCapability({ ...enriched, binding: { application: "salesforce-lightning", action: "x" } }, () => ({}));
    expect(tool.inputSchema.properties.stage.enum).toEqual(["Engage", "Confirm"]);
  });
});
