import { describe, expect, test } from "bun:test";
import { coverCrop, FOCUS_FALLBACK, FRAME_H, FRAME_W, type Size } from "../../../shared/montage";
import { dragFocus, dragLayerCentre, resizeFactor, setCellFocus } from "./previewDrag";
import { collageClip, draftSpec, photoClip, videoClip } from "./testkit";

/** Four decimals, as the drags keep them. */
const r4 = (v: number): number => Math.round(v * 10_000) / 10_000;

// 3d.4: dragging in the preview. A layer moves by its box on the 1080x1920 frame and never leaves it (the render clamps a box into
// the frame anyway; the centre is kept where the box can still follow the pointer, so dragging back has no dead zone). A corner
// scales a layer about its centre (the contract anchors layers at their centre). A selected cell's crop is moved by its face point
// (Q3: no zoom): the photo follows the pointer, so the focus moves the other way, by the crop's pixels per frame pixel.

describe("moving a layer", () => {
  test("by the pointer's travel in frame pixels, from where its box is drawn", () => {
    const box = { x: 340, y: 600, w: 400, h: 120 };
    expect(dragLayerCentre(box, { dx: 108, dy: -192 })).toEqual({ x: 0.6, y: r4(468 / FRAME_H) });
  });

  test("never past the frame: the box stops at an edge, and the centre stays where the box stops", () => {
    const box = { x: 340, y: 600, w: 400, h: 120 };
    expect(dragLayerCentre(box, { dx: -5_000, dy: 9_000 })).toEqual({ x: r4(200 / FRAME_W), y: r4((FRAME_H - 60) / FRAME_H) });
    expect(dragLayerCentre(box, { dx: 5_000, dy: -9_000 })).toEqual({ x: r4((FRAME_W - 200) / FRAME_W), y: r4(60 / FRAME_H) });
  });

  test("a box drawn at an edge it was clamped to moves at once (the drag starts from the box, not from a centre stored past it)", () => {
    // Stored at x = 0.02, a 400 px box is drawn at x = 0: one pixel to the right moves it.
    const drawn = { x: 0, y: 600, w: 400, h: 120 };
    expect(dragLayerCentre(drawn, { dx: 1, dy: 0 }).x).toBe(r4(201 / FRAME_W));
  });

  test("a box as wide as the frame stays centred across", () => {
    expect(dragLayerCentre({ x: 0, y: 100, w: FRAME_W, h: 200 }, { dx: 300, dy: 0 }).x).toBe(0.5);
  });

  test("keeps four decimals (a tenth of a pixel on the frame)", () => {
    const { x, y } = dragLayerCentre({ x: 300, y: 300, w: 222, h: 222 }, { dx: 1, dy: 1 });
    expect([x * 10_000, y * 10_000].every(Number.isInteger)).toBe(true);
  });
});

describe("resizing a layer by a corner", () => {
  test("the pointer's distance from the centre over the press's", () => {
    expect(resizeFactor({ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 60, y: 80 })).toBe(2);
    expect(resizeFactor({ x: 10, y: 10 }, { x: 40, y: 50 }, { x: 25, y: 30 })).toBe(0.5);
  });

  test("a press or a pointer at the centre counts as a pixel away (never a zero or an infinite factor)", () => {
    expect(resizeFactor({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 8, y: 9 })).toBe(5);
    expect(resizeFactor({ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 5, y: 5 })).toBe(0.1);
  });
});

describe("dragging a cell's crop by its face point", () => {
  const PHOTO: Size = { w: 1024, h: 1536 };
  const FULL: Size = { w: FRAME_W, h: FRAME_H };

  test("the photo follows the pointer: dragged right, the focus moves left by the crop's pixels per frame pixel", () => {
    // The crop is 864 x 1536 of the photo in a 1080 x 1920 cell: 0.8 photo pixels per frame pixel.
    const focus = dragFocus({ x: 0.5, y: 0.5 }, { dx: 100, dy: 0 }, FULL, PHOTO);
    expect(focus).toEqual({ x: r4(0.5 - (100 * 0.8) / 1024), y: 0.5 });
  });

  test("the crop moves with it: the new focus's crop is shifted by the travel in photo pixels", () => {
    const before = coverCrop(PHOTO, FULL, { x: 0.5, y: 0.5 });
    const after = coverCrop(PHOTO, FULL, dragFocus({ x: 0.5, y: 0.5 }, { dx: 50, dy: 0 }, FULL, PHOTO));
    expect(Math.abs(before.x - after.x - 40)).toBeLessThanOrEqual(2);
  });

  test("an axis the crop already fills cannot move (here: the photo's whole height is in the crop)", () => {
    expect(dragFocus({ x: 0.5, y: 0.2 }, { dx: 0, dy: 300 }, FULL, PHOTO).y).toBe(0.2);
  });

  test("never past the point where the crop stops at the photo's edge, so dragging back has no dead zone", () => {
    const far = dragFocus({ x: 0.5, y: 0.5 }, { dx: -5_000, dy: 0 }, FULL, PHOTO);
    expect(far.x).toBe(r4(1 - 432 / 1024));
    expect(coverCrop(PHOTO, FULL, far).x).toBe(PHOTO.w - 864);
  });

  test("a moved axis starts from where the crop really is: a focus stored past the edge does not hold the drag back", () => {
    // x = 0.95 crops at the right edge, as x = 1 - 432 / 1024 does: one pixel to the right moves the crop at once.
    const moved = dragFocus({ x: 0.95, y: 0.5 }, { dx: 1, dy: 0 }, FULL, PHOTO);
    expect(moved.x).toBeLessThan(1 - 432 / 1024);
    expect(moved.y).toBe(0.5);
  });

  test("an axis the pointer did not move keeps its stored focus exactly (the motion still anchors on the face)", () => {
    const moved = dragFocus({ x: 0.5, y: 0.03 }, { dx: 20, dy: 0 }, { w: 534, h: 954 }, PHOTO);
    expect(moved.y).toBe(0.03);
  });

  test("a photo with no focus (unresolved) starts from the fallback point", () => {
    expect(dragFocus(null, { dx: 0, dy: 0 }, FULL, PHOTO)).toEqual(FOCUS_FALLBACK);
  });
});

describe("setCellFocus", () => {
  test("writes the focus into the cell of a photo clip or a collage, and nothing else", () => {
    const spec = draftSpec([photoClip(0, "photo-a-0001"), collageClip(1, ["photo-b-0001", "photo-c-0001"])]);
    const one = setCellFocus(spec, 0, 0, { x: 0.3, y: 0.4 });
    expect(one.clips[0]).toEqual({ ...photoClip(0, "photo-a-0001"), cell: { photo: { source: "scene", photoId: "photo-a-0001" }, focus: { x: 0.3, y: 0.4 } } });
    expect(one.clips[1]).toBe(spec.clips[1]);
    const two = setCellFocus(spec, 1, 1, { x: 0.6, y: 0.2 });
    const collage = two.clips[1];
    expect(collage?.kind === "collage" ? collage.cells.map((c) => c.focus) : null).toEqual([null, { x: 0.6, y: 0.2 }]);
  });

  test("the same draft when the focus is already that", () => {
    const spec = setCellFocus(draftSpec([photoClip(0, "photo-a-0001")]), 0, 0, { x: 0.3, y: 0.4 });
    expect(setCellFocus(spec, 0, 0, { x: 0.3, y: 0.4 })).toBe(spec);
  });

  test("refuses an empty cell, an own video and a cell or clip that is not there", () => {
    const spec = draftSpec([collageClip(0, [null, "photo-b-0001"]), videoClip(1)]);
    expect(() => setCellFocus(spec, 0, 0, { x: 0.5, y: 0.5 })).toThrow(RangeError);
    expect(() => setCellFocus(spec, 1, 0, { x: 0.5, y: 0.5 })).toThrow(RangeError);
    expect(() => setCellFocus(spec, 0, 2, { x: 0.5, y: 0.5 })).toThrow(RangeError);
    expect(() => setCellFocus(spec, 2, 0, { x: 0.5, y: 0.5 })).toThrow(RangeError);
  });
});
