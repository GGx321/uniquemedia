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

  test("joins multiple segments the same way node:path's join does", () => {
    const href = wasmFileUrl("/root", "pkg", "dist", "file.wasm");
    expect(href).toBe(`file://${join("/root", "pkg", "dist", "file.wasm")}`);
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
