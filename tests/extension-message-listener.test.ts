import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROL_PLANE_ORIGIN,
  isValidControlPlaneOrigin,
  replaceMessageListener,
  type MessageListenerHost
} from "../extension/src/protocol";

/* ------------------------------------------------------------------ *
 * One live listener per document.
 *
 * Both failures below happened for real against a live org, in sequence,
 * and they pull in opposite directions — which is why the rule is
 * "replace", not "add" and not "add once".
 * ------------------------------------------------------------------ */

type Listener = () => void;

/** A stand-in for `chrome.runtime.onMessage` that records what is live. */
function host(): MessageListenerHost<Listener> & { live: Listener[] } {
  const live: Listener[] = [];
  return {
    live,
    addListener(listener) {
      live.push(listener);
    },
    removeListener(listener) {
      const index = live.indexOf(listener);
      if (index >= 0) live.splice(index, 1);
    }
  };
}

/**
 * A context whose extension was reloaded: its listener is dead, and
 * Chrome throws rather than removing it. The page's isolated world still
 * holds the reference.
 */
function invalidatedHost(): MessageListenerHost<Listener> & { live: Listener[] } {
  const real = host();
  return {
    live: real.live,
    addListener: (listener) => real.addListener(listener),
    removeListener: () => {
      throw new Error("Extension context invalidated.");
    }
  };
}

describe("replaceMessageListener", () => {
  it("installs a listener when the document has none", () => {
    const channel = host();
    const listener: Listener = () => undefined;

    expect(replaceMessageListener(channel, undefined, listener)).toBe(listener);
    expect(channel.live).toEqual([listener]);
  });

  it("leaves exactly one listener after repeated injection", () => {
    // The first failure: the service worker injects before every operation,
    // and N listeners meant one message ran N concurrent inspections
    // against the same live record.
    const channel = host();
    let installed: Listener | undefined;

    for (let injection = 0; injection < 5; injection++) {
      const listener: Listener = () => undefined;
      installed = replaceMessageListener(channel, installed, listener);
    }

    expect(channel.live).toHaveLength(1);
    expect(channel.live[0]).toBe(installed);
  });

  it("still installs a working listener when the previous one cannot be removed", () => {
    // The second failure, and the one a boolean guard caused: after an
    // extension reload the old listener is dead but its reference survives
    // on the page. Skipping installation left the document with NO live
    // listener, and starting a recording silently did nothing.
    const channel = invalidatedHost();
    const dead: Listener = () => undefined;
    const fresh: Listener = () => undefined;

    expect(replaceMessageListener(channel, dead, fresh)).toBe(fresh);
    expect(channel.live).toEqual([fresh]);
  });

  it("never leaves a document with no listener, whatever the previous state", () => {
    // The invariant that matters: after this call the document can always
    // receive a message. Both failure modes above violated it in opposite
    // directions.
    for (const channel of [host(), invalidatedHost()]) {
      for (const previous of [undefined, (() => undefined) as Listener]) {
        const listener: Listener = () => undefined;
        replaceMessageListener(channel, previous, listener);
        expect(channel.live).toContain(listener);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Where a recording is sent.
 *
 * This setting was readable from the first commit and writable by nothing
 * at all — no popup field, no options page, no message handler. It looked
 * configurable while being effectively hardcoded, so a control plane on a
 * different port meant a failed handoff and a copy-and-curl recovery.
 *
 * Now that it can be set, what may be set matters: this value decides
 * where a recording of the user's own application is POSTed.
 * ------------------------------------------------------------------ */

describe("isValidControlPlaneOrigin", () => {
  it("accepts a bare http or https origin", () => {
    expect(isValidControlPlaneOrigin("http://127.0.0.1:8787")).toBe(true);
    expect(isValidControlPlaneOrigin("http://localhost:9000")).toBe(true);
    expect(isValidControlPlaneOrigin("https://studio.example.com")).toBe(true);
  });

  it("rejects anything carrying more than an origin", () => {
    // A path, query, or fragment means the caller has something other than
    // an origin in mind, and `${origin}/api/traces` would mangle it.
    expect(isValidControlPlaneOrigin("http://127.0.0.1:8787/api")).toBe(false);
    expect(isValidControlPlaneOrigin("http://127.0.0.1:8787/?x=1")).toBe(false);
    expect(isValidControlPlaneOrigin("http://127.0.0.1:8787/#x")).toBe(false);
  });

  it("rejects a scheme that is not http or https", () => {
    // Nothing should be able to point a recording at a script URL or a
    // local file by typing it into a text box.
    expect(isValidControlPlaneOrigin("javascript:alert(1)")).toBe(false);
    expect(isValidControlPlaneOrigin("file:///etc/passwd")).toBe(false);
    expect(isValidControlPlaneOrigin("chrome-extension://abc")).toBe(false);
  });

  it("rejects what is not a URL at all", () => {
    expect(isValidControlPlaneOrigin("127.0.0.1:8787")).toBe(false);
    expect(isValidControlPlaneOrigin("")).toBe(false);
    expect(isValidControlPlaneOrigin("   ")).toBe(false);
  });

  it("keeps the default pointing at the control plane, not the Studio UI", () => {
    // The Studio page runs on Vite and proxies /api here. Conflating the
    // two is what made a failed handoff report "Training Studio
    // unreachable at …:8787" — naming one thing and showing another's port.
    expect(DEFAULT_CONTROL_PLANE_ORIGIN).toBe("http://127.0.0.1:8787");
    expect(isValidControlPlaneOrigin(DEFAULT_CONTROL_PLANE_ORIGIN)).toBe(true);
  });
});
