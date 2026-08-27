import { describe, expect, it } from "vitest";
import { proposeBrowserBinding } from "../src/binding/browserExecution/propose";
import { CaptureSession } from "../src/capture/session";
import { sourceApplicationFor } from "../src/training/sourceApplication";
import type { SemanticCapability } from "../src/semantic/model";
import type { CaptureEvent } from "../src/capture/types";
import type { ObservationTrace } from "../src/capture/normalize";

const SALESFORCE = sourceApplicationFor("salesforce-lightning", "nvent-dev-ed.lightning.force.com");
const page = { host: "nvent-dev-ed.lightning.force.com", path: "/lightning/r/Opportunity/006/view" };

function traceFrom(events: CaptureEvent[]): ObservationTrace {
  const session = new CaptureSession("sess-propose", 0, {
    host: page.host,
    platform: "salesforce-lightning",
    title: "PS Project Test | Opportunity"
  });
  session.addMany(events);
  session.stop(3_000);
  return session.toTrace();
}

const REAL_WORKFLOW: CaptureEvent[] = [
  { id: "nav", kind: "navigate", t: 100, page },
  {
    id: "edit",
    kind: "field_change",
    t: 1_000,
    page,
    element: { tag: "input", name: "CloseDate", label: "*Close Date" },
    field: { label: "*Close Date", section: "Opportunity Details", control: "date" },
    value: { masked: false, from: "2026-08-31", to: "2026-09-30" }
  },
  { id: "save", kind: "click", t: 2_000, page, actionLabel: "Save" }
];

function capability(overrides: Partial<SemanticCapability> = {}): SemanticCapability {
  return {
    id: "update_opportunity_close_date",
    name: "Update opportunity close date",
    description: "Change an opportunity's close date and save the record.",
    inputs: [{ name: "close_date", description: "close_date", type: "string", required: true }],
    outputs: [],
    provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true, sourceApplication: SALESFORCE },
    safety: { readOnly: false, requiresConfirmation: true },
    ...overrides
  };
}

describe("proposeBrowserBinding — deterministic, evidence-only", () => {
  it("proposes a complete binding from a real captured workflow", () => {
    const proposal = proposeBrowserBinding(capability(), traceFrom(REAL_WORKFLOW));
    expect(proposal.binding).not.toBeNull();
    const binding = proposal.binding!;
    expect(binding.platform).toBe("salesforce-lightning");
    expect(binding.context.recordType).toBe("Opportunity");
    expect(binding.inputs).toHaveLength(1);
    expect(binding.inputs[0]).toEqual({
      semanticInput: "close_date",
      semanticTarget: { role: "field", label: "*Close Date", applicationIdentifier: "CloseDate", section: "Opportunity Details" },
      valueKind: "date"
    });
    expect(binding.commit).toEqual({ semanticAction: { role: "button", label: "Save" } });
  });

  it("carries no coordinate, selector, XPath, or DOM node id anywhere in the serialized binding", () => {
    const proposal = proposeBrowserBinding(capability(), traceFrom(REAL_WORKFLOW));
    // Everything the `safety` object declares absent is declared by field NAME
    // ("noXPath", "noCoordinates"), which would otherwise self-trigger these
    // very checks — assert on the rest of the binding instead.
    const { safety: _safety, ...rest } = proposal.binding as NonNullable<typeof proposal.binding>;
    const serialized = JSON.stringify(rest);
    expect(serialized).not.toMatch(/xpath/i);
    expect(serialized).not.toMatch(/coordinate|\bx\d+\b|\by\d+\b/i);
    expect(serialized).not.toMatch(/css[_-]?selector|querySelector/i);
    expect(serialized).not.toMatch(/nodeId/i);
    expect(serialized).not.toMatch(/#[\w-]+\s*>/); // a CSS combinator chain
    expect(serialized).not.toMatch(/^\/\/|\/html\/body/); // an XPath expression
  });

  it("carries no credential, session, or private-transport reference", () => {
    const proposal = proposeBrowserBinding(capability(), traceFrom(REAL_WORKFLOW));
    const serialized = JSON.stringify(proposal.binding);
    expect(serialized).not.toMatch(/cookie|token|session[_-]?id|bearer|aura/i);
  });

  it("declares the safety contract literally", () => {
    const proposal = proposeBrowserBinding(capability(), traceFrom(REAL_WORKFLOW));
    expect(proposal.binding?.safety).toEqual({
      noCoordinates: true,
      noXPath: true,
      noPrivateTransportReplay: true,
      noCredentialExtraction: true
    });
  });

  it("proposes nothing when no commit action was observed", () => {
    const proposal = proposeBrowserBinding(capability(), traceFrom([REAL_WORKFLOW[0], REAL_WORKFLOW[1]]));
    expect(proposal.binding).toBeNull();
    expect(proposal.warnings[0]).toMatch(/no commit action/i);
  });

  it("proposes nothing when the capability input has no observed field identifier at all", () => {
    const noFieldTrace = traceFrom([REAL_WORKFLOW[0], REAL_WORKFLOW[2]]);
    const proposal = proposeBrowserBinding(capability(), noFieldTrace);
    expect(proposal.binding).toBeNull();
  });

  it("proposes nothing when the field identifier is ambiguous across multiple observed fields", () => {
    const ambiguous: CaptureEvent[] = [
      ...REAL_WORKFLOW,
      {
        id: "edit2",
        kind: "field_change",
        t: 1_500,
        page,
        element: { tag: "input", name: "AltCloseDate", label: "*Close Date" },
        field: { label: "*Close Date", section: "Opportunity Details", control: "date" },
        value: { masked: false, from: "2026-08-31", to: "2026-09-30" }
      }
    ];
    const proposal = proposeBrowserBinding(capability(), traceFrom(ambiguous));
    expect(proposal.binding).toBeNull();
    expect(proposal.warnings.some((warning) => /matches several/i.test(warning))).toBe(true);
  });

  it("prefers the capability's canonical type over the capture's control classification", () => {
    // The live gap: a Lightning datepicker reports control "other", which
    // proposed valueKind "text" and sent raw canonical dates into a control
    // expecting its display format. The confirmed contract wins.
    const dateCapability = capability({
      inputs: [{ name: "close_date", description: "close_date", type: "date", required: true }]
    });
    const otherControl: CaptureEvent[] = [
      REAL_WORKFLOW[0],
      {
        ...REAL_WORKFLOW[1],
        field: { label: "*Close Date", section: "Opportunity Details", control: "other" }
      },
      REAL_WORKFLOW[2]
    ];
    const proposal = proposeBrowserBinding(dateCapability, traceFrom(otherControl));
    expect(proposal.binding?.inputs[0].valueKind).toBe("date");
  });

  it("proposes nothing when the capability has no recorded source application", () => {
    const noSource = capability({ provenance: { source: "confirmed", observationIds: [], confirmedByHuman: true } });
    const proposal = proposeBrowserBinding(noSource, traceFrom(REAL_WORKFLOW));
    expect(proposal.binding).toBeNull();
  });
});
