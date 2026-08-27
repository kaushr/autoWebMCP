# AutoWebMCP

An open-source WebMCP hackathon reference implementation for a narrow idea: observe a human-oriented workflow, propose a small semantic business capability, require human confirmation, and deterministically compile that capability into WebMCP.

The controlled demo is **Prospect Intelligence**, with synthetic company and contact data. Salesforce remains a documented enterprise/platform constraint and compatibility spike, not a product integration.

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

The browser extension and generic MCP fallback are future runtime direction, not implemented here. Salesforce is the example showing why a constrained site may need that fallback. This repository intentionally excludes browser replay, commercial Salesforce packaging, real data, external prospecting APIs, and direct cross-system connectors.
