import { defineConfig } from "vite";

/**
 * Where the control plane lives. Override with AUTOWEBMCP_CONTROL_PLANE to
 * run it on another port; the extension has its own setting for the same
 * thing, under Advanced / Debug in the popup, because it talks to the
 * control plane directly rather than through this proxy.
 */
const DEFAULT_CONTROL_PLANE = "http://127.0.0.1:8787";

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Permissions-Policy": "webmcp=(self)"
};

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        // The Training Studio and the SignalBase prospect application are two
        // separate documents on purpose: the extension trains on the second.
        studio: "index.html",
        prospect: "prospect/index.html"
      }
    }
  },
  server: {
    headers: isolationHeaders,
    port: 5173,
    // Fail rather than drift. The extension's content-script `matches` in
    // extension/manifest.json name 127.0.0.1:5173 literally, so a Studio
    // served from any other port loses the bridge entirely — the page
    // loads, looks correct, and silently cannot reach the extension.
    // A refusal to start is far easier to diagnose than that.
    strictPort: true,
    proxy: {
      // The Studio's API calls follow the control plane wherever it is.
      // Hardcoding this meant a control plane on another port left the
      // Studio silently broken even once the extension had been pointed at
      // it — two halves of one setting, only one of which could be moved.
      "/api": process.env.AUTOWEBMCP_CONTROL_PLANE ?? DEFAULT_CONTROL_PLANE
    }
  },
  preview: {
    headers: isolationHeaders
  }
});
