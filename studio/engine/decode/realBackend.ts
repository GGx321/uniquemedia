import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyModelBytes } from "../face/modelSource";
import { CODEC_WASM_SOURCES, type CodecWasmKey } from "./codecSource";
import type { DecodeBackend, RawDecoded } from "./wasmDecode";

/**
 * N7: real, minimal 2x2 images (the bundled ffmpeg's own encoders, verified
 * to round-trip through both real decoders before being pasted in here —
 * never hand-typed base64) — decoded once at load so a broken codec fails
 * there, not mid-run.
 */
const SMOKE_TEST_JPEG = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYwLjMuMTAwAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsAUX9//9k=",
    "base64",
  ),
);
const SMOKE_TEST_PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==", "base64"),
);

/**
 * A wasm-module failure that leaves the instance's own linear memory in a
 * bad state (an emscripten `abort()`, an out-of-bounds/OOM trap) — best
 * effort, from the error message emscripten/wasm-bindgen actually throw;
 * an ordinary "this file is corrupt" decode error does not match. Task A.4:
 * "recreate the WASM module after an abort/OOM failure."
 */
export function looksLikeFatalWasmFailure(error: unknown): boolean {
  // N6: a real `WebAssembly.RuntimeError` (an actual wasm trap — unreachable,
  // an out-of-bounds access) is the precise, structural signal. The message
  // regex is the fallback for emscripten's own `abort()`, which throws a
  // plain JS value, not a RuntimeError — its real message is "Aborted(OOM)"
  // or similar, which `\babort\b` never matched (no word boundary between
  // "abort" and the "ed" in "Aborted") — `\babort(?:ed)?\b` matches both forms.
  if (error instanceof WebAssembly.RuntimeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\babort(?:ed)?\b|out of bounds|out of memory|unreachable/i.test(message);
}

async function loadVerifiedModule(nodeModulesDir: string, key: CodecWasmKey): Promise<WebAssembly.Module> {
  const source = CODEC_WASM_SOURCES[key];
  const path = join(nodeModulesDir, ...source.path);
  const bytes = await readFile(path);
  verifyModelBytes(bytes, source.sha256, source.path.join("/"));
  return WebAssembly.compile(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * The real `DecodeBackend`: `@jsquash/jpeg`/`@jsquash/png`, each `init()`-ed
 * once with an already-compiled, sha256-verified `WebAssembly.Module` — never
 * `fetch`, never a bare path handed to the library's own loader (which would
 * try to `fetch()` a URL or read a Node path itself; passing a precompiled
 * `WebAssembly.Module` bypasses that entirely, confirmed against both
 * packages' own `init()` implementations).
 *
 * JPEG: `@jsquash/jpeg`'s `init()` may be called again to get a fresh
 * emscripten instance from the same precompiled module, so a decode that
 * looks like a fatal wasm failure (`looksLikeFatalWasmFailure`) triggers a
 * re-`init()` before the error is rethrown — the NEXT decode call gets a
 * fresh instance rather than reusing one whose linear memory may be corrupt.
 *
 * PNG: `@jsquash/png`'s own `init()` is idempotent by design (a module-level
 * `pngModule` guarded by `if (!pngModule)`) — the wasm-bindgen wrapper gives
 * no public way to force a fresh instance short of re-importing the module
 * under a new specifier (defeating ESM's module cache is not attempted
 * here). This is a real, acknowledged gap versus the JPEG path, not silently
 * assumed away: documented in the T7b plan notes. It does not weaken the
 * money-safety guarantee wasmDecode.ts provides — ANY decode failure already
 * stops the run (systemic, never retried) rather than looping, whether or
 * not the next attempt would have succeeded with a fresh instance.
 */
export async function createRealDecodeBackend(nodeModulesDir: string): Promise<DecodeBackend> {
  const [jpegModule, pngModule] = await Promise.all([loadVerifiedModule(nodeModulesDir, "jpeg"), loadVerifiedModule(nodeModulesDir, "png")]);

  // The explicit ".js" is load-bearing, not stylistic: @jsquash/jpeg and
  // @jsquash/png have no package.json "exports" map, so a bare, extension-
  // less subpath import (`@jsquash/jpeg/decode`) only resolves under bun's
  // own lenient resolver — under real Node (the packaged app's Electron
  // runtime, `out-studio/engine/main.js`), ESM `import()` never auto-appends
  // an extension the way CommonJS `require()` does, and this failed loudly
  // in exactly that environment (the E2E smoke's packaged/unpackaged build)
  // with "Cannot find module ... Did you mean to import .../decode.js?".
  const jpegDecoder = (await import("@jsquash/jpeg/decode.js")) as {
    default: (buffer: ArrayBuffer, options?: Record<string, unknown>) => Promise<RawDecoded>;
    init: (module?: WebAssembly.Module) => Promise<void>;
  };
  const pngDecoder = (await import("@jsquash/png/decode.js")) as {
    default: (buffer: ArrayBuffer, options?: Record<string, unknown>) => Promise<RawDecoded>;
    init: (module?: WebAssembly.Module) => Promise<unknown>;
  };

  await jpegDecoder.init(jpegModule);
  await pngDecoder.init(pngModule);

  // N7: `init()`'s own `await` only awaits building the emscripten/wasm-
  // bindgen module wrapper — it does not itself decode anything, so a
  // codec that is present but broken (compiled without a needed feature, a
  // mismatched build, a WASM validation error only a real instantiate-and-
  // run would trip) would not surface until the first real candidate
  // image, mid-run, after money was already spent generating it. Decoding
  // one tiny embedded JPEG and PNG here instead makes a broken codec fail
  // at load — main.ts's own loadFaceGate() already treats that as
  // FACE_GATE_UNAVAILABLE before any run can start.
  await Promise.all([jpegDecoder.default(toArrayBuffer(SMOKE_TEST_JPEG)), pngDecoder.default(toArrayBuffer(SMOKE_TEST_PNG))]);

  return {
    async decodeJpeg(bytes) {
      try {
        return await jpegDecoder.default(toArrayBuffer(bytes));
      } catch (error) {
        if (looksLikeFatalWasmFailure(error)) await jpegDecoder.init(jpegModule);
        throw error;
      }
    },
    async decodePng(bytes) {
      return await pngDecoder.default(toArrayBuffer(bytes));
    },
  };
}
