import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { layerCost, LAYER_CALL_BUDGET_BYTES, LAYER_CALL_BASE_BYTES, LAYER_CHAINED_INPUT_BYTES, MAX_ANIMATION_LOOP_PIXELS, planLayerBatches } from "./layerPass";
import type { OverlayInput } from "./types";
useNativeGlobals();

// 3f.5, the memory rule of 3b.6: a layer is priced at its loop cache (frames x w x h x 2.5 bytes) and a layer that fits NO call of its position is
// refused by the render. An own sticker is the owner's, up to 720 px and 300 frames, so the import must refuse what the render never could use.
// `MAX_ANIMATION_LOOP_PIXELS` is that bound: the most (loop frames x w x h) an animation may have and still fit the call that FOLLOWS another
// (the tightest position, since the layers cannot be reordered to make one fit).

const sticker = (loopFrames: number, w: number, h: number): OverlayInput => ({
  path: "/job/sticker-00.apng",
  format: "apng",
  box: { x: 0, y: 0, w: 648, h: 648 },
  resize: true,
  startFrame: 0,
  endFrame: 90,
  loopFrames,
  sourceSize: { w, h },
});

const roomAfterAnother = LAYER_CALL_BUDGET_BYTES - LAYER_CALL_BASE_BYTES - LAYER_CHAINED_INPUT_BYTES;

describe("MAX_ANIMATION_LOOP_PIXELS", () => {
  test("an animation exactly at the cap still fits a call that follows another", () => {
    const frames = 100;
    const side = Math.floor(Math.sqrt(MAX_ANIMATION_LOOP_PIXELS / frames));
    expect(frames * side * side).toBeLessThanOrEqual(MAX_ANIMATION_LOOP_PIXELS);
    expect(layerCost(sticker(frames, side, side))).toBeLessThanOrEqual(roomAfterAnother);
  });

  test("one more pixel than the cap does not fit that call: the cap is tight, not loose", () => {
    // One frame of that many pixels (the cost depends on the product alone).
    expect(layerCost(sticker(1, MAX_ANIMATION_LOOP_PIXELS + 1, 1))).toBeGreaterThan(roomAfterAnother);
  });

  test("a full-size own sticker of the most frames the cap allows (166 at 720 x 720) is planned after a full call, one frame more is refused", () => {
    expect(166 * 720 * 720).toBeLessThanOrEqual(MAX_ANIMATION_LOOP_PIXELS);
    expect(167 * 720 * 720).toBeGreaterThan(MAX_ANIMATION_LOOP_PIXELS);
    const fillingFirstCall = LAYER_CALL_BUDGET_BYTES - LAYER_CALL_BASE_BYTES;
    expect(planLayerBatches([fillingFirstCall, layerCost(sticker(166, 720, 720))])).toEqual([[0], [1]]);
    expect(() => planLayerBatches([fillingFirstCall, layerCost(sticker(167, 720, 720))])).toThrow();
  });

  test("the 300 frames of the loop cap fit at 480 x 480 and not at 720 x 720", () => {
    expect(300 * 480 * 480).toBeLessThanOrEqual(MAX_ANIMATION_LOOP_PIXELS);
    expect(300 * 720 * 720).toBeGreaterThan(MAX_ANIMATION_LOOP_PIXELS);
  });
});
