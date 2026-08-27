import type { SemanticCapability } from "../semantic/model";
import { PROSPECT_APPLICATION, bindingParameters } from "../prospect/bindings";

/** One execution path a taught application says it already has. */
export interface AdvertisedBinding {
  application: string;
  action: string;
  parameters: readonly string[];
}

export interface BindingProvider {
  list(): AdvertisedBinding[];
  find(application: string, action: string): AdvertisedBinding | undefined;
}

/**
 * ============================ HACKATHON ADAPTER ============================
 *
 * Automatic execution-binding discovery is NOT implemented. A trace shows what
 * a human did; it does not reveal an application's internal action names, so
 * the semanticizer correctly returns `binding: null` and a person chooses the
 * binding during confirmation.
 *
 * This adapter is the fastest stand-in for that missing step: the Studio reads
 * the one cooperative application's registry out of the same source tree. That
 * is a build-time coupling, and it is the whole reason this file exists as a
 * seam rather than an import in the editor.
 *
 * The intended replacement is a site that advertises its own bindings to the
 * control plane, or discovery from evidence. Either one swaps this constant for
 * another `BindingProvider`. Nothing in the semantic model, the compiler, or
 * the publication contract knows which provider is in use, so replacing it
 * changes no capability that has already been taught.
 * ==========================================================================
 */
export const localRegistryBindingProvider: BindingProvider = {
  list(): AdvertisedBinding[] {
    return Object.entries(bindingParameters).map(([action, parameters]) => ({
      application: PROSPECT_APPLICATION,
      action,
      parameters
    }));
  },
  find(application: string, action: string): AdvertisedBinding | undefined {
    return this.list().find(
      (binding) => binding.application === application && binding.action === action
    );
  }
};

/**
 * Whether a capability names an execution path the provider actually advertises.
 * Exact match only: no fuzzy matching, no guessing from input names. An
 * unrecognized binding is unbound, and an unbound capability is not publishable.
 */
export function resolveAdvertisedBinding(
  capability: SemanticCapability,
  provider: BindingProvider = localRegistryBindingProvider
): AdvertisedBinding | undefined {
  if (!capability.binding) return undefined;
  return provider.find(capability.binding.application, capability.binding.action);
}
