import { describe, expect, test } from "bun:test";
import { FRAME_H, FRAME_W } from "../../../shared/montage";
import { dockPlacement, fitPreview, PREVIEW_ARTBOARD_W, PREVIEW_MIN_W, previewScale, roomAboveFrame } from "./previewFit";

// The owner's feedback (2026-10-05): the preview fits the stage (a maximised window no longer leaves it a small fixed island), keeps the
// montage's aspect exactly (so a layer stored in montage coordinates lands on the same spot at any size), never overflows the stage, leaves the
// «Подсказки» block its side gutter, and never shows more PHYSICAL pixels than the render has (on a 2× screen at most 540 × 960 CSS px of a
// 1080 × 1920 montage), so the photos are never drawn upscaled past what the video will hold.

const RENDER = { w: FRAME_W, h: FRAME_H };
const fit = (w: number, h: number, dpr = 1, gutter = 0) => fitPreview({ stage: { w, h }, render: RENDER, dpr, gutter });

describe("the preview fits the stage", () => {
  test("a stage wider than 9:16: as tall as the stage, in whole 9 × 16 steps", () => {
    expect(fit(1_500, 880)).toEqual({ w: 495, h: 880 });
    expect(fit(1_500, 887)).toEqual({ w: 495, h: 880 });
  });

  test("a stage narrower than 9:16 (very tall): as wide as the stage", () => {
    expect(fit(300, 4_000)).toEqual({ w: 297, h: 528 });
  });

  test("a very wide, low stage: as tall as it, however wide", () => {
    expect(fit(4_000, 300)).toEqual({ w: 162, h: 288 });
  });

  test("a tiny stage: what fits, never more (a stage under one step draws nothing)", () => {
    expect(fit(9, 16)).toEqual({ w: 9, h: 16 });
    expect(fit(10, 10)).toEqual({ w: 0, h: 0 });
  });

  test("a stage not laid out yet: no size (the CSS default stands)", () => {
    expect(fit(0, 0)).toBeNull();
    expect(fit(0, 800)).toBeNull();
    expect(fit(Number.NaN, 800)).toBeNull();
    expect(fit(800, Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("never overflows the stage, and keeps 9:16 exactly (one scale on both axes: no drift between the preview and the render)", () => {
    for (let w = 40; w <= 2_600; w += 37) {
      for (let h = 60; h <= 1_500; h += 53) {
        const size = fit(w, h);
        if (size === null) throw new Error("laid out stages always fit");
        expect(size.w).toBeLessThanOrEqual(w);
        expect(size.h).toBeLessThanOrEqual(h);
        expect(size.w * FRAME_H).toBe(size.h * FRAME_W);
        expect(Number.isInteger(size.w) && Number.isInteger(size.h)).toBe(true);
      }
    }
  });
});

describe("never more physical pixels than the render has", () => {
  test("a 2× screen: at most 540 × 960 CSS px of a 1080 × 1920 montage", () => {
    expect(fit(3_000, 2_000, 2)).toEqual({ w: 540, h: 960 });
    // Under the cap the stage decides, as on a 1× screen.
    expect(fit(1_500, 880, 2)).toEqual({ w: 495, h: 880 });
  });

  test("a 1× screen: up to the render's own size; a 3× one: a third of it", () => {
    expect(fit(3_000, 2_000, 1)).toEqual({ w: 1_080, h: 1_920 });
    expect(fit(3_000, 2_000, 3)).toEqual({ w: 360, h: 640 });
  });

  test("a fractional ratio (1.25, 1.1): the largest whole step at or under the cap", () => {
    expect(fit(3_000, 2_000, 1.25)).toEqual({ w: 864, h: 1_536 });
    const odd = fit(3_000, 2_000, 1.1);
    expect(odd).toEqual({ w: 981, h: 1_744 });
    expect((odd?.w ?? Number.POSITIVE_INFINITY) * 1.1).toBeLessThanOrEqual(FRAME_W);
  });

  test("a ratio that makes no sense (0, NaN, negative) counts as 1×", () => {
    for (const dpr of [0, Number.NaN, -2]) expect(fit(3_000, 2_000, dpr)).toEqual({ w: 1_080, h: 1_920 });
  });

  test("another montage size keeps its own aspect and cap", () => {
    expect(fitPreview({ stage: { w: 3_000, h: 3_000 }, render: { w: 1_080, h: 1_350 }, dpr: 2, gutter: 0 })).toEqual({ w: 540, h: 675 });
  });
});

describe("the «Подсказки» gutter", () => {
  test("the frame keeps clear of the hints on both sides (so it stays centred)", () => {
    expect(fit(600, 1_000, 1, 100)).toEqual({ w: 396, h: 704 });
    // A stage the frame fills by its height has room to spare: the gutter changes nothing.
    expect(fit(1_500, 880, 1, 150)).toEqual({ w: 495, h: 880 });
  });

  test("a gutter that would leave less than the minimum width gives way to it, and no more than that", () => {
    expect(PREVIEW_MIN_W).toBe(180);
    expect(fit(300, 900, 1, 80)).toEqual({ w: 180, h: 320 });
    // Without the gutter it would not even reach the minimum: whatever fits the stage.
    expect(fit(150, 900, 1, 60)).toEqual({ w: 144, h: 256 });
  });

  test("a gutter that makes no sense (negative, NaN) counts as none", () => {
    for (const gutter of [-50, Number.NaN]) expect(fit(600, 1_000, 1, gutter)).toEqual({ w: 558, h: 992 });
  });
});

describe("how much the overlays scale", () => {
  test("against the artboard's 306 px frame: 1 there, 2 at 612, proportional between", () => {
    expect(PREVIEW_ARTBOARD_W).toBe(306);
    expect(previewScale(306)).toBe(1);
    expect(previewScale(612)).toBe(2);
    expect(previewScale(153)).toBe(0.5);
  });
});

describe("the room above the frame (review r1 MEDIUM-2: where the notices dock stays)", () => {
  test("half of what the stage leaves over a centred frame; none when the frame takes the whole height", () => {
    expect(roomAboveFrame(900, 720)).toBe(90);
    expect(roomAboveFrame(544, 544)).toBe(0);
    expect(roomAboveFrame(500, 544)).toBe(0);
  });
});

describe("where the notices dock goes (review r2 LOW-3)", () => {
  test("above the frame only when the dock as drawn (its cards, «Ещё N», their gaps) fits the room there; else over the frame", () => {
    expect(dockPlacement(220, 150)).toBe("above");
    expect(dockPlacement(150, 150)).toBe("above");
    expect(dockPlacement(149, 150)).toBe("over");
    expect(dockPlacement(90, 0)).toBe("above");
    expect(dockPlacement(0, 0)).toBe("over");
    expect(dockPlacement(39, 0)).toBe("over");
  });
});
