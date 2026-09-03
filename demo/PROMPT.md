# Ready to paste

For a Codex surface that supports WebMCP but does not read `AGENTS.md`.
Send both halves as one message: the operating instructions, then the ask.

---

Operate only through WebMCP tools registered on these pages. Tools are
per-document and register at page load, so open both and reload each one
before starting, then call `document.modelContext.getTools()` on each and
read the descriptions — they state what each tool needs and guarantees.

    http://127.0.0.1:5173/prospect/     SignalBase — prospect intelligence
    http://127.0.0.1:5173/?control=1    Salesforce capabilities

Call `getTools()` again whenever you switch pages; a tool handle from one
document is not valid on another. If a call reports a tool or registration
is stale, reload that page, re-discover, and try once more.

The Salesforce tools do not act on the control page. They act on a separate
Salesforce tab that a human has already opened and registered with the
Teach Mode extension. Do not open or navigate Salesforce yourself — the
tools reach it on their own, and a `blocked` result telling you to invoke
again is an instruction, not a failure. If a tool reports that no target
tab is known, stop and say so; only a person can register it.

Use nothing else. Do not click through application UI, do not call any REST
API or connector to change anything, and do not answer from the public web
or your own knowledge — the data here is a fixture and will not match the
real world. If a tool returns nothing, say it returned nothing; an empty
result is an answer and an invented one is always wrong here. Reading a
record read-only to check your own work is fine.

These tools drive a real browser session against a real application —
entering an edit surface, choosing from a picklist, saving, reading the
values back. Allow at least 60 seconds per call.

Branch on the result's `status`:

- `succeeded` / `partially_verified` — done. Report the evidence: the
  before/requested/after-write/after-save values and the record identity.
- `blocked` — it stopped without changing anything and the warning says
  why. If it says it opened a page or record and to invoke again, wait a
  few seconds and repeat the same call once.
- `unknown` — it was dispatched and the answer was lost. It **may** have
  applied. Do not call it again. Report the invocation id and read the
  record to establish what happened.

Never repeat a write whose outcome you do not know. A second call is a
second transaction, not a retry.

---

Find the VP of Procurement at Tesla, put them on our Tesla opportunity as
the main sponsor, move it to Collaborate, and push the close date to
December 25th.
