import { describe, expect, test } from "bun:test";
import type { Layer } from "../engine/montage";
import { STICKER_MANIFEST } from "./manifest";
import { stickerIssues } from "./stickerIssues";

// The referential half for a montage's built-in stickers (3b.6): the set is in the build, so no library is needed. One function
// for the engine (`videos.render`, `montages.get`) and the mock, so both answer alike.

const sticker = (n: number, source: Extract<Layer, { kind: "sticker" }>["sticker"]): Layer => ({ layerId: `layer-${String(n).padStart(3, "0")}`, kind: "sticker", startMs: 0, endMs: 1_000, sticker: source, x: 0.5, y: 0.5, size: 0.2 });
const text: Layer = { layerId: "layer-900", kind: "text", startMs: 0, endMs: 1_000, value: "hi", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.5, scale: 1 };

describe("stickerIssues", () => {
  test("a spec with no layers has none", () => {
    expect(stickerIssues({ layers: [] })).toEqual([]);
  });

  test.each(STICKER_MANIFEST.map((s) => [s.id] as const))("the built-in sticker %s is available", (stickerId) => {
    expect(stickerIssues({ layers: [sticker(1, { source: "builtin", stickerId })] })).toEqual([]);
  });

  test("a built-in sticker the set does not have is sticker-unavailable at its layer's sticker", () => {
    expect(stickerIssues({ layers: [text, sticker(1, { source: "builtin", stickerId: "no-such-sticker" })] })).toEqual([{ code: "sticker-unavailable", path: ["layers", 1, "sticker"] }]);
  });

  test("every missing sticker is reported, in layer order", () => {
    const layers = [sticker(1, { source: "builtin", stickerId: "gone-one-aaa" }), sticker(2, { source: "builtin", stickerId: "heart-pulse" }), sticker(3, { source: "builtin", stickerId: "gone-two-bbb" })];
    expect(stickerIssues({ layers })).toEqual([
      { code: "sticker-unavailable", path: ["layers", 0, "sticker"] },
      { code: "sticker-unavailable", path: ["layers", 2, "sticker"] },
    ]);
  });

  test("an own sticker is not judged here: the library holds it, and `ownStickerIssues` asks (3f.5)", () => {
    expect(stickerIssues({ layers: [sticker(1, { source: "own", mediaId: "media-0000001" })] })).toEqual([]);
  });

  test("a name that is an inherited property of an object is not a sticker", () => {
    expect(stickerIssues({ layers: [sticker(1, { source: "builtin", stickerId: "constructor" })] })).toEqual([{ code: "sticker-unavailable", path: ["layers", 0, "sticker"] }]);
  });
});
