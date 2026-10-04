import { describe, expect, test } from "bun:test";
import type { MontageDraft } from "../../../shared/engine";
import {
  cellMotionGeometry,
  clipCellRects,
  clipMotionPlan,
  collageRects,
  FRAME_H,
  FRAME_W,
  motionWindow,
  type MotionPlan,
  type Size,
  stickerBox,
  textBox,
  videoClipCrop,
} from "../../../shared/montage";
import { BUILTIN_STICKER_SIZE, stickerById } from "../../../shared/stickers/manifest";
import { cellSourceWindow, clipViewAt, previewFrameAt, stickerFrameIndex, stickerFrameOf, stickerLayerBox, textLayerBox, visibleLayers } from "./previewFrame";
import { collageClip, draftSpec, photoClip, stickerLayer, textLayer, videoClip } from "./testkit";

// 3d.4: what the preview draws at a frame, from the SHARED geometry the engine renders with (studio/shared/montage): the clip
// under the playhead, each cell's rectangle, the part of its photo the render's crop + `zp4` motion shows on that frame (the
// zoompan window on the 4x canvas, mapped back to the photo's own pixels), a collage cell's stagger fade, the layers on screen in
// z-order, and a sticker's frame on its stored 30 fps loop. Nothing here re-implements render maths: it calls the engine's functions.

const PHOTO: Size = { w: 1024, h: 1536 };
const size = (): Size => PHOTO;
const KENBURNS_IN: MotionPlan = { kind: "kenburns", direction: "in", zoomFromPermille: 1000, zoomToPermille: 1100 };

describe("the frame the preview shows", () => {
  test("the playhead's frame (30 fps, rounded down); the montage's last frame at or past its end; nothing for an empty draft", () => {
    const spec = draftSpec(2);
    expect(previewFrameAt(spec, 0)).toBe(0);
    expect(previewFrameAt(spec, 1_049)).toBe(31);
    expect(previewFrameAt(spec, 3_999)).toBe(119);
    expect(previewFrameAt(spec, 4_000)).toBe(119);
    expect(previewFrameAt(spec, 9_000)).toBe(119);
    expect(previewFrameAt(draftSpec([]), 0)).toBe(null);
  });
});

describe("the part of a photo a cell shows (the render's crop and motion)", () => {
  test("a static clip shows exactly the cover crop, around the face-less focus", () => {
    const window = cellSourceWindow({ w: FRAME_W, h: FRAME_H }, PHOTO, null, { kind: "static", zoomFromPermille: 1000, zoomToPermille: 1000 }, 0, 60);
    expect(window).toEqual({ x: 80, y: 0, w: 864, h: 1536 });
  });

  test("Ken Burns in: the whole crop on the first frame, the crop at 1.1x anchored on the focus on the last", () => {
    expect(cellSourceWindow({ w: FRAME_W, h: FRAME_H }, PHOTO, null, KENBURNS_IN, 0, 60)).toEqual({ x: 80, y: 0, w: 864, h: 1536 });
    const last = cellSourceWindow({ w: FRAME_W, h: FRAME_H }, PHOTO, null, KENBURNS_IN, 59, 60);
    // Within half a photo pixel of the crop over 1.1 (the window is whole pixels of the upscaled canvas).
    expect(Math.abs(last.w - 864 / 1.1)).toBeLessThan(0.5);
    expect(Math.abs(last.h - 1536 / 1.1)).toBeLessThan(0.5);
    // The focus's column (x = 0.5 of the photo, the crop's middle) stays in the middle of the window.
    expect(Math.abs(last.x + last.w / 2 - 512)).toBeLessThan(0.5);
  });

  test("on every frame of every motion, the window is motionWindow's canvas rectangle mapped back to the photo's pixels", () => {
    const cells = [{ w: FRAME_W, h: FRAME_H }, ...collageRects("collage3").map((r) => ({ w: r.w, h: r.h }))];
    const plans: MotionPlan[] = [KENBURNS_IN, { kind: "kenburns", direction: "out", zoomFromPermille: 1100, zoomToPermille: 1000 }, { kind: "pan", direction: "left", zoomFromPermille: 1150, zoomToPermille: 1150 }, { kind: "pan", direction: "right", zoomFromPermille: 1150, zoomToPermille: 1150 }, { kind: "pan", direction: "up", zoomFromPermille: 1150, zoomToPermille: 1150 }, { kind: "pan", direction: "down", zoomFromPermille: 1150, zoomToPermille: 1150 }];
    for (const cell of cells) {
      for (const plan of plans) {
        const g = cellMotionGeometry(cell, PHOTO, { x: 0.2, y: 0.7 });
        for (const frame of [0, 17, 44]) {
          const canvas = motionWindow(plan, g.canvas, g.anchor, frame, 45);
          const window = cellSourceWindow(cell, PHOTO, { x: 0.2, y: 0.7 }, plan, frame, 45);
          expect((window.x - g.crop.x) * (g.canvas.w / g.crop.w)).toBeCloseTo(canvas.x, 6);
          expect((window.y - g.crop.y) * (g.canvas.h / g.crop.h)).toBeCloseTo(canvas.y, 6);
          expect(window.w * (g.canvas.w / g.crop.w)).toBeCloseTo(canvas.w, 6);
          expect(window.h * (g.canvas.h / g.crop.h)).toBeCloseTo(canvas.h, 6);
        }
      }
    }
  });
});

describe("the clip under the playhead", () => {
  test("an empty draft has none", () => {
    expect(clipViewAt(draftSpec([]), 0, size)).toBe(null);
  });

  test("the clip whose frames hold the frame, with the frame inside it; a clip's end frame is the next clip's", () => {
    const spec = draftSpec([photoClip(0, "photo-a-0001", 1_000), photoClip(1, "photo-b-0001", 2_000)]);
    expect(clipViewAt(spec, 29, size)).toMatchObject({ index: 0, clipId: "clip-001", localFrame: 29, frames: 30 });
    expect(clipViewAt(spec, 30, size)).toMatchObject({ index: 1, clipId: "clip-002", localFrame: 0, frames: 60 });
  });

  test("a photo clip is one full-frame cell with its photo, focus and the part of it this frame shows", () => {
    const spec = draftSpec([photoClip(0, "photo-a-0001", 2_000)]);
    const view = clipViewAt(spec, 0, size);
    const clip = spec.clips[0];
    if (clip === undefined || clip.kind !== "photo") throw new Error("setup");
    const expected = cellSourceWindow({ w: FRAME_W, h: FRAME_H }, PHOTO, null, clipMotionPlan(spec.seed, clip), 0, 60);
    expect(view?.cells).toEqual([{ index: 0, rect: { x: 0, y: 0, w: FRAME_W, h: FRAME_H }, content: { kind: "scene", photoId: "photo-a-0001", focus: null }, source: PHOTO, window: expected, alphaPermille: 1000 }]);
  });

  test("a collage's cells sit where the render puts them, in reading order, empty ones included", () => {
    const spec = draftSpec([collageClip(0, ["photo-a-0001", null, "photo-c-0001"], 3_000, false)]);
    const view = clipViewAt(spec, 10, size);
    expect(view?.cells.map((c) => c.rect)).toEqual(clipCellRects({ kind: "collage", layout: "collage3" }));
    expect(view?.cells.map((c) => c.content.kind)).toEqual(["scene", "empty", "scene"]);
    expect(view?.cells[1]?.window).toBe(null);
  });

  test("a photo whose size is not known yet (its picture is loading) shows no part yet", () => {
    const view = clipViewAt(draftSpec([photoClip(0, "photo-a-0001")]), 0, () => null);
    expect(view?.cells[0]).toMatchObject({ source: null, window: null });
  });

  test("stagger: each cell fades in over one step after the one before, as the render's fade does; off, every cell is whole", () => {
    // 3.0 s, three cells: the step is min(300 ms, 3.0 s / 4) = 9 frames.
    const on = draftSpec([collageClip(0, ["photo-a-0001", "photo-b-0001", "photo-c-0001"], 3_000, true)]);
    const alphas = (frame: number): number[] => clipViewAt(on, frame, size)?.cells.map((c) => c.alphaPermille) ?? [];
    expect(alphas(0)).toEqual([0, 0, 0]);
    expect(alphas(3)).toEqual([333, 0, 0]);
    expect(alphas(9)).toEqual([1000, 0, 0]);
    expect(alphas(13)).toEqual([1000, 444, 0]);
    expect(alphas(27)).toEqual([1000, 1000, 1000]);
    const off = draftSpec([collageClip(0, ["photo-a-0001", "photo-b-0001", "photo-c-0001"], 3_000, false)]);
    expect(clipViewAt(off, 0, size)?.cells.map((c) => c.alphaPermille)).toEqual([1000, 1000, 1000]);
  });

  test("an own photo in a cell is own media: drawn as a neutral surface", () => {
    const own = draftSpec([{ ...photoClip(0, "photo-a-0001"), cell: { photo: { source: "own", mediaId: "media-own-0002" }, focus: null } }]);
    expect(clipViewAt(own, 0, size)?.cells).toEqual([{ index: 0, rect: { x: 0, y: 0, w: FRAME_W, h: FRAME_H }, content: { kind: "own" }, source: null, window: null, alphaPermille: 1000 }]);
  });

  test("3f.3b: an own video fills the whole frame with the render's crop of its stored size (videoClipCrop, static), once that size is known", () => {
    const spec = draftSpec([{ ...videoClip(0, 2_000, 1_800), focus: { x: 0.2, y: 0.5 } }]);
    const wide = { w: 1_080, h: 608 };
    const view = clipViewAt(spec, 0, size, (mediaId) => (mediaId === "media-own-0001" ? wide : null));
    expect(view?.cells).toEqual([
      { index: 0, rect: { x: 0, y: 0, w: FRAME_W, h: FRAME_H }, content: { kind: "video", mediaId: "media-own-0001", focus: { x: 0.2, y: 0.5 } }, source: wide, window: videoClipCrop(wide, { x: 0.2, y: 0.5 }), alphaPermille: 1000 },
    ]);
    // No motion: the last frame shows the same part of it.
    expect(clipViewAt(spec, 59, size, () => wide)?.cells[0]?.window).toEqual(videoClipCrop(wide, { x: 0.2, y: 0.5 }));
    // Its size not known yet (the record not read): no window, nothing guessed.
    expect(clipViewAt(spec, 0, size)?.cells[0]).toMatchObject({ content: { kind: "video" }, source: null, window: null });
  });
});

describe("the layers on screen", () => {
  const spec: MontageDraft = draftSpec(2, { layers: [textLayer(0, 0, 1_000), stickerLayer(1, 500, 4_000), textLayer(2, 1_000, 2_000)] });

  test("those whose half-open range holds the frame, in z-order (the spec's order: later on top)", () => {
    expect(visibleLayers(spec, 0).map((l) => l.index)).toEqual([0]);
    expect(visibleLayers(spec, 15).map((l) => l.index)).toEqual([0, 1]);
    expect(visibleLayers(spec, 30).map((l) => l.index)).toEqual([1, 2]);
    expect(visibleLayers(spec, 60).map((l) => l.index)).toEqual([1]);
    expect(visibleLayers(spec, 120).map((l) => l.index)).toEqual([]);
  });

  test("a text's box is the engine's: centred where the layer says on the size of the picture it drew, kept inside the frame", () => {
    const layer = { ...textLayer(0, 0, 1_000), x: 0.02, y: 0.5 };
    expect(textLayerBox(layer, { width: 401, height: 90 })).toEqual(textBox(layer, { w: 401, h: 90 }));
    expect(textLayerBox(layer, { width: 401, height: 90 }).x).toBe(0);
  });

  test("a built-in sticker's box is the engine's, on the set's square picture; a sticker the set lacks has none", () => {
    const layer = { ...stickerLayer(0, 0, 1_000), sticker: { source: "builtin" as const, stickerId: "heart-pulse" }, size: 0.3 };
    expect(stickerLayerBox(layer)).toEqual(stickerBox(layer, { w: BUILTIN_STICKER_SIZE, h: BUILTIN_STICKER_SIZE }));
    expect(stickerLayerBox({ ...layer, sticker: { source: "builtin", stickerId: "no-such-sticker" } })).toBe(null);
    // An own sticker has no box until its record's canvas is known (3f.5).
    expect(stickerLayerBox({ ...layer, sticker: { source: "own", mediaId: "media-own-0001" } })).toBe(null);
  });

  test("an own sticker's box is the engine's, on ITS canvas (which need not be square); with the canvas of another sticker it is that one's", () => {
    const layer = { ...stickerLayer(0, 0, 1_000), sticker: { source: "own" as const, mediaId: "media-own-0001" }, size: 0.4, x: 0.6, y: 0.4 };
    expect(stickerLayerBox(layer, { width: 400, height: 200 })).toEqual(stickerBox(layer, { w: 400, h: 200 }));
    expect(stickerLayerBox(layer, { width: 400, height: 200 })).not.toEqual(stickerLayerBox(layer, { width: 200, height: 200 }));
  });

  test("the canvas of an own sticker is not used for a built-in one: the set's own square picture stays the box", () => {
    const layer = { ...stickerLayer(0, 0, 1_000), sticker: { source: "builtin" as const, stickerId: "heart-pulse" }, size: 0.3 };
    expect(stickerLayerBox(layer, { width: 400, height: 200 })).toEqual(stickerBox(layer, { w: BUILTIN_STICKER_SIZE, h: BUILTIN_STICKER_SIZE }));
  });
});

describe("a sticker's frame on its loop", () => {
  test("by the tick and the stored loop alone: 99 ticks into a 24-frame loop is frame 3 (a decoder's 33 000 µs would say otherwise)", () => {
    expect(stickerFrameIndex(33 + 99, 33, 24)).toBe(3);
  });

  test("a layer's sticker, from the LAYER's start and the sticker's stored loop: heart-pulse from 1.0 s at 2.5 s is frame 21", () => {
    const heart = stickerById("heart-pulse");
    if (heart === undefined) throw new Error("heart-pulse is in the set");
    expect(heart.loopFrames).toBe(24);
    expect(stickerFrameOf(heart, { startMs: 1_000, endMs: 4_000 }, 75)).toBe((75 - 30) % 24);
  });

  test("a sticker's own delays are used where it has them (own stickers, 3f.5); the built-in set is one frame per tick", () => {
    expect([0, 1, 2, 3, 6].map((t) => stickerFrameOf({ loopFrames: 6, delayFrames: [2, 1, 3] }, { startMs: 0, endMs: 1_000 }, t))).toEqual([0, 0, 1, 2, 0]);
    expect(stickerFrameOf({ loopFrames: 6 }, { startMs: 0, endMs: 1_000 }, 2)).toBe(2);
  });

  test("the 30 fps tick since the layer started, wrapped on the loop stored with the sticker (the built-in set: one frame per tick)", () => {
    expect([0, 1, 23, 24, 25, 49].map((t) => stickerFrameIndex(33 + t, 33, 24))).toEqual([0, 1, 23, 0, 1, 1]);
  });

  test("own frames of several ticks each are found by their delays in 30 fps frames, never by a decoder's durations", () => {
    // Delays 2, 1, 3: frame 0 for ticks 0-1, frame 1 for tick 2, frame 2 for ticks 3-5, then over.
    expect([0, 1, 2, 3, 4, 5, 6, 8].map((t) => stickerFrameIndex(t, 0, 6, [2, 1, 3]))).toEqual([0, 0, 1, 2, 2, 2, 0, 1]);
  });

  test("a stored loop shorter than the frames cuts them, as the render's loop cache does", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((t) => stickerFrameIndex(t, 0, 5))).toEqual([0, 1, 2, 3, 4, 0, 1]);
    expect([0, 2, 3, 4].map((t) => stickerFrameIndex(t, 0, 3, [2, 2, 2]))).toEqual([0, 1, 0, 0]);
  });

  test("frames whose delays add up to less than the loop repeat what they have, as the render's loop does", () => {
    expect([0, 1, 2, 3].map((t) => stickerFrameIndex(t, 0, 10, [1, 2]))).toEqual([0, 1, 1, 0]);
  });

  test("before its start a layer is not on screen; asked anyway, it is on its first frame", () => {
    expect(stickerFrameIndex(10, 33, 24)).toBe(0);
  });

  test("refuses a loop that is not a whole number of frames, and a delay that is not", () => {
    expect(() => stickerFrameIndex(0, 0, 0)).toThrow(RangeError);
    expect(() => stickerFrameIndex(0, 0, 2.5)).toThrow(RangeError);
    expect(() => stickerFrameIndex(0, 0, 4, [1, 0])).toThrow(RangeError);
    expect(() => stickerFrameIndex(0, 0, 4, [])).toThrow(RangeError);
  });
});
