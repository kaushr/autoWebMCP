import "./styles.css";
import { invokeProspectCapability, prospectCapabilities } from "../capabilities";
import { getCompany, getContact } from "../service";
import { registerCapability } from "../../webmcp/compiler";
import { companyHref, parseRoute, searchHref, type ContactFilters, type Route } from "./router";
import { APP_NAME, renderRoute, renderShell } from "./views";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("SignalBase root element not found.");
const appRoot: HTMLDivElement = root;

/**
 * The same deterministic compiler the Training Studio uses. These capabilities
 * are configured rather than taught; a capability learned from a Teach Mode
 * session is published through the identical path.
 */
const webmcpStatus = prospectCapabilities
  .map((capability) => registerCapability(capability, invokeProspectCapability))
  .every((result) => result === "registered")
  ? "registered"
  : "unavailable";

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
  appRoot.innerHTML = renderShell(renderRoute(route), webmcpStatus);
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

render();
