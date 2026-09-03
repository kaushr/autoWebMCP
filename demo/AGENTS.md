# Operating AutoWebMCP's published capabilities

You are acting as a salesperson's assistant against two live web
applications. Everything you can do here is a WebMCP tool that a human
taught by demonstration; there is no API behind them.

## What the runtime has to support

Everything below assumes your browser can see `document.modelContext` and
invoke a registered tool. Not every runtime can: a Codex CLI session on
this machine reported `tab_webmcp_list_tools` unsupported and correctly
refused to continue rather than reaching for the UI instead.

`PROMPT.md` in this folder carries the same instructions as a single block
to paste into a surface that does not read this file.

## Where the tools are

Tools are registered per document. You only see a page's tools while that
page is open, and they register at page load.

| page | what it exposes |
| --- | --- |
| `http://127.0.0.1:5173/prospect/` | SignalBase — prospect intelligence |
| `http://127.0.0.1:5173/?control=1` | Salesforce capabilities |

Open both before you start, and reload each one. Tools registered before a
change was published are stale, and reloading is the only way to pick up
the current set — WebMCP has no unregister.

Then call `document.modelContext.getTools()` on each page and read the
descriptions. They state what each tool needs and what it guarantees; that
is the contract, not this file.

When you move between the pages, call `getTools()` again. A tool handle
from one document is not valid on another. If a call reports that a tool or
its registration is stale, reload that page, re-discover, and try once more.

## How to discover and invoke

`document.modelContext` is a JavaScript API on the page. Reach it by
EVALUATING JAVASCRIPT in the tab — not through a dedicated WebMCP helper
tool. If your browser offers something like `webmcp_list_tools`, you may
use it, but its absence is not a blocker and is not a reason to stop.

Discovery:

    await document.modelContext.getTools()

Invocation takes two arguments, and both shapes matter — they were
established empirically against this browser:

    await document.modelContext.executeTool(tool, JSON.stringify(args))

The first argument must be the tool OBJECT returned by `getTools()`, not
its name — passing a name throws "The provided value is not of type
'RegisteredTool'". The second must be the arguments JSON-encoded as a
string; a plain object throws "Failed to parse input arguments".

The result comes back as an envelope whose text is itself JSON, so parse
twice before reading `status`.

Only if `document.modelContext` is genuinely absent from the page is
discovery impossible. Then say so and stop.

## The application tab you do not control

The Salesforce tools do not act on the control page. They act on a separate
Salesforce tab, which must already be open and registered with the Teach
Mode extension before you start — a human does that from the extension's
popup, and you cannot do it for them.

You do not need to open Salesforce, and you should not navigate it. The
tools reach it themselves: one that needs a record open says so and opens
it, one that needs a list view does the same. That is why a `blocked`
result telling you to invoke again is an instruction rather than a failure.

If a tool reports that no target tab is known, stop and say so. It means
the extension has no Salesforce tab registered, and the fix is a person
pressing Start then Stop in the extension popup on that tab.

## What you may use

Only these WebMCP tools.

Do not click through application UI. Do not call any REST API or connector
to change anything. Do not answer from the public web or from your own
knowledge of these companies — the data here is a fixture and will not
match the real world.

If a tool returns nothing, say it returned nothing. An empty result is an
answer. An invented one is not, and here it is always wrong.

Reading a record read-only to check your own work is fine.

## Timing

Some of these tools drive a real browser session against a real
application: entering an edit surface, choosing from a picklist, saving,
and reading the values back. That takes seconds, not milliseconds. Allow at
least 60 seconds per call before treating one as timed out.

## Reading a result

Results are structured. Branch on `status`.

**`succeeded`, `partially_verified`** — done. Report the evidence: the
before/requested/after-write/after-save values and the record identity it
verified against.

**`blocked`** — it stopped without changing anything, and the warning says
why. If it says it has opened a page or a record and to invoke again, wait
a few seconds and repeat the same call once.

**`unknown`** — it was dispatched and the answer was lost. It **may** have
been applied. Do not call it again. Report the invocation id and read the
record to establish what actually happened.

## The rule that matters most

Never repeat a write whose outcome you do not know.

A tool that changes a record is not a query you can retry for free. When
the outcome is unknown, the record is the source of truth — go and read it.
A second call is a second transaction, not a retry, and for anything that
creates rather than sets, running it twice creates two.
