# The page-side agent harness

A small deterministic shell on the WebMCP control page (`/?control=1`) that
takes one natural-language instruction and executes it by composing the
tools `document.modelContext.getTools()` currently reports.

What it is worth looking at for: the model operates over the **real WebMCP
surface**. It sees the same tool names, descriptions, input schemas and
`readOnlyHint` annotations a browser agent would, and every invocation goes
through `document.modelContext.executeTool`. There is no second path to the
execution engine, no capability callback called directly, and no hardcoded
tool order.

It is **not** ChatGPT, not Codex, not an MCP server, and not a workflow
engine. It is a caller, and it gets no privileges a caller does not have.

## The loop

```text
instruction
      ↓
document.modelContext.getTools()        ← asked again on every step
      ↓
model chooses one tool + arguments      ← control plane, structured output
      ↓
validated against that same tool list
      ↓
document.modelContext.executeTool(...)
      ↓
real result, reduced but not flattened
      ↓
next step, or a stop with a reason
```

Hard maximum of five steps. Three is enough for the cross-application task.

## What the model may answer

Exactly two things, under a strict JSON schema:

```json
{ "action": "call_tool", "tool": "…", "arguments_json": "{…}", "summary": "" }
{ "action": "finish",    "tool": "",  "arguments_json": "",    "summary": "…" }
```

`arguments_json` is a string because a strict schema cannot express a
free-form object; it is parsed and checked against the chosen tool's own
published input schema, and never evaluated.

There is deliberately **no field anywhere in an action** through which a
selector, an XPath, a script or a browser command could travel. Argument
validation keeps only keys the schema declares, holding only the primitives
it declares them to hold — so a structure where a primitive was declared is
refused, and an undeclared key is refused. That is the whole answer to "how
do we know the model cannot emit code": not a filter, an absence of channel.

An action naming a tool that is not on the live list, or carrying arguments
the schema refuses, stops the run and is shown as what it was. It is never
re-asked: a refusal that produces another model call is a retry loop.

## Where it stops, and why

| Situation | What happens |
| --- | --- |
| Search returned more than one candidate | Stops for a human choice. A name is not an identity, and mutation must be exact. |
| Write returned `unknown` | Stops. *Execution outcome is unknown. The write may have persisted. Manual reconciliation is required before retry.* The model is not consulted. |
| Write returned `blocked` with `openRecordAt` and `mayHavePersisted: false` | Continues. The runtime itself established that nothing was modified, the record was opened, and invoking again is safe. |
| Write returned `blocked` any other way — including the duplicate-invocation refusal | Stops. None of those three facts is present. |
| Invocation threw | Stops, recorded as an invocation error and never as an application outcome. |
| Step budget reached | Stops and says so. |

The loop is only a caller: target identity, four-fact verification, the
invocation journal's duplicate protection and the failed/unheard
distinction all live below `executeTool` and are untouched.

## Tool availability

The control page registers every published capability it can actually
perform, by one of three routes and no fourth:

| Route | Example |
| --- | --- |
| Query binding — drives the taught application's own search UI through the Teach Mode extension | `search_opportunities` (Salesforce) |
| Execution binding — drives its own edit surface, same route | `update_opportunity` (Salesforce) |
| In-process binding — an application bundled in this document already implements it | `find_decision_maker_contacts` (SignalBase) |

The third is **off by default and opted into once, when the capability is
published** — a checkbox beside the Publish button, stored on the publication
record as `orchestration: true`. The default is the important half. A capability taught from SignalBase
belongs on SignalBase: that site registers it, that site performs it, and the
demo's whole claim is that an ordinary website gained an agent surface. A
second copy on the control document would make the Studio look like it hosts
other sites' tools.

Salesforce is not an exception to that rule — it does not need one. That
origin cannot host `document.modelContext` for us, so what the control page
registers is not a second copy; it is the only one.

The opt-in exists because the cross-application loop has no other way to get
two taught applications' tools onto one document: WebMCP is per-document, and
no page can read another origin's tool surface. Nothing is re-implemented even
then — SignalBase's capability is performed by `src/prospect/bindings.ts`, the
same module SignalBase's own document calls, and the Studio's UI says it is
registered *by this document*.

Asking for it is not the same as being able to do it: the flag registers
nothing for a capability taught somewhere this bundle cannot reach. And it is
never consulted where the Studio is the only possible host — a Salesforce org
cannot expose `document.modelContext` for us, so there is no second copy to
decide about.

Ownership is stated plainly in the UI and matters: **the Studio control
document registers these tools.** Neither SignalBase nor a Salesforce org
hosts anything here. What the taught application owns is the binding that
performs the capability.

## Files

| File | Responsibility |
| --- | --- |
| `src/agent/model.ts` | Types, and reading `getTools()` into tool definitions |
| `src/agent/action.ts` | Validating the model's action against the live tools and their schemas |
| `src/agent/observation.ts` | Reducing a result for the next step; deciding whether the loop may continue |
| `src/agent/loop.ts` | The loop itself, over injected ports |
| `src/agent/webmcp.ts` | The only place that touches `document.modelContext` |
| `src/agent/planner.ts` | The control plane call |
| `server.mjs` | `POST /api/agent/step` — stateless, structured, one action |
