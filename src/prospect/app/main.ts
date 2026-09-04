import "./styles.css";
import { bindingActionFor, invokeProspectBinding } from "../bindings";
import { getCompany, getContact } from "../service";
import { registerCapability } from "../../webmcp/compiler";
import { describeWebMcpSurface, normalizeInputSchema, settledToolListing } from "../../webmcp/harness";
import { listPublishedCapabilities, publishedCapabilityContract, unpublishCapability } from "../../webmcp/publication";
import { describeReadiness, type AgentFacingTool, type AgentReadiness } from "./agentReadiness";
import { loadTaughtCapability } from "./taughtCapability";
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
/** What this browser actually permits a page to do — asked, not assumed. */
const webMcpSurface = describeWebMcpSurface(document.modelContext);
let readiness: AgentReadiness = { webmcpAvailable: Boolean(document.modelContext), publishedNames: [] };
/** The capability whose removal has been pressed once and awaits confirmation. */
let removalArmed: string | undefined;

/**
 * A taught capability this document could register, where no control plane
 * exists to publish one.
 *
 * Held rather than registered. Accepting it is a person's act, because the
 * site starting with nothing is what the demonstration is about.
 */
let offered: Awaited<ReturnType<typeof loadTaughtCapability>>;
/**
 * Whether the badge's panel is open, remembered across renders.
 *
 * `render()` rebuilds the whole document body, which closes a `<details>`
 * — so without this, arming a removal collapsed the panel holding the
 * button that had to be pressed again, and returning to this tab shut a
 * panel someone had deliberately opened.
 */
let panelOpen = false;

/**
 * The tools behind the badge, as an agent would receive them.
 *
 * Read from `getTools()` where the browser allows it, because that is the
 * only source that supports the heading "what an agent sees". Where it does
 * not, this document reports what it passed to `registerTool` and the panel
 * says which of the two it is — an internal registry shown under an
 * agent-facing heading would be a claim nobody checked.
 */
async function agentFacingTools(): Promise<{ tools: AgentFacingTool[]; source: "discovered" | "registered" }> {
  const expected = [...registeredCapabilities.keys()];
  if (webMcpSurface.canDiscover && document.modelContext) {
    try {
      const listed = await settledToolListing(document.modelContext, expected);
      return {
        source: "discovered",
        tools: listed.map((tool) => {
          const schema = normalizeInputSchema(tool.inputSchema);
          return {
            name: tool.name,
            description: tool.description ?? "",
            ...(schema ? { inputSchema: schema } : {})
          };
        })
      };
    } catch {
      // A discovery that failed is not a registration that failed. Fall
      // back to what this document knows and label it as exactly that.
    }
  }
  return {
    source: "registered",
    tools: expected.map((name) => ({ name, description: "" }))
  };
}

async function syncPublishedCapabilities(): Promise<void> {
  let published: Awaited<ReturnType<typeof listPublishedCapabilities>> = [];
  try {
    published = await listPublishedCapabilities();
  } catch {
    // No control plane reachable: the site is simply a website. That is a
    // legitimate state, not an error worth showing a visitor.
    published = [];
    // Nothing can be taught against a site with no control plane behind it,
    // so a copy served that way offers the result of a session that already
    // happened. Only while nothing is registered: once something is, the
    // page has a tool surface and an offer beside it would misdescribe how
    // it got there.
    if (!registeredCapabilities.size) offered = await loadTaughtCapability();
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
  // Registered here, no longer published there. The two can diverge in one
  // direction only — WebMCP has no unregister — so this is reported rather
  // than corrected: the tool really is still callable on this document, and
  // a reload is the only thing that changes that.
  const stillPublished = new Set(published.map((record) => record.capability.id));
  const staleNames = [...registeredCapabilities.keys()].filter((id) => !stillPublished.has(id));

  const surface = registeredCapabilities.size ? await agentFacingTools() : undefined;
  readiness = {
    webmcpAvailable: Boolean(document.modelContext),
    publishedNames: [...registeredCapabilities.values()],
    ...(surface ? { tools: surface.tools, toolSource: surface.source } : {}),
    ...(staleNames.length ? { staleNames } : {}),
    ...(offered && !registeredCapabilities.size
      ? { offer: { id: offered.capability.id, name: offered.capability.name } }
      : {})
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
  appRoot.innerHTML = renderShell(renderRoute(route), describeReadiness({ ...readiness, ...(removalArmed ? { removalArmed } : {}) }));
  document.title = documentTitle(route);

  // Re-applied rather than preserved, because the element is new every time.
  const panel = appRoot.querySelector<HTMLDetailsElement>("details.agent-status");
  if (!panel) return;
  panel.open = panelOpen;
  // `toggle` does not bubble, so this cannot be delegated from the root.
  panel.addEventListener("toggle", () => {
    panelOpen = panel.open;
  });
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

/**
 * Removing a capability this site was taught.
 *
 * Two presses, because it is irreversible without teaching the capability
 * again: it unpublishes from the control plane, which affects every site,
 * and the recording it came from is not kept here.
 *
 * The reload is not tidying up — it is the removal. WebMCP has no
 * unregister, so a tool stays callable on this document until the document
 * is replaced, and a button that unpublished without reloading would report
 * a site that had stopped exposing something it was still exposing.
 */
/**
 * Accepting the offer.
 *
 * The same compile-and-register path a control-plane publication takes,
 * deliberately: an offered capability is not a second kind of tool, and a
 * separate route to registerTool would be somewhere for the two to drift
 * apart. Once accepted it stops being on offer, because the page is now
 * describing a registered tool rather than an available one.
 */
appRoot.addEventListener("click", (event) => {
  const accept = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-register-capability]");
  if (!accept || !offered) return;
  if (accept.dataset.registerCapability !== offered.capability.id) return;

  const contract = publishedCapabilityContract(offered);
  if (!bindingActionFor(offered.capability)) return;
  if (registerCapability(contract, invokeProspectBinding, [contract]) === "registered") {
    registeredCapabilities.set(offered.capability.id, offered.capability.name);
  }
  offered = undefined;
  void syncPublishedCapabilities();
});

appRoot.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-remove-capability]");
  const id = button?.dataset.removeCapability;
  if (!id) return;

  if (removalArmed !== id) {
    removalArmed = id;
    render();
    return;
  }

  removalArmed = undefined;
  void unpublishCapability(id)
    .then(() => window.location.reload())
    .catch(() => {
      // The control plane refused or is unreachable. Nothing was removed
      // and nothing was reloaded, so the site is exactly as it was; the
      // panel re-renders with the button disarmed.
      render();
    });
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
