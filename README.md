# AutoWebMCP: Teach an Agent to Fish

AutoWebMCP turns human demonstrations of web application workflows into
semantic, typed capabilities that can be published through WebMCP and used by
AI agents. A person performs a workflow once in an ordinary business
application. AutoWebMCP reads that demonstration as evidence, proposes the
business capability it thinks was being demonstrated, asks a human to confirm
the contract, grounds the contract to an execution binding, tests that binding
against the live application, and only then publishes a WebMCP tool.

**The demonstration is evidence, not the automation.**

That distinction is the whole project. AutoWebMCP does not publish
click/fill/scroll primitives, and it does not store a macro to replay. A
recorded trace carries no selector, no XPath, no coordinate, and no key
sequence, so it *cannot* be replayed by construction. What gets published is a
named business capability with typed inputs, typed outputs, declared safety,
and an identity requirement the human never demonstrated but an agent must
supply.

```text
Teach  ->  Semanticize  ->  Validate  ->  Publish  ->  Agent
```

## What AutoWebMCP Does

1. A user demonstrates a workflow with **Teach Mode** (a Chrome MV3 extension).
2. AutoWebMCP captures **interaction evidence**: actions, page context,
   application reactions, and sanitized network metadata. No selectors, no
   bodies, no headers, no cookies, no tokens.
3. The **Training Studio** infers a semantic capability from that evidence.
4. The user **reviews and confirms** the proposed contract. Nothing a model
   merely proposed can be published.
5. AutoWebMCP **grounds** the capability to an execution binding: either an
   advertised application binding the site already has, or a semantic browser
   execution binding that drives the application's own UI.
6. The capability is **tested against the live application** from the Studio.
7. It is **published through WebMCP** and registered with
   `document.modelContext.registerTool(...)`.
8. Agents **discover and invoke** the semantic capability through
   `getTools()` and `executeTool()`.

The governing principle for step 5 onwards:

> **Search may be fuzzy. Mutation must be exact.**

A search is allowed to match loosely and return several candidates. A write is
not. Every mutation carries an explicit target identity, the requested target is
compared against the target actually observed on the page before anything is
written, and the identity is re-read after the save. Where several records could
be meant, the ambiguity is handed back rather than silently resolved.

## Demo

Three capabilities, each taught separately by demonstration, each published as a
WebMCP tool.

**SignalBase** (the bundled synthetic prospect-intelligence site):

- `find_company_contact_by_seniority_and_function`

**Salesforce** (a Lightning org, driven through its own browser UI):

- `search_opportunities`
- `update_opportunity_details`

An agent composes these independently taught capabilities to find a relevant
contact in SignalBase, resolve the exact Salesforce Opportunity by search,
update it, and verify the result.

**The sequence is not hardcoded.** There is no routine, no recorded plan, and no
scripted tool order anywhere in this repository. The agent is given one
plain-language request and chooses among whatever
`document.modelContext.getTools()` currently reports, reading the same tool
descriptions, JSON schemas, `readOnlyHint` annotations, identity requirements,
and composition hints that any browser agent would see. Every call goes through
`document.modelContext.executeTool`, which is the only route to the execution
engine.

The request used in the submission video, verbatim:

```text
Find the VP of Procurement at Tesla, put them on our Tesla opportunity as
the main sponsor, move it to Collaborate, and push the close date to
December 25th.
```

No tool names. No ordering. The runbook is in [demo/README.md](demo/README.md),
the pasteable agent instructions in [demo/PROMPT.md](demo/PROMPT.md).

## Try It

Two local paths, plus a hosted page for a first look. Path A needs no Salesforce
access at all. Path B is for a judge who wants to reproduce the Salesforce half
in their own org.

Prerequisites for both local paths: **Node.js 22.12 or newer** (Vite 7 and the
`openai` client set that floor; developed on Node 26) and **Google Chrome 120 or
newer**. For WebMCP discovery and invocation you need a Chrome build that
exposes `document.modelContext`; see [Testing WebMCP](#testing-webmcp) below.

### Hosted: look without installing anything

**Live demo: <https://auto-web-mcp.vercel.app/>**

To test WebMCP directly, go straight to the control page, which registers a real
tool at page load with no backend:

**<https://auto-web-mcp.vercel.app/?control=1>**

The deployment is the static front end only, served with the same origin
isolation and `Permissions-Policy: webmcp=(self)` headers the local dev server
sends. What genuinely works there:

- **The WebMCP control page** registers `hello_webmcp` at page load. In a
  WebMCP-capable browser you can discover and invoke a real tool on the live
  URL, with no backend involved.
- **SignalBase** renders with its synthetic dataset, and can be made to publish
  a real capability in front of you. See the smoke test below.
- **The Training Studio UI** loads and can be read.

#### The 30-second smoke test

This is the shortest path to seeing an ordinary website gain an agent surface.
Use a WebMCP-capable browser, or steps 3 and 5 will report that the browser
cannot discover tools.

1. Open <https://auto-web-mcp.vercel.app/prospect/>. The header reads
   **Agent capabilities: Not published**. The site genuinely has no tools yet,
   which is the demo's whole starting point.
2. Run `await document.modelContext.getTools()` in the console. Nothing of
   SignalBase's is there.
3. Click the header badge to expand it, then press
   **Publish Find decision maker contact**.
4. The header turns green and reads **Agent capabilities: 1 published**.
   Expanding it now shows the tool's name, description, and input schema, read
   back from `getTools()` rather than from anything this page asserts.
5. Run `await document.modelContext.getTools()` again. The capability is there,
   and is callable.
6. **Refresh the page.** It stays published, because the acceptance is
   remembered in your browser the way the control plane remembers a publication
   in its state file.
7. Press **Unpublish and reload** to put the site back to step 1.

What you accepted is not a fixture written to make a demo look good. It is the
record the control plane stored when a human taught this workflow and confirmed
the contract, exported verbatim with its provenance and observation ids intact,
and it is registered through exactly the same compile path a local publication
takes. Pressing that button is the hosted stand-in for pressing **Publish** in
the Studio, which is why the site still starts with nothing until you do.

Your acceptance is local to your browser. Nobody else's view of the site
changes, so every judge sees the empty starting state first.

What does not, and cannot, work on a hosted URL:

- **Teaching, semanticizing, and publishing.** These need the local control
  plane, so the Studio shows its page-level banner saying it cannot reach one.
- **Anything involving Salesforce.** The Teach Mode extension only bridges
  `127.0.0.1:5173` and `127.0.0.1:8787` by design, so a hosted page has no
  extension bridge and no target tab.

The deployment exists so a judge can see the surfaces and confirm WebMCP
registration in one click. **Reviewing the actual pipeline means running it
locally**, via Path A below.

```bash
git clone <this repository>
cd AutoWebMCP
npm install
```

### Path A: Bundled, no external credentials

#### A1. Prove WebMCP works, in about a minute, with no API key

```bash
npm run dev
```

Open `http://127.0.0.1:5173/?control=1` in Chrome.

This is the **WebMCP control page**. It registers one tool, `hello_webmcp`, at
page load, with no server, no key, and no extension involved. The page's own
harness panel reports three separate facts, because they are three separate
browser permissions: whether `document.modelContext` exists, whether the browser
lets a page enumerate its tools, and whether it lets a page invoke one. In a
WebMCP-capable browser the panel lists `hello_webmcp` as read back from
`getTools()` and lets you invoke it. In a browser without WebMCP the panel says
so plainly rather than claiming success.

The port is deliberately strict: `npm run dev` refuses to start on any port
other than 5173, because the extension's content-script `matches` name
`127.0.0.1:5173` literally and a Studio on another port would look correct while
being silently unreachable.

Two documents are served:

| URL | What it is |
| --- | --- |
| `http://127.0.0.1:5173/` | **Training Studio**. Teach Mode captures, semanticizer, confirmation, binding tests, publication. |
| `http://127.0.0.1:5173/prospect/` | **SignalBase**. The taught site: an ordinary synthetic prospect-intelligence website. |
| `http://127.0.0.1:5173/?control=1` | **WebMCP control page**. The orchestration surface and proof surface. |

#### A2. Teach SignalBase a capability and publish it

This is the full loop. It needs an OpenAI API key (the semanticizer and the
grounding stage are model calls) and the Teach Mode extension.

**Open SignalBase first and check that it has nothing.** Go to
`http://127.0.0.1:5173/prospect/` and run in the console:

```js
await document.modelContext.getTools()
```

None of SignalBase's business capabilities are there, and the site header reads
`Agent capabilities: Not published`. That is the point of the demo: the site
starts as a plain website and gains an agent surface only after a human has
taught, confirmed, and published one. (In a browser with no WebMCP at all the
call throws and the header instead reads `WebMCP unavailable in this browser`,
which is a different statement and is kept distinct on purpose.)

Then:

1. **Configure the control plane.** Copy [.env.example](.env.example) to
   `.env.local` and set `OPENAI_API_KEY`. The file is gitignored. Both
   `npm start` and `npm run dev:semanticizer` load it with Node's `--env-file`
   and will fail to start if it does not exist.

2. **Start the control plane** in a second terminal:

   ```bash
   npm start
   ```

   It listens on `http://127.0.0.1:8787`. `npm run dev:semanticizer` is the same
   thing under a different name. Vite proxies `/api` to it.

3. **Build and load the extension.** See
   [Chrome Extension Installation](#chrome-extension-installation).

4. **Demonstrate the workflow.** On `http://127.0.0.1:5173/prospect/`, open the
   extension popup and press **Start training**. Then work the site normally:
   search for a company, open it, filter its contacts by function and seniority,
   open a contact. Press **Stop training**.

5. **Semanticize.** In the Training Studio at `http://127.0.0.1:5173/`, open the
   **Teach Mode captures** panel, refresh, select the new trace, and press
   **Understand this recording**. The Studio shows the normalized
   action/reaction evidence, not replay steps, and then the proposed capability.

6. **Confirm the contract.** Edit the name, description, inputs, and outputs if
   you disagree with the proposal, then confirm it. Publication is gated on a
   human confirmation plus an execution binding; either one alone is a
   legitimate state and neither alone can publish.

7. **Accept the execution binding.** SignalBase is a *cooperative* application:
   it advertises the functions its own pages already call, in
   [src/prospect/bindings.ts](src/prospect/bindings.ts), so an agent and a human
   get the same answers from the same code.

8. **Publish.** Press **Publish WebMCP capability**. The Studio states where the
   tool will be registered. For a capability the taught site can host, that is
   SignalBase's own document, with an optional checkbox to *also* register it on
   the WebMCP control page for cross-application composition.

9. **Verify.** Reload `http://127.0.0.1:5173/prospect/`. The header turns green
   and `await document.modelContext.getTools()` now reports the capability.

Published capabilities are persisted to `.autowebmcp/publications.json` and
reloaded when the control plane restarts, so a demo survives an accidental
restart. Emptying them is therefore deliberate: use the Studio's **Unpublish
all**, or the per-capability unpublish control, to return SignalBase to a plain
website. The directory is gitignored.

### Path B: Bring Your Own Salesforce Org

We deliberately do **not** distribute credentials to the private Salesforce
development org used in the submission video. A judge who wants to reproduce the
Salesforce half should use their own org and their own authenticated browser
session.

AutoWebMCP never sees those credentials. There is no OAuth flow, no Salesforce
session-token extraction, no Salesforce-hosted code required, and no use of the
private Aura transport. Execution happens in the tab the human already
authenticated, driven through the application's own UI.

#### What is actually supported today

Read this before you record anything. The Salesforce support in this repository
is a bounded, proven slice, not a general integration.

**Supported and proven:**

- **Searching for existing Opportunity records.** A demonstrated search is turned
  into a read-only entity search that returns candidate records *with their
  record identities*, so a following mutation can name exactly one.
- **Updating fields on an existing Opportunity record**, through its Lightning
  edit surface, with every target re-resolved from a live label/role/accessible
  name search at execution time. Field kinds handled are text, date, picklist,
  checkbox, and number.

**Not supported. Do not expect these to work:**

- Record creation of any kind. There is no create path for Opportunities,
  Contacts, Events, Tasks, or anything else.
- Objects other than Opportunity. The shipped Salesforce Intelligence Pack
  carries the standard Opportunity field model and nothing else, in
  [src/platformIntelligence/packs/salesforce.ts](src/platformIntelligence/packs/salesforce.ts).
  A field the pack does not know is indistinguishable from a custom one, and the
  grounding stage will stop and ask a human for its API name rather than guess.
- Arbitrary Salesforce workflows, or a guarantee that every org works. Orgs with
  heavily customized Lightning record pages, overridden edit actions, or
  non-English labels are untested. The date and picklist handling in
  [src/binding/browserExecution/salesforceAdapter.ts](src/binding/browserExecution/salesforceAdapter.ts)
  is English-language and Lightning-specific by admission.
- Generic cross-app identity translation. When the demo agent carries a contact
  from SignalBase onto a Salesforce Opportunity, *the agent* carries the value.
  There is no identity resolution service, no cross-system key mapping, and no
  connector between the two applications. SignalBase has no connection of any
  kind to Salesforce.

#### The workflow

1. **Build and load the Teach Mode extension** (see
   [Chrome Extension Installation](#chrome-extension-installation)).
2. **Start both services**: `npm run dev` and `npm start`.
3. **Open your own Salesforce org** in Chrome and navigate to an Opportunity
   record. Close any edit modal left open.
4. **Register the tab.** In the extension popup, press **Start training** and
   then **Stop training** once on the Salesforce tab. This is how the extension
   learns which tab the Salesforce tools should act on. It is easy to skip and
   impossible to guess: without it every Salesforce tool answers that no target
   tab is known.
5. **Demonstrate a supported workflow**: press **Start training**, then either
   search for an Opportunity by name, or open one and edit supported fields and
   save. Press **Stop training**.
6. **Open the Training Studio** at `http://127.0.0.1:5173/`.
7. **Semanticize** the recording: **Teach Mode captures** -> select -> **Understand
   this recording**.
8. **Review and confirm** the proposed capability contract.
9. **Test the execution binding.** The Studio's **Test execution** panel runs the
   proposed binding against the live tab and shows the full result: how far it
   got, the before / requested / after-write / after-save value for every input,
   and which record identity was actually acted on. Accept the binding only if
   that evidence is right. A search binding is accepted separately from a
   mutation binding.
10. **Publish.** A Salesforce org cannot expose `document.modelContext` for us,
    so the Studio states plainly that the WebMCP control page is the only
    possible host and there is nothing to choose.
11. **Discover and invoke.** Open `http://127.0.0.1:5173/?control=1`, reload it,
    and call `getTools()` / `executeTool()`, or point a WebMCP-capable agent at
    the page using [demo/PROMPT.md](demo/PROMPT.md).

A browser-driven mutation takes seconds, not milliseconds. Allow at least 60
seconds per call. That is the price of working against an application that
exposes no usable API.

## Chrome Extension Installation

```bash
npm install
npm run build:extension
```

That writes `dist-extension/` in the repository root, containing
`manifest.json`, `popup.html`, `background.js`, `content.js`, `popup.js`, and
`studioBridge.js`. The directory is gitignored, so it is built rather than
cloned.

Then in Chrome:

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Press **Load unpacked**.
4. Select the `dist-extension/` directory in the repository root. Not
   `extension/`, which holds the TypeScript sources.

The extension is Manifest V3 and requires Chrome 120 or newer. Its popup has an
**Advanced / Debug** section carrying the control plane origin, in case you run
the control plane somewhere other than `http://127.0.0.1:8787`.

Rebuild with `npm run build:extension` and press **reload** on
`chrome://extensions` after any change. The Studio and the extension each carry
a build stamp and compare them; a half-reloaded browser produces confident
results about code that is not running, and an orange banner appears when that
happens.

More detail in [docs/EXTENSION.md](docs/EXTENSION.md).

## Running AutoWebMCP Studio

From a clean clone:

```bash
npm install
npm run dev
```

The Studio is at **`http://127.0.0.1:5173/`**. The port is enforced.

For anything that involves semanticizing, grounding, publishing, or the agent
loop, also run the control plane:

```bash
cp .env.example .env.local     # then set OPENAI_API_KEY
npm start
```

The control plane listens on **`http://127.0.0.1:8787`** and Vite proxies `/api`
to it. It also serves a built copy from `dist/`, which is a good way to notice
that you are testing code you did not rebuild.

All commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on 127.0.0.1:5173 (Studio, SignalBase, control page). |
| `npm start` | Control plane on 127.0.0.1:8787. Requires `.env.local`. |
| `npm run dev:semanticizer` | Same as `npm start`. |
| `npm run build` | Production build of both documents into `dist/`. |
| `npm run build:extension` | Builds the MV3 extension into `dist-extension/`. |
| `npm run build:all` | Stamps a build identity, then builds both. |
| `npm test` | The full Vitest suite. |
| `npx tsc --noEmit` | Typecheck. There is no `typecheck` script. |

## Testing WebMCP

`document.modelContext` is experimental. To exercise discovery and invocation
you need a Chrome build that exposes it. The environment this project was
developed and demonstrated against was **Chrome 151 with
`chrome://flags/#enable-webmcp-testing` enabled**, which is what proved
`document.modelContext`, `registerTool()`, `getTools()`, and `executeTool()`
work on a Salesforce Lightning page. If that flag is absent
from your Chrome build, the pages still load and the Studio still works, but
they will honestly report that WebMCP is unavailable rather than pretend
otherwise.

To check that tools are registered, open a page and run in the console:

```js
const tools = await document.modelContext.getTools();
tools.map((t) => t.name);
```

To invoke one:

```js
const tool = tools.find((t) => t.name === "search_opportunities");
// The argument names come from the tool's own inputSchema. Read it first:
//   tool.inputSchema
const result = await document.modelContext.executeTool(tool, JSON.stringify({ /* ... */ }));
```

Two details that are easy to get wrong and are load-bearing here: `executeTool`
takes the tool **object** returned by `getTools()`, not its name, and the second
argument is the arguments **JSON-encoded as a string**. The result is an envelope
whose text is itself JSON, so it parses twice.

WebMCP is per-document. `getTools()` only ever answers for the document it is
called on, and a tool handle from one page is not valid on another. Call it again
after switching pages.

**Where the control surface lives, and why.** SignalBase registers its own
capabilities on its own document, because a capability an ordinary website can
host belongs on that website and that is the demo's central claim. Salesforce
capabilities cannot work that way: a Salesforce org will not let us register
tools on its document. So they are registered on the WebMCP control page at
`http://127.0.0.1:5173/?control=1`, which acts as the host document and reaches
the live Salesforce tab through the Teach Mode extension. That page is
scaffolding and is described as such. A shipped version would register these
tools on the application's own origin.

The same per-document constraint is why cross-application composition needs a
second copy. No page can read another origin's tool surface, so composing a
SignalBase tool with a Salesforce tool requires both on one document. That is
asked for explicitly, once, as a checkbox beside the Publish button, rather than
being a mode a page silently falls into.

## Architecture

```text
Human Demonstration
        |
        v
Semantic Capability
        |
        v
Execution Binding
        |
        v
Validation
        |
        v
WebMCP Publication
        |
        v
Agent
```

The semantic capability is deliberately separated from the execution binding.
*What a capability means* is a human-confirmed contract. *How the application
performs it* is a separate, independently validated mechanism. One capability
can have more than one execution strategy, and the Studio shows each honestly:
an advertised application binding, a supported application API, or semantic
browser execution that drives the taught application's own UI with every target
re-resolved live. Any one accepted route is enough to publish, and none weakens
the requirements on the others. Because validity is a property of a binding *in
a context*, `requires-setup` is a first-class outcome rather than a failure.

Three intelligence layers feed the pipeline, at a high level:

- **Platform Intelligence** is reusable, versioned knowledge about a platform:
  how Lightning retargets events, what identity a route carries, what must never
  be replayed, how to tell a blocking validation error from a success toast.
- **Application Intelligence** is the object and field model of the specific
  application being taught, which is what turns a demonstrated field edit into a
  named, typed input and contributes the target identity nobody demonstrated.
- **Tenant observation** is what a particular org actually has, such as the
  picklist values configured in *this* org, which is configuration rather than
  vendor knowledge and is therefore read rather than assumed.

Each layer lives in its own directory under `src/`, named after it, and the
page-side agent loop is described in [docs/AGENT_LOOP.md](docs/AGENT_LOOP.md).
The design documents behind these decisions are kept out of this repository:
they are working notes about tradeoffs, not onboarding material, and the code
plus its comments is the version that stays true.

## Safety and Verification

These are the properties the implementation actually enforces. They are narrow
on purpose.

- **Explicit target identity for mutations.** A capability that changes an
  existing record requires an identity input, such as `opportunity_id`. The
  human demonstrated which *fields* to change; the system contributes which
  *record*, because an agent cannot be trusted to mean "whichever one happens to
  be open". See
  [src/applicationIntelligence/targetIdentity.ts](src/applicationIntelligence/targetIdentity.ts).
- **Requested target must match observed target before writing.** The identity
  the page is actually showing is read from the route, compared with the
  requested identity, and a mismatch blocks before anything is written.
- **Post-save identity verification.** The identity is read again after the save,
  so a run that navigated away mid-write does not report success. Verification
  requires requested, pre-write, and post-save to be one entity.
- **Requested versus observed versus verified state is never collapsed.** Every
  input carries its before, requested, after-write, and after-save values
  separately, and each is marked verified `yes` / `no` / `unreadable`. A result
  that could not be read back is `partially_verified`, not `succeeded`.
- **Ambiguity is preserved rather than silently resolved.** A search that finds
  several candidates hands them back. Nothing picks one.
- **Unknown write outcomes are not blindly retried.** A dispatched write whose
  answer was lost reports status `unknown`, carries the invocation id, and is
  explicitly not retried. A second call is a second transaction, not a retry.
- **The capture is not replayable.** No selector, XPath, coordinate, or key
  sequence is ever emitted; network capture is metadata only, with no headers,
  cookies, tokens, bodies, query values, or replayable URL.
- **Publication is gated on human confirmation.** A capability a model merely
  proposed cannot be published, enforced on both sides of the wire in
  [src/webmcp/publication.ts](src/webmcp/publication.ts).

What these properties are *not*: they are not a security boundary against a
hostile agent, not an authorization model, and not a guarantee about
applications other than the ones tested. They are correctness properties about
writing to the record you meant to write to.

## WebMCP

The WebMCP integration is small and deliberately concentrated. These are the
files to read:

| File | What it does |
| --- | --- |
| [src/webmcp/types.ts](src/webmcp/types.ts) | The `document.modelContext` surface as this project models it: `registerTool`, `getTools`, `executeTool`. |
| [src/webmcp/compiler.ts](src/webmcp/compiler.ts) | Deterministically compiles a confirmed capability into a WebMCP tool and calls `document.modelContext.registerTool(...)`. |
| [src/webmcp/harness.ts](src/webmcp/harness.ts) | Probes what the browser actually permits, and reads tools back with `document.modelContext.getTools()`. |
| [src/webmcp/publication.ts](src/webmcp/publication.ts) | The publication record and the gate that decides what may become a tool. |
| [src/webmcp/hello.ts](src/webmcp/hello.ts) | `hello_webmcp`, the zero-dependency registration proof on the control page. |
| [src/agent/webmcp.ts](src/agent/webmcp.ts) | The agent loop's only route to a tool: `document.modelContext.executeTool(...)`. |
| [src/prospect/app/agentReadiness.ts](src/prospect/app/agentReadiness.ts) | SignalBase's own agent-readiness panel, and why "passed to `registerTool`" is not the same claim as "discoverable". |
| [src/main.ts](src/main.ts) | The Studio, the control page, and the judge-facing WebMCP harness panel. |

Tests: [tests/webmcp-harness.test.ts](tests/webmcp-harness.test.ts),
[tests/compiler.test.ts](tests/compiler.test.ts),
[tests/publish-lifecycle.test.ts](tests/publish-lifecycle.test.ts),
[tests/agent-webmcp-surface.test.ts](tests/agent-webmcp-surface.test.ts).

## Tech Stack

- **WebMCP** (`document.modelContext`), the publication and invocation surface
- **TypeScript** (strict) for all application code
- **JavaScript** (ESM) for the control plane and build scripts
- **Node.js** 22.12+ for the control plane
- **Vite** 7 for both documents and the extension bundles
- **Vitest** 3 with jsdom for the test suite
- **Chrome Extension / Manifest V3** for Teach Mode
- **rrweb** (`@rrweb/record`) as the capture sensor
- **OpenAI API** (`openai`) for semanticizing, grounding, and the agent loop
- **Salesforce** Lightning as the constrained-application case study

## AI Tools Used

- **ChatGPT** for architecture, research, product design, and adversarial review
- **OpenAI Codex** and **Claude Code** for implementation, testing, debugging,
  and code review, including WebMCP agent testing with Codex
- **OpenAI API** for semanticizing demonstrations and powering the page-side
  agent loop

## Hackathon

Built for **The WebMCP Challenge on Devpost, 2026**.

- Devpost submission: <https://devpost.com/software/autowebmcp-teach-an-agent-to-fish>
- Demo video: <https://youtu.be/H9Ppgautv4U>
- Live deployment: <https://auto-web-mcp.vercel.app/>
  (WebMCP check: <https://auto-web-mcp.vercel.app/?control=1>)

## Limitations

Stated plainly, because several of them affect what a judge will see.

- **Two execution worlds, and only one is cheap.** A *cooperative* application
  like SignalBase advertises functions it already has, so execution is a direct
  call and returns in milliseconds. A *constrained* application like Salesforce
  exposes nothing usable, so execution drives its browser UI: entering an edit
  surface, resolving a control by accessible name, choosing from a picklist,
  saving, and reading values back. That takes seconds per call.
- **Bridge-backed tool results may not return to an external agent.** Measured
  repeatedly: a tool that resolves in-page returns to an external agent, while
  one whose result travels back through the extension does not always. The
  Studio's own WebMCP harness invokes the identical tool page-side and shows the
  full envelope, which is the reliable way to see a Salesforce tool's result.
- **The control page is scaffolding.** Salesforce capabilities live on it only
  because a Salesforce org will not host `document.modelContext` for us.
- **Salesforce support is Opportunity search and Opportunity field updates.**
  Nothing else. No creation, no other objects, no non-English labels. See
  [Path B](#what-is-actually-supported-today).
- **Published capabilities persist locally, on disk.** They live in
  `.autowebmcp/publications.json` beside the control plane, which is a local
  file rather than a database, so nothing is shared between machines. Recorded
  traces, by contrast, are held only in memory and are lost on restart.
- **Manual tab registration is required for Salesforce.** Only a human can tell
  the extension which tab the tools act on, by starting and stopping training on
  it once.
- **The agent loop is a caller, not an agent framework.** It reads what
  `getTools()` reports, asks a model what to do, and calls `executeTool()`. It is
  not an MCP server, a workflow engine, or a hardcoded sequence.
- **Not implemented, and not claimed:** browser replay, a generic MCP/browser
  runtime fallback for constrained sites, Salesforce OAuth or packaging, RAG or
  documentation crawling for Platform Intelligence packs, real customer data, and
  any direct cross-system connector.

## Repository Map

```text
src/capture/                  Recording session, masking policy, normalizer
src/semantic/                 Semantic capability model and composition
src/training/                 Semanticizer, grounding, binding inference, Studio lifecycle
src/binding/                  Binding candidates, validation, browser execution engine
src/applicationIntelligence/  Object/field model, target identity, tenant observation
src/platformIntelligence/     Versioned platform packs (Salesforce)
src/webmcp/                   Compiler, harness, publication, types
src/agent/                    Page-side agent loop
src/prospect/                 SignalBase, the taught demo site
extension/                    Teach Mode MV3 extension sources
server.mjs                    Control plane
docs/                         Design documents and decision records
demo/                         Hackathon runbook and agent instructions
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
