import { describe, expect, test } from "bun:test";
import { createRealDecodeBackend, looksLikeFatalWasmFailure } from "./realBackend";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Re-review N6: the fatal-wasm-failure detector's own regex used `\babort\b`,
// which never matches emscripten's real message ("Aborted(OOM)") — there is
// no word boundary between "abort" and the "ed" that follows it in
// "Aborted". Re-review N7: createRealDecodeBackend() now decodes a tiny
// embedded JPEG and PNG once at load, so a broken codec fails there rather
// than mid-run — every other test in this file (and wasmDecode.test.ts,
// parity.test.ts, …) already proves the happy path still works.

describe("looksLikeFatalWasmFailure (N6)", () => {
  test("matches a real WebAssembly.RuntimeError", () => {
    expect(looksLikeFatalWasmFailure(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
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
    const backend = await createRealDecodeBackend(`${import.meta.dirname}/../../../node_modules`);
    expect(typeof backend.decodeJpeg).toBe("function");
    expect(typeof backend.decodePng).toBe("function");
  });
});
