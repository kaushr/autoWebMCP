# AutoWebMCP

An open-source WebMCP hackathon reference implementation for a narrow idea: observe a human-oriented workflow, propose a small semantic business capability, require human confirmation, and deterministically compile that capability into WebMCP.

AutoWebMCP is the product. **SignalBase** is a small synthetic website it is taught
from: a stand-in for any ordinary business site a customer would want to make
agent-ready. SignalBase starts with no agent capabilities at all, and gains one
only after a human has taught, confirmed, and published it.

```text
TEACH → UNDERSTAND → CONFIRM → PUBLISH → USE
```

Salesforce remains a documented enterprise/platform constraint and compatibility spike, not a product integration.

## Run locally

```bash
npm_config_cache="$PWD/.npm-cache" npm install
npm run dev
```

For the server-side semanticizer, create an ignored `.env.local` containing `OPENAI_API_KEY`, then run:

```bash
npm run dev:semanticizer
```

The Vite app is available at `http://127.0.0.1:5173`. The controlled WebMCP check is `/?control=1`.

Two documents are served:

| Path | What it is |
| --- | --- |
| `/` | **AutoWebMCP Training Studio** — the control plane: Teach Mode captures, semanticizer, confirmation, publication. |
| `/prospect/` | **SignalBase** — the taught site. An ordinary prospect-intelligence website with synthetic data. |

The controlled WebMCP check is `/?control=1`.

## SignalBase

SignalBase is a deliberately small sales-research site: search companies, open a
company, filter its contacts by function and seniority, open a contact. It is
not a CRM, a sequencer, or an enrichment platform, and it has no connection of
any kind to Salesforce — an agent is expected to compose the two independently
taught capability surfaces itself.

Routes are hash-based so URL state is real and shareable while the document
never reloads, which is what lets a Teach Mode session survive a whole workflow:

```text
#/                                    company search
#/?q=Acme                             search results
#/company/acme                        company detail + contacts
#/company/acme?function=Procurement&seniority=VP   filtered contacts
#/contact/contact-acme-01             contact detail
```

### SignalBase starts with no WebMCP tools

This is the point of the demo, so it is worth stating plainly: opening SignalBase
and running `await document.modelContext.getTools()` returns none of its business
capabilities. The header says `Agent capabilities: Not published`.

A capability appears only after the full lifecycle:

```text
Teach Mode records the Acme workflow on SignalBase
  → Studio receives the normalized trace
  → semanticizer proposes Find Relevant Contacts
  → a human confirms the contract
  → a human presses Publish
  → SignalBase registers find_relevant_contacts and the header turns green
```

`npm run dev:semanticizer` must be running to publish; the store is in memory, so
restarting it returns SignalBase to a plain website. The Studio's **Unpublish
all** does the same without a restart.

The published tool binds to the functions the pages already use — see
`src/prospect/bindings.ts` — so an agent and a human get the same answers from
the same code.

## Browser extension

The Teach Mode extension is the local capture agent. Build it, then load
`dist-extension/` as an unpacked extension in Chrome:

```bash
npm run build:extension
```

Start training, perform the workflow, stop training, and the normalized trace
appears in the Training Studio's **Teach Mode captures** panel. See
[docs/EXTENSION.md](docs/EXTENSION.md).

The session also records sanitized network metadata for the recording tab and
correlates it with the actions, so a trace can show *how* the application
carried a step out:

```text
Save  →  POST /aura  ·  200  ·  +37ms  ·  high confidence
         application: confirmation toast shown
```

Metadata only — no headers, cookies, tokens, bodies, or query values, and no
URL to replay. This is evidence about an application's behaviour, never an
execution binding: nothing here is published to an agent. An application with no
network traffic, like SignalBase, honestly reports none.

## Verify

```bash
npm test
npm run build
```

`document.modelContext` is experimental and must be tested in a WebMCP-enabled ChatGPT/Chrome environment. The source sends origin-isolation and permissions-policy headers; local UI success alone does not prove tool discovery.

## Scope boundary

The architecture is intentionally split into learning-time and live-execution paths:

```text
Teach: human uses application → extension observes action/context/reaction/network metadata
      → normalizer → semanticizer → confirmed semantic capability

Live cooperative site: semantic capability → existing application binding → WebMCP
Live constrained site: semantic capability → generic MCP/browser runtime → existing application binding
```

The browser extension implements the Teach path above. The generic MCP fallback and Runtime Mode remain future direction, not implemented here. Salesforce is the example showing why a constrained site may need that fallback. This repository intentionally excludes browser replay, commercial Salesforce packaging, real data, external prospecting APIs, and direct cross-system connectors.
