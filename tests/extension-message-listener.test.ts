import { describe, expect, it } from "vitest";
import { replaceMessageListener, type MessageListenerHost } from "../extension/src/protocol";

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
