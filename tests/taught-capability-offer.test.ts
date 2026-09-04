import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { describeReadiness } from "../src/prospect/app/agentReadiness";
import { loadTaughtCapability } from "../src/prospect/app/taughtCapability";
import { assertPublishable, parsePublicationList } from "../src/webmcp/publication";
import { bindingActionFor } from "../src/prospect/bindings";
import { renderShell } from "../src/prospect/app/views";
import { acceptedCapabilityIds, forgetAcceptance, rememberAcceptance } from "../src/prospect/app/taughtCapability";

/* ------------------------------------------------------------------ *
 * The offer a hosted copy makes, and what it must not claim.
 *
 * A site with no control plane behind it can still show what a published
 * capability looks like, but only by offering one a human already taught.
 * Registering it has to stay a person's act: "SignalBase starts with no
 * agent capability" is the demonstration, and a page that quietly
 * registered on load would be contradicting the thing it exists to show.
 * ------------------------------------------------------------------ */

function shippedRecord() {
  const raw = JSON.parse(readFileSync("public/taught-capability.json", "utf8"));
  return parsePublicationList(raw)[0];
}

describe("the shipped taught capability", () => {
  it("is a real publication, not a hand-written fixture", () => {
    const record = shippedRecord();

    expect(record.capability.provenance.source).toBe("confirmed");
    expect(record.capability.provenance.confirmedByHuman).toBe(true);
    // Evidence from an actual session, which is what makes it an export.
    expect(record.capability.provenance.observationIds.length).toBeGreaterThan(0);
  });

  it("passes the same publication gate the control plane enforces", () => {
    expect(() => assertPublishable(shippedRecord().capability)).not.toThrow();
  });

  it("binds to something SignalBase can actually run", () => {
    expect(bindingActionFor(shippedRecord().capability)).toBeTruthy();
  });

  it("is read-only, so accepting it can never write anything", () => {
    expect(shippedRecord().capability.safety.readOnly).toBe(true);
  });

  it("carries no second application's data", () => {
    expect(shippedRecord().capability.binding?.application).toBe("prospect-intelligence");
  });
});

describe("loadTaughtCapability", () => {
  it("returns the record when the file is served", async () => {
    const raw = JSON.parse(readFileSync("public/taught-capability.json", "utf8"));
    const record = await loadTaughtCapability(
      (async () => ({ ok: true, json: async () => raw })) as unknown as typeof fetch
    );
    expect(record?.capability.id).toBe("find_decision_maker_contact");
  });

  it("offers nothing when no file is served, which is the local case", async () => {
    const missing = await loadTaughtCapability(
      (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch
    );
    expect(missing).toBeUndefined();
  });

  it("offers nothing rather than throwing when the fetch itself fails", async () => {
    const failed = await loadTaughtCapability((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    expect(failed).toBeUndefined();
  });
});

describe("describeReadiness with an offer", () => {
  const offer = { id: "find_decision_maker_contact", name: "Find decision maker contact" };

  it("still reports nothing published, because an offer is not a registration", () => {
    const described = describeReadiness({ webmcpAvailable: true, publishedNames: [], offer });

    expect(described.state).toBe("unpublished");
    expect(described.label).toBe("Agent capabilities: Not published");
    expect(described.offer).toEqual(offer);
    expect(described.offerNote).toMatch(/taught and confirmed in a real session/);
  });

  it("drops the offer once something is registered", () => {
    const described = describeReadiness({
      webmcpAvailable: true,
      publishedNames: ["Find decision maker contact"],
      offer
    });

    expect(described.state).toBe("published");
    expect(described.offer).toBeUndefined();
  });

  it("makes no offer where the browser has no WebMCP to register into", () => {
    const described = describeReadiness({ webmcpAvailable: false, publishedNames: [], offer });

    expect(described.state).toBe("unsupported");
    expect(described.offer).toBeUndefined();
  });
});

describe("the offer as rendered", () => {
  const offer = { id: "find_decision_maker_contact", name: "Find decision maker contact" };

  it("renders an accept control carrying the capability's id", () => {
    const html = renderShell("", describeReadiness({ webmcpAvailable: true, publishedNames: [], offer }));

    expect(html).toContain('data-register-capability="find_decision_maker_contact"');
    expect(html).toContain("Publish Find decision maker contact");
    // The badge must keep telling the truth beside the button.
    expect(html).toContain("Agent capabilities: Not published");
  });

  it("renders no accept control when nothing is on offer", () => {
    const html = renderShell("", describeReadiness({ webmcpAvailable: true, publishedNames: [] }));

    expect(html).not.toContain("data-register-capability");
    expect(html).toContain("Agent capabilities: Not published");
  });
});

/* ------------------------------------------------------------------ *
 * Surviving a refresh.
 *
 * The control plane persists a publication and re-registers it on load.
 * A hosted copy has only this browser, and without the equivalent the
 * demonstration lasted one page view: register, reload, and the badge
 * claimed nothing had ever been published.
 * ------------------------------------------------------------------ */

function withStorage(run: () => void): void {
  const store = new Map<string, string>();
  const original = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v)
      }
    }
  });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", { configurable: true, value: original });
    else delete (globalThis as { window?: unknown }).window;
  }
}

describe("remembering an acceptance", () => {
  it("remembers nothing before anyone accepts", () => {
    withStorage(() => expect(acceptedCapabilityIds().size).toBe(0));
  });

  it("survives so a reload can restore rather than re-ask", () => {
    withStorage(() => {
      rememberAcceptance("find_decision_maker_contact");
      expect(acceptedCapabilityIds().has("find_decision_maker_contact")).toBe(true);
    });
  });

  it("forgets on unpublish, returning the site to offering it", () => {
    withStorage(() => {
      rememberAcceptance("find_decision_maker_contact");
      forgetAcceptance("find_decision_maker_contact");
      expect(acceptedCapabilityIds().has("find_decision_maker_contact")).toBe(false);
    });
  });

  it("remembers nothing rather than throwing where storage is unavailable", () => {
    const original = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => {
            throw new Error("storage disabled");
          },
          setItem: () => {
            throw new Error("storage disabled");
          }
        }
      }
    });
    try {
      expect(acceptedCapabilityIds().size).toBe(0);
      expect(() => rememberAcceptance("x")).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, "window", { configurable: true, value: original });
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});
