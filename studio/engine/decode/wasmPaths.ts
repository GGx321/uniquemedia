import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CODEC_WASM_SOURCES, type CodecWasmKey } from "./codecSource";

/**
 * Security review H4: onnxruntime-web 1.30's wasm backend passes `wasmPaths.mjs`
 * to a bare `import()` internally, which on Windows rejects a plain OS path
 * (`C:\Users\...\ort-wasm-simd-threaded.mjs` is not a valid module specifier —
 * only a `file://` URL or a relative specifier is). Every WASM-related path this
 * task resolves — onnxruntime-web's own pair AND the two new JPEG/PNG codec
 * `.wasm` files — goes through this one function, so there is exactly one place
 * that ever turns a directory + file name into the string a loader actually
 * receives. `node:fs`'s own read functions accept a `URL` directly
 * (`readFile(new URL(href))`), so `wasmDecode.ts` never needs to convert back to
 * an OS path either — the href is the one representation used end to end.
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

/** The JPEG/PNG codec `.wasm` file's location, as a `file://` URL — `nodeModulesDir` is node_modules' own directory (a sibling of `out-studio/`, same as onnxruntime-web's `dist/`). */
export function codecWasmFileUrl(nodeModulesDir: string, key: CodecWasmKey): string {
  return wasmFileUrl(nodeModulesDir, ...CODEC_WASM_SOURCES[key].path);
}
