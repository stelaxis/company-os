// Builds `app/` into a single self-contained HTML file at `src/generated/app.txt`, which
// `book.ts` imports as a string and serves from `startAppUi()`.
//
// Single-file is not a preference but a requirement: the Workshop hosts the app in a
// `sandbox="allow-scripts"` opaque-origin iframe and gives it nothing but the HTML string, so
// there is no origin to fetch a second asset from. Everything -- script, styles, capnweb -- has to
// be inlined.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const pkgDir = dirname(fileURLToPath(import.meta.url));

/**
 * Copy the inlined build to `src/generated/app.txt`.
 *
 * Identical rewrites are skipped: the file is an input to wrangler's watcher, and rewriting the
 * same bytes restarts the dev server in a loop.
 */
function emitAppText(): Plugin {
  return {
    name: "emit-book-app-text",
    closeBundle() {
      const html = readFileSync(resolve(pkgDir, "dist-app", "index.html"), "utf8");
      const outDir = resolve(pkgDir, "src", "generated");
      const outFile = resolve(outDir, "app.txt");
      mkdirSync(outDir, { recursive: true });
      if (existsSync(outFile) && readFileSync(outFile, "utf8") === html) {
        console.log(`app.txt unchanged (${Math.round(html.length / 1024)} KiB), skipping write`);
        return;
      }
      writeFileSync(outFile, html);
      console.log(`app.txt written (${Math.round(html.length / 1024)} KiB)`);
    },
  };
}

export default defineConfig({
  root: resolve(pkgDir, "app"),
  plugins: [viteSingleFile(), emitAppText()],
  build: {
    outDir: resolve(pkgDir, "dist-app"),
    emptyOutDir: true,
    // One chunk, no code-splitting: viteSingleFile can only inline what lands in index.html.
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
