import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const root = import.meta.dirname;
const at = (path: string): string => resolve(root, path);

// Studio versions independently of the uniquifier, whose version is the root
// package.json one. studio/version.json is the single source: it is an
// electron-builder config fragment that electron-builder.studio.yml `extends`
// (so the packaged package.json gets it as extraMetadata.version), and it is
// compiled into the main process here as __APP_VERSION__.
function readStudioVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(at("studio/version.json"), "utf8"));
  if (
    typeof parsed === "object" && parsed !== null &&
    "extraMetadata" in parsed && typeof parsed.extraMetadata === "object" && parsed.extraMetadata !== null &&
    "version" in parsed.extraMetadata && typeof parsed.extraMetadata.version === "string"
  ) {
    return parsed.extraMetadata.version;
  }
  throw new Error('studio/version.json must be { "extraMetadata": { "version": "<semver>" } }');
}

// An end-to-end test build (`bun run build:studio:e2e`, STUDIO_E2E=1) keeps
// DevTools and remote debugging in a packaged app and lets the engine take a
// mock OpenRouter base URL (invariant 13). Every other build compiles the
// flag to `false`. Never ship an E2E build.
const STUDIO_E2E = process.env.STUDIO_E2E === "1";

export default defineConfig({
  main: {
    // The engine is a main-process entry too, so it gets both constants.
    define: { __APP_VERSION__: JSON.stringify(readStudioVersion()), __STUDIO_E2E__: JSON.stringify(STUDIO_E2E) },
    build: {
      // Two main-process entries: the main process (out-studio/main/main.js)
      // and the engine utilityProcess (out-studio/engine/main.js, forked by
      // main from inside app.asar). Code both import (zod, the T0 contract)
      // lands in a shared chunk at the out-studio root. The outDir is
      // out-studio itself so the entry names can carry their folders; it is
      // emptied before main is built, and preload and renderer are built after
      // it. Chunk names are left to the preset: a rollupOptions.output
      // override here replaced the preset's `external` list and bundled the
      // `electron` npm stub into main.js (the same trap as the preload note
      // below), and a rolldownOptions one failed the build.
      outDir: at("out-studio"),
      lib: {
        entry: {
          "main/main": at("studio/main/main.ts"),
          "engine/main": at("studio/engine/main.ts"),
        },
      },
      // Never bundled: each locates its binary relative to its own package
      // directory. Externalizing only keeps them out of main.js — a package
      // reaches the installer only as a `dependency` that electron-builder.studio.yml
      // does not exclude (ffprobe-static and exiftool are excluded until Studio
      // uses them), with its binary left outside the asar by asarUnpack.
      externalizeDeps: { include: ["ffmpeg-static", "ffprobe-static", "exiftool-vendored"] },
    },
  },
  preload: {
    build: {
      outDir: at("out-studio/preload"),
      // The window runs sandboxed, and a sandboxed preload must be CommonJS
      // (emitted as preload.cjs, since the root package.json is "type": "module").
      // Set through lib.formats: an output.format override here made the build
      // bundle the `electron` npm stub instead of leaving require("electron").
      lib: { entry: at("studio/preload/preload.ts"), formats: ["cjs"] },
    },
  },
  renderer: {
    root: at("studio/renderer"),
    build: {
      outDir: at("out-studio/renderer"),
      rollupOptions: { input: at("studio/renderer/index.html") },
    },
    plugins: [react()],
  },
});
