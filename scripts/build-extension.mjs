import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "vite";

/**
 * Builds the Manifest V3 extension. Each entry is bundled separately as an
 * IIFE because a content script and a service worker are classic scripts, so
 * neither may be an ES module or use code splitting.
 */

const root = process.cwd();
const outDir = join(root, "dist-extension");

const entries = [
  { entry: "extension/src/background.ts", file: "background.js", name: "AutoWebMcpBackground" },
  { entry: "extension/src/content.ts", file: "content.js", name: "AutoWebMcpContent" },
  { entry: "extension/src/popup.ts", file: "popup.js", name: "AutoWebMcpPopup" },
  { entry: "extension/src/studioBridge.ts", file: "studioBridge.js", name: "AutoWebMcpStudioBridge" }
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const { entry, file, name } of entries) {
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      outDir,
      emptyOutDir: false,
      target: "chrome120",
      minify: false,
      lib: { entry: join(root, entry), name, formats: ["iife"], fileName: () => file }
    }
  });
  console.log(`built ${file}`);
}

for (const asset of ["manifest.json", "popup.html"]) {
  await cp(join(root, "extension", asset), join(outDir, asset));
}

console.log(`\nExtension built in dist-extension/`);
console.log(`Load it with chrome://extensions → Developer mode → Load unpacked → dist-extension`);
