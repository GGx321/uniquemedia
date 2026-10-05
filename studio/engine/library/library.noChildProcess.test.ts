import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 3 whole-slice review L3: the library kept a WebP thumbnail renderer from Stage 1 that no production code calls (the renderer reads photos over
// `studio-media://`, never a thumbnail). It ran ffmpeg with no `-f` input format, no `-protocol_whitelist` and no time bound, on a file the library
// holds: the one unguarded ffmpeg start left in the engine. The library stores and indexes; every ffmpeg start belongs to a guarded importer or render.

const source = readFileSync(new URL("./library.ts", import.meta.url), "utf8");

describe("the library holds no ffmpeg start", () => {
  test("library.ts does not import the ffmpeg runner", () => {
    expect(source).not.toMatch(/runFfmpeg|node\/runFfmpeg/);
  });

  test("library.ts names no encoder and renders no thumbnail", () => {
    expect(source).not.toMatch(/libwebp|renderThumbnail|renderWebpThumbnail/);
  });

  test("the Library class has no thumbnail method for a caller to reach the old renderer by", async () => {
    const { openLibrary } = await import("./library");
    expect(typeof openLibrary).toBe("function");
    const text = source.slice(source.indexOf("export class Library"));
    expect(text).not.toMatch(/^\s+thumbnail\(/m);
  });
});
