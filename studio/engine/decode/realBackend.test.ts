import { describe, expect, test } from "bun:test";
import { createRealDecodeBackend, looksLikeFatalWasmFailure, SMOKE_TEST_JPEG, SMOKE_TEST_PNG } from "./realBackend";
import { createWasmImageDecoder } from "./wasmDecode";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const NODE_MODULES_DIR = `${import.meta.dirname}/../../../node_modules`;

/** A real, minimal 2x2 baseline JPEG (the bundled ffmpeg's own encoder) — verified to decode before being pasted in here. */
const REAL_JPEG_2X2 = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYwLjMuMTAwAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsAUX9//9k=",
    "base64",
  ),
);
/** A real, minimal 2x2 WebP — never accepted by the engine's own decoder (JPEG/PNG only). */
const REAL_WEBP_2X2 = Uint8Array.from(Buffer.from("UklGRj4AAABXRUJQVlA4IDIAAADwAQCdASoCAAIAAMASJaACdLoB+AAETAAA/v5mof/60c/XRP9aOf+tHP/lKotU24oAAA==", "base64"));

// Re-review N6: the fatal-wasm-failure detector's own regex used `\babort\b`,
// which never matches emscripten's real message ("Aborted(OOM)") — there is
// no word boundary between "abort" and the "ed" that follows it in
// "Aborted". Re-review N7: createRealDecodeBackend() now decodes a tiny
// embedded JPEG and PNG once at load, so a broken codec fails there rather
// than mid-run — every other test in this file (and wasmDecode.test.ts,
// parity.test.ts, …) already proves the happy path still works.

describe("looksLikeFatalWasmFailure (N6)", () => {
  test("matches a real WebAssembly.RuntimeError", () => {
    // Round 3, small item e: the message itself ("unreachable" would also
    // match the fallback regex below, `/.../i` includes "unreachable") must
    // NOT be one the regex matches, or this test would still pass with the
    // `instanceof WebAssembly.RuntimeError` branch deleted — proving
    // nothing about that branch specifically.
    expect(looksLikeFatalWasmFailure(new WebAssembly.RuntimeError("integer divide by zero"))).toBe(true);
  });

  test("matches emscripten's own \"Aborted(...)\" message — the word-boundary bug this fixes", () => {
    expect(looksLikeFatalWasmFailure(new Error("Aborted(OOM)"))).toBe(true);
    expect(looksLikeFatalWasmFailure(new Error("Aborted(native code called abort())"))).toBe(true);
  });

  test("still matches the plain word \"abort\" on its own", () => {
    expect(looksLikeFatalWasmFailure(new Error("wasm trap: abort"))).toBe(true);
  });

  test("matches out-of-bounds / out-of-memory / unreachable phrasing", () => {
    expect(looksLikeFatalWasmFailure(new Error("memory access out of bounds"))).toBe(true);
    expect(looksLikeFatalWasmFailure(new Error("out of memory"))).toBe(true);
    expect(looksLikeFatalWasmFailure(new Error("unreachable executed"))).toBe(true);
  });

  test("does not match an ordinary corrupt-input decode error", () => {
    expect(looksLikeFatalWasmFailure(new Error("Corrupt JPEG data: premature end of data segment"))).toBe(false);
  });

  test("does not match an unrelated error", () => {
    expect(looksLikeFatalWasmFailure(new Error("ENOENT: no such file or directory"))).toBe(false);
  });

  test("stringifies a non-Error thrown value", () => {
    expect(looksLikeFatalWasmFailure("Aborted(OOM)")).toBe(true);
    expect(looksLikeFatalWasmFailure("not fatal")).toBe(false);
  });
});

describe("createRealDecodeBackend (N7: a smoke decode at load)", () => {
  test("resolves once the smoke JPEG and PNG both decode cleanly", async () => {
    const backend = await createRealDecodeBackend(NODE_MODULES_DIR);
    expect(typeof backend.decodeJpeg).toBe("function");
    expect(typeof backend.decodePng).toBe("function");
  });

  // Round 3, small item f: the load-time smoke decode's own result was never
  // checked — createRealDecodeBackend() discards it (`await Promise.all([...])`
  // with no assertion), so a mutation that fed it the wrong bytes, or a
  // decoder that silently returned the wrong geometry, would not be caught
  // here. Decoding the SAME embedded smoke bytes directly through the real
  // backend and pinning their size closes that gap.
  test("N7: the embedded smoke JPEG and PNG are both genuinely 2x2 (the size the module comment claims)", async () => {
    const backend = await createRealDecodeBackend(NODE_MODULES_DIR);
    const jpeg = await backend.decodeJpeg(SMOKE_TEST_JPEG);
    const png = await backend.decodePng(SMOKE_TEST_PNG);
    expect({ width: jpeg.width, height: jpeg.height }).toEqual({ width: 2, height: 2 });
    expect({ width: png.width, height: png.height }).toEqual({ width: 2, height: 2 });
    expect(jpeg.data.length).toBe(2 * 2 * 4);
    expect(png.data.length).toBe(2 * 2 * 4);
  });
});

// N9: the real backend + the real allow-list/pixel-cap wrapper, on unusual
// input — never the fake backend wasmDecode.test.ts otherwise uses.
describe("createWasmImageDecoder + the real backend, on unusual input (N9)", () => {
  test("a corrupt JPEG (valid magic bytes, garbage payload) rejects instead of hanging or crashing", async () => {
    const backend = await createRealDecodeBackend(NODE_MODULES_DIR);
    const decode = createWasmImageDecoder(backend);
    const corrupt = Uint8Array.from(REAL_JPEG_2X2);
    // Scramble everything past the JPEG magic bytes and the SOF0 header this
    // decoder's own pixel-cap check needs to read — the scan data itself.
    for (let i = 40; i < corrupt.length; i++) corrupt[i] = (corrupt[i]! * 37 + 11) & 0xff;

    await expect(decode(corrupt, new AbortController().signal)).rejects.toThrow();
  });

  test("truncated JPEG bytes (a bomb/DoS-style partial payload) reject cleanly", async () => {
    const backend = await createRealDecodeBackend(NODE_MODULES_DIR);
    const decode = createWasmImageDecoder(backend);
    const truncated = REAL_JPEG_2X2.slice(0, Math.floor(REAL_JPEG_2X2.length / 2));

    await expect(decode(truncated, new AbortController().signal)).rejects.toThrow();
  });

  test("a real WebP is rejected by the allow-list before ever reaching the real backend", async () => {
    const backend = await createRealDecodeBackend(NODE_MODULES_DIR);
    const decode = createWasmImageDecoder(backend);

    await expect(decode(REAL_WEBP_2X2, new AbortController().signal)).rejects.toThrow(/unsupported/i);
  });

  test("a real JPEG whose header is patched to claim a pixel count over the cap is refused before the real codec ever runs", async () => {
    const backend = await createRealDecodeBackend(NODE_MODULES_DIR);
    const decode = createWasmImageDecoder(backend);
    const bomb = Uint8Array.from(REAL_JPEG_2X2);
    let sofAt = -1;
    for (let i = 0; i < bomb.length - 1; i++) {
      if (bomb[i] === 0xff && bomb[i + 1] === 0xc0) {
        sofAt = i;
        break;
      }
    }
    if (sofAt < 0) throw new Error("unreachable: REAL_JPEG_2X2 always has an SOF0 marker");
    // Claim 5000x5000 (25M px, over the 16.7M cap) without touching the scan
    // data at all — if the cap check ever decoded first, this would either
    // hang (the real codec trying to make sense of a 2x2 image's worth of
    // scan data as if it were 5000x5000) or crash; it must reject at once.
    bomb[sofAt + 5] = (5000 >> 8) & 0xff;
    bomb[sofAt + 6] = 5000 & 0xff;
    bomb[sofAt + 7] = (5000 >> 8) & 0xff;
    bomb[sofAt + 8] = 5000 & 0xff;

    await expect(decode(bomb, new AbortController().signal)).rejects.toThrow(/16777216|16,777,216/);
  });
});
