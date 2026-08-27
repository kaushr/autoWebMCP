import type { SourceApplication } from "../semantic/model";
import type { CapturePlatform } from "../capture/types";

/**
 * Presentation names for the platforms Teach Mode recognizes. The id is the
 * platform the extension detected, so it is the same value an execution
 * binding carries as its `application`.
 */
const LABELS: Record<CapturePlatform, string> = {
  "salesforce-lightning": "Salesforce",
  "prospect-intelligence": "SignalBase",
  generic: "Unrecognized application"
};

export function sourceApplicationFor(platform: CapturePlatform, host: string): SourceApplication {
  return { id: platform, label: platform === "generic" ? host : LABELS[platform] };
}
