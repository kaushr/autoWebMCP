# AutoWebMCP

An open-source WebMCP hackathon reference implementation for a narrow idea: observe a human-oriented workflow, propose a small semantic business capability, require human confirmation, and deterministically compile that capability into WebMCP.

The controlled demo is **Prospect Intelligence**, with synthetic company and contact data. Salesforce is a conditional runtime spike—not a product integration.

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

This repository intentionally excludes generalized workflow learning, browser replay, commercial Salesforce packaging, real data, external prospecting APIs, and direct cross-system connectors.
