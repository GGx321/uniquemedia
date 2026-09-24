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

export default defineConfig({
  main: {
    define: { __APP_VERSION__: JSON.stringify(readStudioVersion()) },
    build: {
      outDir: at("out-studio/main"),
      lib: { entry: at("studio/main/main.ts") },
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
