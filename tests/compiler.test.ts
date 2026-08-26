import { describe, expect, it } from "vitest";
import type { SemanticCapability } from "../src/semantic/model";
import { compileCapability } from "../src/webmcp/compiler";

const capability: SemanticCapability = {
  id: "find_relevant_contacts",
  name: "Find relevant contacts",
  description: "Find contacts by company and function.",
  inputs: [
    { name: "company", description: "Company name.", type: "string", required: true },
    { name: "function", description: "Business function.", type: "string", required: false }
  ],
  outputs: [{ name: "contacts", description: "Matched contacts.", type: "array" }],
  binding: { application: "prospect-intelligence", action: "find_contacts" },
  provenance: { source: "confirmed", observationIds: ["event-1"], confirmedByHuman: true },
  safety: { readOnly: true, requiresConfirmation: false }
};

describe("semantic capability compiler", () => {
  it("deterministically produces the expected WebMCP contract", async () => {
    const tool = compileCapability(capability, (_capability, inputs) => ({ contacts: [inputs.company] }));

    expect(tool.name).toBe("find_relevant_contacts");
    expect(tool.description).toBe("Find contacts by company and function.");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        company: { type: "string", description: "Company name." },
        function: { type: "string", description: "Business function." }
      },
      required: ["company"],
      additionalProperties: false
    });
    expect(tool.annotations).toEqual({ readOnlyHint: true });

    const result = await tool.execute({ company: "Acme" });
    expect(JSON.parse(result.content[0].text)).toEqual({ contacts: ["Acme"] });
  });
});
