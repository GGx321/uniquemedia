import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildGif, lzwCompress, type TestGifFrame } from "../../shared/stickers/gif.testkit";
import type { FfmpegSpawner } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { MAX_ANIMATION_LOOP_PIXELS } from "../render/layerPass";
import { handoff } from "./photoFixtures.testkit";
import { createStickerImporter } from "./stickerImporter";
useNativeGlobals();

// The memory rule of 3b.6 at the import (3f.5): a sticker is priced in the layer pass at its loop cache, frames x w x h x 2.5 bytes, and the render
// refuses a layer that fits no call of its position. So the importer refuses, as `dimensions`, what the render could never use: a loop whose frames
// times its canvas is over `MAX_ANIMATION_LOOP_PIXELS`. Judged from the readers' facts, before ffmpeg is asked for anything.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-sticker-cap-");
const noSpawn: FfmpegSpawner = () => {
  throw new Error("must not be spawned for a sticker the readers refuse");
};

/** `count` frames of flat colour on a `side` square, delays of 3, 3 and 4 cs repeated (10 cs a round is 3 slots, so a frame is about one slot). */
function gifOf(count: number, side: number): Uint8Array {
  const flat = Array.from({ length: 4 }, (_, colour) => lzwCompress(new Uint8Array(side * side).fill(colour)));
  const frames: TestGifFrame[] = Array.from({ length: count }, (_, k) => ({ delayCs: [3, 3, 4][k % 3] ?? 3, indices: [], rawData: flat[k % 4] ?? new Uint8Array() }));
  return buildGif({ width: side, height: side, frames });
}

describe("the sticker importer: frames x canvas against the render's memory rule", () => {
  test("a 720 x 720 sticker of 167 frames is one frame past what the render could use: dimensions, before ffmpeg", async () => {
    expect(167 * 720 * 720).toBeGreaterThan(MAX_ANIMATION_LOOP_PIXELS);
    const hand = await handoff(tmp(), gifOf(167, 720), { format: "gif", kind: "sticker" });
    expect(await createStickerImporter({ encode: async () => new Uint8Array(0), spawner: noSpawn })(hand.request)).toEqual({ ok: false, reason: "dimensions" });
    expect(hand.works).toHaveLength(0);
  });

  test("a full 300-frame loop at 720 x 720 (the caps of side and length together) is refused the same way", async () => {
    const hand = await handoff(tmp(), gifOf(300, 720), { format: "gif", kind: "sticker" });
    expect(await createStickerImporter({ encode: async () => new Uint8Array(0), spawner: noSpawn })(hand.request)).toEqual({ ok: false, reason: "dimensions" });
  });

  test("the loop's own length is judged first: more than 300 slots is loop-too-long, whatever the canvas", async () => {
    const hand = await handoff(tmp(), gifOf(310, 720), { format: "gif", kind: "sticker" });
    expect(await createStickerImporter({ encode: async () => new Uint8Array(0), spawner: noSpawn })(hand.request)).toEqual({ ok: false, reason: "loop-too-long" });
  });

  test("the cap counts the SLOTS of the loop (what the render's loop cache holds), not the frames of the file", async () => {
    // 100 frames of 10 cs on a 720 square: each lasts 3 slots, so the loop is 300 slots. 100 frames x 518 400 px is under the cap; 300 slots x 518 400 px
    // is over it, and the loop cache holds one frame per SLOT.
    const flat = Array.from({ length: 4 }, (_, colour) => lzwCompress(new Uint8Array(720 * 720).fill(colour)));
    const frames: TestGifFrame[] = Array.from({ length: 100 }, (_, k) => ({ delayCs: 10, indices: [], rawData: flat[k % 4] ?? new Uint8Array() }));
    expect(100 * 720 * 720).toBeLessThan(MAX_ANIMATION_LOOP_PIXELS);
    expect(300 * 720 * 720).toBeGreaterThan(MAX_ANIMATION_LOOP_PIXELS);
    const hand = await handoff(tmp(), buildGif({ width: 720, height: 720, frames }), { format: "gif", kind: "sticker" });
    expect(await createStickerImporter({ encode: async () => new Uint8Array(0), spawner: noSpawn })(hand.request)).toEqual({ ok: false, reason: "dimensions" });
  });
});
