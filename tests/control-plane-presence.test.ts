import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_CONTROL_PLANE_PROTOCOL, controlPlaneIsCurrent } from "../src/training/traces";

/* ------------------------------------------------------------------ *
 * "No control plane" and "an old control plane" are different answers.
 *
 * A hosted copy of the Studio is static files with nothing behind /api,
 * so every call 404s. Reported as staleness it produced a confidently
 * wrong banner on the public deployment: restart a process the reader
 * never started, and lose traces they never had. The status code is the
 * only thing separating the two, so it is asserted here.
 * ------------------------------------------------------------------ */

function respondWith(init: { status: number; body?: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: init.status >= 200 && init.status < 300,
      status: init.status,
      json: async () => init.body ?? {}
    }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("controlPlaneIsCurrent", () => {
  it("reports a 404 as nothing answering, never as older code", async () => {
    respondWith({ status: 404 });
    const state = await controlPlaneIsCurrent();

    expect(state.ok).toBe(false);
    if (state.ok) return;
    expect(state.detail).toMatch(/No control plane is answering/);
    // The two claims that were wrong on the deployment.
    expect(state.detail).not.toMatch(/older code/);
    expect(state.detail).not.toMatch(/will be cleared/);
  });

  it("still reports a reachable but outdated control plane as stale", async () => {
    respondWith({ status: 200, body: { controlPlaneProtocol: REQUIRED_CONTROL_PLANE_PROTOCOL - 1 } });
    const state = await controlPlaneIsCurrent();

    expect(state.ok).toBe(false);
    if (state.ok) return;
    expect(state.detail).toMatch(/older code/);
  });

  it("accepts a control plane at or above the required protocol", async () => {
    respondWith({ status: 200, body: { controlPlaneProtocol: REQUIRED_CONTROL_PLANE_PROTOCOL } });
    expect(await controlPlaneIsCurrent()).toEqual({ ok: true });
  });

  it("leaves an unreachable origin to the connection reporting elsewhere", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    expect(await controlPlaneIsCurrent()).toEqual({ ok: true });
  });

  it("treats a non-404 server error as staleness rather than absence", async () => {
    respondWith({ status: 500 });
    const state = await controlPlaneIsCurrent();

    expect(state.ok).toBe(false);
    if (state.ok) return;
    expect(state.detail).toMatch(/older code/);
  });
});
