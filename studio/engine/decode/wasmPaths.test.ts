import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ortWasmPathsFrom, wasmFileUrl } from "./wasmPaths";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Security review H4: onnxruntime-web 1.30 passes `wasmPaths.mjs` to a bare
// `import()`, which rejects a plain Windows OS path (`C:\...`) — only a
// `file://` URL survives. Every WASM path this task resolves must be one,
// pinned here so a future edit that reverts to `join(...)` alone fails loudly.

describe("wasmFileUrl", () => {
  test("returns a file:// URL, never a plain OS path", () => {
    const href = wasmFileUrl("/some/dir", "a.wasm");
    expect(href).toStartWith("file://");
    expect(href.endsWith("a.wasm")).toBe(true);
    expect(href).not.toBe(join("/some/dir", "a.wasm"));
  });

  // Exact URLs, one per platform: pasting "file://" in front of `join(...)`
  // is precisely what this module exists to avoid, and on Windows it yields
  // backslashes. The Windows case is the one H4 is about (a drive-letter
  // path handed to `import()`), so it is pinned on the runner that has it.
  test.skipIf(process.platform === "win32")("joins multiple segments into one file:// URL (POSIX)", () => {
    expect(wasmFileUrl("/root", "pkg", "dist", "file.wasm")).toBe("file:///root/pkg/dist/file.wasm");
  });

  test.if(process.platform === "win32")("joins multiple segments into one file:/// URL with the drive letter (Windows)", () => {
    expect(wasmFileUrl("C:\\root", "pkg", "dist", "file.wasm")).toBe("file:///C:/root/pkg/dist/file.wasm");
  });

  test("percent-encodes characters a bare path would not (spaces), proving it is a real URL, not a string with a prefix pasted on", () => {
    const href = wasmFileUrl("/a dir with spaces", "b.wasm");
    expect(href).toContain("%20");
    expect(href).not.toContain(" ");
  });
});

describe("ortWasmPathsFrom", () => {
  test("both wasm and mjs are file:// URLs pointing at onnxruntime-web's own file names", () => {
    const paths = ortWasmPathsFrom("/root/node_modules/onnxruntime-web/dist");
    expect(paths.wasm).toStartWith("file://");
    expect(paths.wasm.endsWith("ort-wasm-simd-threaded.wasm")).toBe(true);
    expect(paths.mjs).toStartWith("file://");
    expect(paths.mjs.endsWith("ort-wasm-simd-threaded.mjs")).toBe(true);
  });
});
