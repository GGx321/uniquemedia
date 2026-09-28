import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Security review H4: onnxruntime-web 1.30's wasm backend passes `wasmPaths.mjs`
 * to a bare `import()` internally, which on Windows rejects a plain OS path
 * (`C:\Users\...\ort-wasm-simd-threaded.mjs` is not a valid module specifier —
 * only a `file://` URL or a relative specifier is). `ortWasmPathsFrom` below
 * is the one place that turns onnxruntime-web's own directory + file names
 * into the strings its loader actually receives.
 *
 * Re-review N8: this file used to also offer `codecWasmFileUrl` for the two
 * JPEG/PNG codec `.wasm` files, on the theory that every WASM-related path
 * should go through one function — but `realBackend.ts` reads those with a
 * plain `node:fs/promises` `readFile(path)` (never handed to `import()`, so
 * H4's own Windows failure mode does not apply there), and never actually
 * called it. Removed rather than left as unused, never-exercised code; the
 * plan's own claim that the codecs load by URL was corrected to match.
 */
export function wasmFileUrl(dir: string, ...segments: readonly string[]): string {
  return pathToFileURL(join(dir, ...segments)).href;
}

export interface OrtWasmPaths {
  wasm: string;
  mjs: string;
}

/** onnxruntime-web's own `env.wasm.wasmPaths`, as `file://` URLs (H4). */
export function ortWasmPathsFrom(ortDistDir: string): OrtWasmPaths {
  return {
    wasm: wasmFileUrl(ortDistDir, "ort-wasm-simd-threaded.wasm"),
    mjs: wasmFileUrl(ortDistDir, "ort-wasm-simd-threaded.mjs"),
  };
}
