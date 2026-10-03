import { describe, expect, test } from "bun:test";
import { MontageDraft, StickerLayer as StickerLayerSchema } from "../../../shared/engine";
import { reelsSafeZones, stickerBox, zonesHit } from "../../../shared/montage";
import { STICKER_MANIFEST } from "../../../shared/stickers/manifest";
import { MAX_STICKER_SIZE, MIN_STICKER_SIZE, moveInside, replaceSticker, setStickerSize, type StickerLayer, stickerPercent, stickerUses, stickerZones } from "./stickerOps";
import { draftSpec, stickerLayer, textLayer } from "./testkit";

// 3d.5: a sticker layer's properties (EditorGif.dc.html, R35–R41; the «GIF» tab's G4) as pure edits over a draft. The size is the
// contract's fraction of the frame width (CF12: 5–60 %, not the artboard's 5–50); a replacement keeps the layer's time and place;
// «Сдвинуть внутрь» moves a sticker out of the Reels zones (`reelsSafeZones`, AM10) by the shortest way that clears every zone.

const HEART = STICKER_MANIFEST[0]?.id ?? "";
const SPARKLE = STICKER_MANIFEST[1]?.id ?? "";

/** A built-in sticker at (x, y) of `size`, at layer 1 after a text. */
function withSticker(patch: Partial<StickerLayer> = {}): MontageDraft {
  const sticker: StickerLayer = { ...stickerLayer(1, 0, 2_000), sticker: { source: "builtin", stickerId: HEART }, ...patch };
  return draftSpec(4, { layers: [textLayer(0, 0, 2_000), sticker] });
}

const stickerOf = (spec: MontageDraft): StickerLayer => {
  const layer = spec.layers[1];
  if (layer?.kind !== "sticker") throw new Error("no sticker at 1");
  return layer;
};

const hits = (layer: StickerLayer): string[] => zonesHit(stickerBox(layer), reelsSafeZones()).map((z) => z.id);

describe("the size (R36, CF12: the contract's 0.05–0.6 of the frame width, shown in whole percent)", () => {
  test("the bounds are the contract's: it takes 0.05 and 0.6, and refuses a hundredth past either", () => {
    const at = (size: number): boolean => StickerLayerSchema.safeParse({ ...stickerOf(withSticker()), size }).success;
    expect([MIN_STICKER_SIZE, MAX_STICKER_SIZE]).toEqual([0.05, 0.6]);
    expect(at(MIN_STICKER_SIZE)).toBe(true);
    expect(at(MAX_STICKER_SIZE)).toBe(true);
    expect(at(MIN_STICKER_SIZE - 0.01)).toBe(false);
    expect(at(MAX_STICKER_SIZE + 0.01)).toBe(false);
  });

  test("a size is kept to a hundredth (a whole percent) and held within the bounds; only the size changes", () => {
    const spec = withSticker({ size: 0.2 });
    expect(stickerOf(setStickerSize(spec, 1, 0.183)).size).toBe(0.18);
    expect(stickerOf(setStickerSize(spec, 1, 0.05)).size).toBe(0.05);
    expect(stickerOf(setStickerSize(spec, 1, 0.04)).size).toBe(0.05);
    expect(stickerOf(setStickerSize(spec, 1, 0.6)).size).toBe(0.6);
    expect(stickerOf(setStickerSize(spec, 1, 0.61)).size).toBe(0.6);
    const next = setStickerSize(spec, 1, 0.3);
    expect(MontageDraft.safeParse(next).success).toBe(true);
    expect({ ...stickerOf(next), size: 0.2 }).toEqual(stickerOf(spec));
  });

  test("the same size is the same draft; a size that is no number, or a layer that is no sticker, is a programming error", () => {
    const spec = withSticker({ size: 0.2 });
    expect(setStickerSize(spec, 1, 0.201)).toBe(spec);
    expect(() => setStickerSize(spec, 1, Number.NaN)).toThrow(RangeError);
    expect(() => setStickerSize(spec, 0, 0.3)).toThrow(RangeError);
    expect(() => setStickerSize(spec, 2, 0.3)).toThrow(RangeError);
  });

  test("shown in whole percent", () => {
    expect([stickerPercent(0.05), stickerPercent(0.203), stickerPercent(0.6)]).toEqual([5, 20, 60]);
  });
});

describe("«Заменить стикер» (R41): another built-in sticker in the same time and place", () => {
  test("only the sticker changes: id, time, place and size stay", () => {
    const spec = withSticker({ x: 0.3, y: 0.4, size: 0.25 });
    const next = replaceSticker(spec, 1, SPARKLE);
    expect(MontageDraft.safeParse(next).success).toBe(true);
    expect(stickerOf(next)).toEqual({ ...stickerOf(spec), sticker: { source: "builtin", stickerId: SPARKLE } });
  });

  test("the same sticker is the same draft; one the set does not have is a programming error", () => {
    const spec = withSticker();
    expect(replaceSticker(spec, 1, HEART)).toBe(spec);
    expect(() => replaceSticker(spec, 1, "sticker-nowhere-00")).toThrow(RangeError);
    expect(() => replaceSticker(spec, 0, SPARKLE)).toThrow(RangeError);
  });
});

describe("how often each built-in sticker is in the montage (the «GIF» tab's badges, G4)", () => {
  test("counted per sticker; texts and own stickers count nothing", () => {
    const spec = draftSpec(4, {
      layers: [
        { ...stickerLayer(0, 0, 1_000), sticker: { source: "builtin", stickerId: HEART } },
        textLayer(1, 0, 1_000),
        { ...stickerLayer(2, 0, 1_000), sticker: { source: "builtin", stickerId: HEART } },
        { ...stickerLayer(3, 0, 1_000), sticker: { source: "builtin", stickerId: SPARKLE } },
        { ...stickerLayer(4, 0, 1_000), sticker: { source: "own", mediaId: "media-own-0001" } },
      ],
    });
    expect([...stickerUses(spec)].sort()).toEqual([
      [HEART, 2],
      [SPARKLE, 1],
    ]);
    expect(stickerUses(draftSpec(1)).size).toBe(0);
  });
});

describe("the Reels zones (R39, AM10) and «Сдвинуть внутрь» (R40)", () => {
  test("which zones a sticker reaches: the right strip, the bottom band, both, or none", () => {
    expect(stickerZones(stickerOf(withSticker({ x: 0.9, y: 0.6, size: 0.15 })))).toEqual(["right"]);
    expect(stickerZones(stickerOf(withSticker({ x: 0.5, y: 0.92, size: 0.2 })))).toEqual(["bottom"]);
    expect(stickerZones(stickerOf(withSticker({ x: 0.92, y: 0.85, size: 0.2 })))).toEqual(["bottom", "right"]);
    expect(stickerZones(stickerOf(withSticker({ x: 0.5, y: 0.3, size: 0.2 })))).toEqual([]);
  });

  test("a box that only touches a zone's edge reaches none (touching is not a hit)", () => {
    // 0.2 of 1080 is a 216 px square; centred at y = (1536 - 108) / 1920, its foot is exactly on the bottom band's top.
    const touching = stickerOf(withSticker({ x: 0.5, y: (1536 - 108) / 1920, size: 0.2 }));
    expect(stickerBox(touching).y + stickerBox(touching).h).toBe(1536);
    expect(stickerZones(touching)).toEqual([]);
  });

  const cases: [string, Partial<StickerLayer>][] = [
    ["in the right strip", { x: 0.9, y: 0.6, size: 0.15 }],
    ["in the bottom band", { x: 0.5, y: 0.92, size: 0.2 }],
    ["in both, at the bottom right", { x: 0.92, y: 0.85, size: 0.2 }],
    ["the largest sticker in the corner", { x: 1, y: 1, size: 0.6 }],
    ["the smallest one at the very foot", { x: 0.05, y: 1, size: 0.05 }],
  ];
  for (const [what, place] of cases) {
    test(`a sticker ${what} ends up in no zone, its size, time and sticker kept`, () => {
      const spec = withSticker(place);
      const next = moveInside(spec, 1);
      expect(MontageDraft.safeParse(next).success).toBe(true);
      const moved = stickerOf(next);
      expect(hits(moved)).toEqual([]);
      expect({ ...moved, x: 0, y: 0 }).toEqual({ ...stickerOf(spec), x: 0, y: 0 });
    });
  }

  test("by the shortest way: a sticker just inside the right strip steps left, not all the way up", () => {
    const spec = withSticker({ x: 0.85, y: 0.6, size: 0.15 });
    const moved = stickerOf(moveInside(spec, 1));
    expect(moved.y).toBe(0.6);
    expect(moved.x).toBeLessThan(0.85);
    // ...and not further than it must: its right edge lands on the strip's edge, within the 2 px kept for rounding.
    const box = stickerBox(moved);
    expect(918 - (box.x + box.w)).toBeGreaterThanOrEqual(0);
    expect(918 - (box.x + box.w)).toBeLessThanOrEqual(4);
  });

  test("a sticker in the bottom band only goes up, its x kept", () => {
    const moved = stickerOf(moveInside(withSticker({ x: 0.3, y: 0.95, size: 0.2 }), 1));
    expect(moved.x).toBe(0.3);
    expect(moved.y).toBeLessThan(0.95);
  });

  test("a sticker in no zone stays: the same draft", () => {
    const spec = withSticker({ x: 0.5, y: 0.3, size: 0.2 });
    expect(moveInside(spec, 1)).toBe(spec);
  });
});
