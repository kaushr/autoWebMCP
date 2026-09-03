import { defineConfig } from "vite";

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
      "/api": "http://127.0.0.1:8787"
    }
  },
  preview: {
    headers: isolationHeaders
  }
});
