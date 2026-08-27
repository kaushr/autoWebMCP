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
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  },
  preview: {
    headers: isolationHeaders
  }
});
