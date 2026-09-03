import "./styles.css";
import { bindingActionFor, invokeProspectBinding } from "../bindings";
import { getCompany, getContact } from "../service";
import { registerCapability } from "../../webmcp/compiler";
import { listPublishedCapabilities, publishedCapabilityContract } from "../../webmcp/publication";
import { describeReadiness, type AgentReadiness } from "./agentReadiness";
import { companyHref, parseRoute, searchHref, type ContactFilters, type Route } from "./router";
import { APP_NAME, renderRoute, renderShell } from "./views";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("SignalBase root element not found.");
const appRoot: HTMLDivElement = root;

/**
 * This site registers nothing of its own.
 *
 * It is an ordinary human website until someone teaches a capability from it,
 * confirms that capability, and publishes it. Only then does this page compile
 * the published capability against a binding it already has and hand the result
 * to WebMCP.
 */
const registeredCapabilities = new Map<string, string>();
let readiness: AgentReadiness = { webmcpAvailable: Boolean(document.modelContext), publishedNames: [] };

async function syncPublishedCapabilities(): Promise<void> {
  let published: Awaited<ReturnType<typeof listPublishedCapabilities>> = [];
  try {
    published = await listPublishedCapabilities();
  } catch {
    // No control plane reachable: the site is simply a website. That is a
    // legitimate state, not an error worth showing a visitor.
    published = [];
  }

  // Composition hints may only mention tools this document can actually
  // offer, so the peer set is what is registrable here — not everything
  // the control plane lists. A capability taught elsewhere that this site
  // cannot run must not be suggested to an agent as somewhere to go next.
  const peers = published.map(publishedCapabilityContract).filter(bindingActionFor);

  for (const record of published) {
    // A capability taught somewhere else can be published without this site
    // being able to run it. It is registered not at all, and claimed nowhere.
    if (!bindingActionFor(record.capability)) continue;
    if (registeredCapabilities.has(record.capability.id)) continue;

    if (registerCapability(publishedCapabilityContract(record), invokeProspectBinding, peers) === "registered") {
      registeredCapabilities.set(record.capability.id, record.capability.name);
    }
  }

  // The header describes what this document actually exposes, not what the
  // control plane lists. WebMCP has no unregister, so an unpublished capability
  // stays callable here until the page is reloaded, and saying otherwise
  // would misreport the tool surface an agent can still see.
  readiness = {
    webmcpAvailable: Boolean(document.modelContext),
    publishedNames: [...registeredCapabilities.values()]
  };
  render();
}

function documentTitle(route: Route): string {
  switch (route.view) {
    case "company":
      return `${getCompany(route.companyId)?.name ?? "Company"} | ${APP_NAME}`;
    case "contact":
      return `${getContact(route.contactId)?.name ?? "Contact"} | ${APP_NAME}`;
    default:
      return `${APP_NAME} | Prospect intelligence`;
  }
}

function navigate(href: string): void {
  if (location.hash === href) {
    render();
    return;
  }
  location.hash = href;
}

function filtersFromForm(form: HTMLFormElement): ContactFilters {
  const data = new FormData(form);
  const read = (key: string): string | undefined => {
    const value = data.get(key);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return { function: read("function"), seniority: read("seniority"), titleKeywords: read("title") };
}

function render(): void {
  const route = parseRoute(location.hash);
  appRoot.innerHTML = renderShell(renderRoute(route), describeReadiness(readiness));
  document.title = documentTitle(route);
}

/**
 * Delegated listeners bound once. Re-binding on every render would make the
 * DOM churn that Teach Mode observes harder to attribute to a real reaction.
 */
appRoot.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  if (form.id === "company-search") {
    event.preventDefault();
    const query = new FormData(form).get("q");
    navigate(searchHref(typeof query === "string" ? query : ""));
    return;
  }

  if (form.id === "contact-filters") {
    event.preventDefault();
    const route = parseRoute(location.hash);
    if (route.view !== "company") return;
    navigate(companyHref(route.companyId, filtersFromForm(form)));
  }
});

// Facets apply as soon as they change, so each filter produces its own
// observable action → reaction pair rather than one batched submit.
appRoot.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  const form = target.form;
  if (!form || form.id !== "contact-filters") return;

  const route = parseRoute(location.hash);
  if (route.view !== "company") return;
  navigate(companyHref(route.companyId, filtersFromForm(form)));
});

window.addEventListener("hashchange", () => {
  render();
  window.scrollTo({ top: 0 });
});

// Publishing happens in another tab, so re-check on return rather than polling.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void syncPublishedCapabilities();
});

render();
void syncPublishedCapabilities();
