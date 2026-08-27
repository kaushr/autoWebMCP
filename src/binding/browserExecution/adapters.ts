import { createSalesforceResolverAdapter } from "./salesforceAdapter";
import type { PlatformResolverAdapter } from "./engine";

/**
 * Platform id → resolver adapter, the one place that knows which adapter a
 * binding's `platform` field selects. Shared by whatever actually runs
 * `executeConfirmed` against a live DOM — today, the extension's content
 * script — so a new platform adapter is wired in one place, not
 * re-discovered at each call site.
 */
const ADAPTERS: Record<string, () => PlatformResolverAdapter> = {
  "salesforce-lightning": createSalesforceResolverAdapter
};

/** `undefined` means "run with the generic engine alone" — a legitimate choice, not a missing one. */
export function resolverAdapterForPlatform(platform: string): PlatformResolverAdapter | undefined {
  return ADAPTERS[platform]?.();
}
