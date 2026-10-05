import { describe, expect, test } from "bun:test";
import { coversFrame, drawCap, MAX_UPSCALE } from "./imageFit";

// The large-screen audit (H2): a picture is never drawn noticeably past its own pixels. `drawCap` is the largest box a picture may take on a
// screen of a given pixel ratio; `coversFrame` says whether that box still fills the frame the picture sits in (if not, the frame shows a band).

describe("drawCap", () => {
  test("a stretch of at most MAX_UPSCALE device pixels per picture pixel, in CSS px", () => {
    expect(MAX_UPSCALE).toBe(1.25);
    // The owner's imported master on a 2× screen: 246 × 1.25 / 2.
    expect(drawCap({ width: 246, height: 281 }, 2)).toEqual({ width: 153.75, height: 175.625 });
    // The same picture on a 1× screen may take twice the CSS size.
    expect(drawCap({ width: 246, height: 281 }, 1)).toEqual({ width: 307.5, height: 351.25 });
    // A generated master: far larger than any frame it is drawn in.
    expect(drawCap({ width: 864, height: 1152 }, 2)).toEqual({ width: 540, height: 720 });
  });

  test("a fractional pixel ratio (a Windows display at 150 %) and an explicit stretch limit", () => {
    const cap = drawCap({ width: 720, height: 1280 }, 1.5);
    expect(cap?.width).toBe(600);
    expect(cap?.height).toBeCloseTo(1066.667, 3);
    expect(drawCap({ width: 864, height: 1152 }, 2, 1)).toEqual({ width: 432, height: 576 });
  });

  test("no cap while the picture's own size is unknown: zero, negative or not a finite number", () => {
    for (const natural of [
      { width: 0, height: 281 },
      { width: 246, height: 0 },
      { width: -246, height: 281 },
      { width: Number.NaN, height: 281 },
      { width: 246, height: Number.POSITIVE_INFINITY },
    ]) {
      expect(drawCap(natural, 2)).toBeNull();
    }
  });

  test("a pixel ratio that is not a positive finite number counts as 1", () => {
    for (const dpr of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(drawCap({ width: 246, height: 281 }, dpr)).toEqual({ width: 307.5, height: 351.25 });
    }
  });

  test("a stretch limit that is not a positive finite number falls back to MAX_UPSCALE", () => {
    for (const limit of [0, -1, Number.NaN]) {
      expect(drawCap({ width: 246, height: 281 }, 2, limit)).toEqual({ width: 153.75, height: 175.625 });
    }
  });
});

describe("coversFrame", () => {
  const frame = { width: 212, height: 224 };

  test("a cap at least as large as the frame on both sides covers it", () => {
    expect(coversFrame(frame, { width: 540, height: 720 })).toBe(true);
    expect(coversFrame(frame, { width: 212, height: 224 })).toBe(true);
  });

  test("a cap short of the frame on either side leaves a band", () => {
    expect(coversFrame(frame, { width: 153.75, height: 175.625 })).toBe(false);
    expect(coversFrame(frame, { width: 300, height: 200 })).toBe(false);
    expect(coversFrame(frame, { width: 200, height: 300 })).toBe(false);
  });

  test("half a CSS pixel short is still covered (a band that thin is never seen); just past that is not", () => {
    expect(coversFrame(frame, { width: 211.5, height: 224 })).toBe(true);
    expect(coversFrame(frame, { width: 212, height: 223.5 })).toBe(true);
    expect(coversFrame(frame, { width: 211.4, height: 224 })).toBe(false);
    expect(coversFrame(frame, { width: 212, height: 223.4 })).toBe(false);
  });

  test("no cap, or a frame not laid out yet, counts as covered", () => {
    expect(coversFrame(frame, null)).toBe(true);
    expect(coversFrame({ width: 0, height: 0 }, { width: 10, height: 10 })).toBe(true);
    expect(coversFrame({ width: Number.NaN, height: 224 }, { width: 10, height: 10 })).toBe(true);
  });
});
