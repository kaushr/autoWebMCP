# Hackathon demo runbook

Three capabilities, taught by demonstration and published as WebMCP tools,
driven by an agent from one plain-language request.

The point of the pairing: **SignalBase is a cooperative site** — it
advertises actions it can already perform — while **Salesforce is not**, so
AutoWebMCP drives its UI. Same recorder, same Studio, same publication
gate; two completely different execution strategies underneath.

## Services

```bash
npm run dev     # 5173 — Studio, SignalBase, WebMCP control page
npm start       # 8787 — control plane API (needs .env.local)
```

Use 5173 for every page. 8787 also serves a built copy from `dist/`, which
is an excellent way to test code that is not running.

## Pages

| | |
| --- | --- |
| Studio | `http://127.0.0.1:5173/` |
| SignalBase | `http://127.0.0.1:5173/prospect/` |
| WebMCP control | `http://127.0.0.1:5173/?control=1` |

## Before a run

1. `chrome://extensions` → reload **AutoWebMCP Teach Mode**
2. Salesforce: open the record, close any edit modal left open
3. Extension popup → **Start training** → **Stop training** (registers the tab)
4. Hard-reload the Studio and the control page

If an orange banner appears, do what it says. It compares the build stamp
the page carries against the one the loaded extension carries, and against
the control plane's API version — a half-reloaded browser produces
confident results about code that is not running.

## Which agent surface

The instructions live in two places because the surfaces differ.

`AGENTS.md` is read by a Codex CLI session started in this folder. `PROMPT.md`
carries the same content as one pasteable block, for a surface that supports
WebMCP but reads no project file.

At the time of writing only the second could actually invoke a tool: a CLI
session here reported `tab_webmcp_list_tools` unsupported. It followed the
instructions correctly — opened both pages, reloaded them, chose `getTools()`
— and then stopped rather than driving the UI by hand, which is the right
answer to a runtime that cannot do the thing being demonstrated.

## The ask

```text
Find the VP of Procurement at Tesla, put them on our Tesla opportunity as
the main sponsor, move it to Collaborate, and push the close date to
December 25th.
```

No tool names, no sequencing. If the agent cannot work out the steps from
the descriptions alone, that is a gap in the descriptions — which is the
thing worth knowing.

## Known limitations

- **Bridge-backed tools may not return to an external agent.** Measured
  repeatedly: a tool that resolves in-page returns to Codex, while one
  whose result travels back through the extension does not. The Studio's
  WebMCP harness invokes the identical tool page-side and shows the full
  envelope, including how long it took.
- **A browser-driven mutation costs seconds**, not milliseconds. That is
  the price of working against an application that exposes no API.
- **The control page is scaffolding.** A shipped version would register
  these tools on the application's own origin; here they live on a control
  document because Salesforce does not cooperate.
