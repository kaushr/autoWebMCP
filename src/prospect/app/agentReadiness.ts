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
}

export type ReadinessState = "unsupported" | "unpublished" | "published";

export interface ReadinessDescription {
  state: ReadinessState;
  label: string;
  detail?: string;
}

export function describeReadiness(readiness: AgentReadiness): ReadinessDescription {
  if (!readiness.webmcpAvailable) {
    return { state: "unsupported", label: "WebMCP unavailable in this browser" };
  }
  if (readiness.publishedNames.length === 0) {
    return { state: "unpublished", label: "Agent capabilities: Not published" };
  }
  return {
    state: "published",
    label: `Agent capabilities: ${readiness.publishedNames.length} published`,
    detail: readiness.publishedNames.join(", ")
  };
}
