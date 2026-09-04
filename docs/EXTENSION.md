# Browser Extension — Teach Mode

Status: P0 complete, 2026-08-26. Chrome only.

The extension is the local browser-side sensor for the Teach pipeline. It is
not the semantic model, and it is explicitly not a replay recorder.

```text
Human workflow
  → extension (rrweb + safe augmentation + sanitized network metadata)
  → normalized observation trace
  → Training Studio
  → LLM semanticizer
  → human-confirmed semantic capability
```

## Build and load

```bash
npm run build:extension
```

Then `chrome://extensions` → Developer mode → Load unpacked → `dist-extension/`.

The Training Studio server must be running for the handoff to land:

```bash
npm run start
```

## Teach flow

1. Open the application you want to teach.
2. Open the extension popup and press **Start training**.
3. Perform the workflow normally.
4. Press **Stop training**.
5. The normalized trace is posted to `POST /api/traces`.
6. In the Training Studio, open **Teach Mode captures**, refresh, select the
   trace, and press **Understand this recording**.
7. Edit and confirm the candidate.

If the Studio is unreachable, the trace is kept in the extension and
**Copy last trace JSON** puts it on the clipboard.

## Architecture

| Piece | File | Role |
| --- | --- | --- |
| Service worker | `extension/src/background.ts` | Session lifecycle, content-script injection, network metadata, handoff |
| Content script | `extension/src/content.ts` | rrweb sensor, page semantics, application-reaction windows |
| Popup | `extension/popup.html`, `extension/src/popup.ts` | Start/stop, status, privacy switch |
| Protocol | `extension/src/protocol.ts` | Message and status types |
| Session | `src/capture/session.ts` | Browser-API-free lifecycle, shared with the Studio |
| Policy | `src/capture/policy.ts` | Masking rules and platform-adapter selection |
| Normalizer | `src/capture/normalize.ts` | `CaptureEvent[]` → `NormalizedObservation[]` |

The session, policy, and normalizer live in `src/capture/` rather than in the
extension because the Training Studio parses the same trace shape and the
privacy rules must be unit testable without a browser.

## Normalized observation

```json
{
  "id": "field_change-mtasyao0-04i6pj",
  "action": "field_change",
  "t": 5913,
  "page": { "host": "127.0.0.1:8787", "path": "/" },
  "field": { "label": "Function", "context": "Northstar Logistics", "control": "select" },
  "oldValue": "All functions",
  "newValue": "Procurement",
  "effects": ["page content updated"],
  "provenance": "OBSERVED",
  "sourceEventIds": ["field_change-mtasyao0-04i6pj", "reaction-mtasyc72-4mqh0p"]
}
```

Actions are `navigate`, `click`, `field_change`, `submit`, `save`, and
`application_reaction`. Effects come from a small closed vocabulary:
`navigation occurred`, `validation message shown`, `new fields became
visible`, `dialog opened`, `confirmation toast shown`, `page content
updated`, `network mutation observed`, `record became persisted`, and `value
masked by capture policy`.

No selector, XPath, coordinate, or key sequence is ever emitted. A trace
cannot be replayed, by construction.

## Capturing application reactions

Each human action opens a ~1.2s window. When it closes, the extension records
what changed: rrweb mutation count, visible content delta, URL change, and
whether validation, dialogs, toasts, or new fields appeared. Several windows
run concurrently, because a human often acts again before the application has
finished responding.

Correlated mutation traffic becomes an effect on the preceding action. A 2xx
mutation following a save-labelled action yields `record became persisted`,
and that observation is marked `INFERRED` rather than `OBSERVED`.

## Privacy

- Capture runs only between an explicit start and stop, on one tab, with a
  `REC` badge. There is no always-on recording.
- rrweb events never leave the page; only their count crosses the boundary.
- Password, email, telephone, and hidden inputs are masked, as are fields
  whose name, id, label, or autocomplete suggests credentials, tokens,
  payment details, or government identifiers. A masked field yields no value
  at all, not a redacted one.
- Ordinary business values are captured, truncated to 64 characters. The
  popup switch turns this off entirely; masking of sensitive controls is not
  affected by it.
- Network observation reads `chrome.webRequest` metadata only: method,
  endpoint pattern, status, duration, and resource type. Headers, cookies,
  and bodies are never available to it. Identifiers are replaced in the
  endpoint pattern and query values are dropped, keeping only parameter
  names.
- Traces live in memory in the service worker and in an in-memory buffer of
  the last 20 traces on the local server. Nothing is written to disk.

## Platform adapters

`detectPlatform` identifies Salesforce Lightning and the controlled Prospect
Intelligence application. The capture path itself is generic; the only
platform-specific code is a handful of Lightning-flavoured selectors used
when resolving labels and reaction markers (`.slds-form-element__label`,
`.slds-card`, `.slds-notify`, `.slds-has-error`). Everything else works on
plain HTML, React, Vue, Angular, and other SPAs.

## Out of scope

Runtime Mode, live execution, replay, selector-script generation, and the
generic MCP bridge are not implemented here.
