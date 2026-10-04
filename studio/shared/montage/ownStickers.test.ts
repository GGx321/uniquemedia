import { describe, expect, test } from "bun:test";
import type { Layer } from "../engine/montage";
import { ownStickerCells, ownStickerIssues } from "./ownStickers";

// An own sticker in a layer (3f.5): where they are in a spec, and the ONE function that says which of them are not available, used by the engine
// (`videos.render`, `montages.get`) and by the renderer's mock so that they cannot say it differently.

type Source = Extract<Layer, { kind: "sticker" }>["sticker"];
const sticker = (n: number, source: Source): Layer => ({ layerId: `layer-${String(n).padStart(3, "0")}`, kind: "sticker", startMs: 0, endMs: 1_000, sticker: source, x: 0.5, y: 0.5, size: 0.2 });
const text: Layer = { layerId: "layer-900", kind: "text", startMs: 0, endMs: 1_000, value: "hi", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.5, scale: 1 };
const own = (n: number): Source => ({ source: "own", mediaId: `media-${n}` });
const builtin: Source = { source: "builtin", stickerId: "heart-pulse" };

describe("ownStickerCells", () => {
  test("lists the own stickers of the layers, in layer order, with their paths", () => {
    const layers = [sticker(1, own(1)), text, sticker(2, builtin), sticker(3, own(3))];
    expect(ownStickerCells({ layers })).toEqual([
      { mediaId: "media-1", path: ["layers", 0, "sticker"] },
      { mediaId: "media-3", path: ["layers", 3, "sticker"] },
    ]);
  });

  test("lists nothing for built-in stickers and text layers", () => {
    expect(ownStickerCells({ layers: [text, sticker(1, builtin)] })).toEqual([]);
  });

  test("lists the same media twice when two layers use it", () => {
    expect(ownStickerCells({ layers: [sticker(1, own(1)), sticker(2, own(1))] }).map((c) => c.mediaId)).toEqual(["media-1", "media-1"]);
  });

  test("lists nothing for no layers", () => {
    expect(ownStickerCells({ layers: [] })).toEqual([]);
  });
});

describe("ownStickerIssues", () => {
  const spec = { layers: [sticker(1, own(1)), text, sticker(2, own(2)), sticker(3, builtin)] };

  test("is nothing when every own sticker is available", () => {
    expect(ownStickerIssues(spec, () => true)).toEqual([]);
  });

  test("is media-unavailable at the sticker of each layer whose media is not", () => {
    expect(ownStickerIssues(spec, (mediaId) => mediaId === "media-2")).toEqual([{ code: "media-unavailable", path: ["layers", 0, "sticker"] }]);
  });

  test("is one issue per layer: two layers that use a missing media are both marked", () => {
    expect(ownStickerIssues({ layers: [sticker(1, own(1)), sticker(2, own(1))] }, () => false)).toEqual([
      { code: "media-unavailable", path: ["layers", 0, "sticker"] },
      { code: "media-unavailable", path: ["layers", 1, "sticker"] },
    ]);
  });

  test("never judges a built-in sticker or a text layer", () => {
    expect(ownStickerIssues({ layers: [text, sticker(1, builtin)] }, () => false)).toEqual([]);
  });
});
