import type { ToolListingSource } from "../../webmcp/harness";
import type { JsonObjectSchema } from "../../webmcp/types";

/**
 * What the site can honestly say about itself.
 *
 * "The browser has no WebMCP" and "nothing has been published to this site yet"
 * are different facts, and conflating them hides the whole point of the demo:
 * before training there is nothing to expose, and that is not a failure.
 */
export interface AgentReadiness {
  webmcpAvailable: boolean;
  publishedNames: string[];
  /**
   * The tools as an agent would actually receive them.
   *
   * Optional because a browser may let a page register without letting it
   * enumerate, and because the header is meaningful before anything is
   * published. Absent means "not read", never "none".
   */
  tools?: AgentFacingTool[];
  /**
   * Where `tools` came from, and therefore what may be claimed about them.
   *
   * `discovered` is the browser's own answer about what an agent can see.
   * `registered` is this document reporting what it itself passed to
   * `registerTool` — evidence of registration, and NOT evidence that an
   * agent can discover it. The distinction is the same one the Studio's
   * harness makes, and for the same reason: a panel headed "what an agent
   * sees" that is really an internal registry is a claim nobody checked.
   */
  toolSource?: ToolListingSource;
  /**
   * Capabilities this document registered that the control plane no longer
   * publishes.
   *
   * WebMCP has no unregister. Once `registerTool` has been called, the tool
   * stays on this document's surface until the document is replaced — so
   * unpublishing in the Studio does NOT make it uncallable here, and a
   * header that quietly stopped counting it would be describing a tool
   * surface that does not exist.
   *
   * Named rather than counted, because a demo that starts from "SignalBase
   * exposes nothing" needs to know which tool is still hanging around and
   * that a reload is what clears it.
   */
  staleNames?: string[];
  /**
   * The capability whose removal has been pressed once and awaits a second
   * press.
   *
   * Removal unpublishes from the control plane and reloads this document,
   * which is irreversible without teaching the capability again — so it
   * asks twice, in the button itself, the same way every destructive
   * action in the Studio does.
   */
  removalArmed?: string;
  /**
   * A capability already taught to this site that nothing has registered yet.
   *
   * Only ever set where there is no control plane to publish from, which
   * is what a static deployment of this site is. It does not change what
   * the site currently exposes — an offer is not a registration, and the
   * header still reports nothing published until someone accepts it.
   */
  offer?: OfferedCapability;
}

/** A taught capability this document could register, named for a person to decide about. */
export interface OfferedCapability {
  id: string;
  name: string;
}

/** One tool, in the shape a caller reads it: a name, a contract, and prose. */
export interface AgentFacingTool {
  name: string;
  description: string;
  /** The published input schema, normalized from whichever shape the browser returns. */
  inputSchema?: JsonObjectSchema;
}

export type ReadinessState = "unsupported" | "unpublished" | "published";

export interface ReadinessDescription {
  state: ReadinessState;
  label: string;
  detail?: string;
  /** The tools to show when the header is expanded. Omitted when there are none to show. */
  tools?: AgentFacingTool[];
  /** One sentence saying what the expanded list is evidence of. */
  sourceNote?: string;
  /** Present when something here is registered but no longer published. */
  staleNote?: string;
  /** The capability awaiting a confirming second press, when one is. */
  removalArmed?: string;
  /**
   * A taught capability a person may register here, when one is on offer.
   *
   * Carried only on the `unpublished` state, because that is the only one
   * where accepting it changes anything: once something is registered the
   * page is telling a different story, and a second offer beside it would
   * read as though the site publishes itself.
   */
  offer?: OfferedCapability;
  /** Why the offer exists, in a sentence, so accepting it is an informed act. */
  offerNote?: string;
}

const SOURCE_NOTES: Record<ToolListingSource, string> = {
  discovered:
    "Read back from document.modelContext.getTools() — the browser's own answer about what an agent can see.",
  registered:
    "What this document passed to registerTool(). This browser does not let a page enumerate WebMCP tools, so " +
    "this is evidence of registration, not of agent-side discovery."
};

export function describeReadiness(readiness: AgentReadiness): ReadinessDescription {
  // Only ever attached to a state that has something to expand. A browser
  // with no WebMCP has nothing an agent could receive, whatever this
  // document may have tried to register.
  const stale = readiness.staleNames ?? [];
  const expansion =
    readiness.webmcpAvailable && readiness.tools?.length
      ? {
          tools: readiness.tools,
          sourceNote: SOURCE_NOTES[readiness.toolSource ?? "registered"],
          ...(readiness.removalArmed ? { removalArmed: readiness.removalArmed } : {}),
          ...(stale.length
            ? {
                staleNote:
                  `${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} no longer published. WebMCP has no ` +
                  "unregister, so it stays callable on this document until the page is reloaded."
              }
            : {})
        }
      : {};

  if (!readiness.webmcpAvailable) {
    return { state: "unsupported", label: "WebMCP unavailable in this browser" };
  }
  if (readiness.publishedNames.length === 0) {
    return {
      state: "unpublished",
      label: "Agent capabilities: Not published",
      ...(readiness.offer
        ? {
            offer: readiness.offer,
            offerNote:
              "This copy has no control plane behind it, so nothing can be taught here. " +
              `${readiness.offer.name} was taught and confirmed in a real session; registering it is what ` +
              "pressing Publish in the Studio does."
          }
        : {})
    };
  }
  return {
    state: "published",
    label: `Agent capabilities: ${readiness.publishedNames.length} published`,
    detail: readiness.publishedNames.join(", "),
    ...expansion
  };
}
