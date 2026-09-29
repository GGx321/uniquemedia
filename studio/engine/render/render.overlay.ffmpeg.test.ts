import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { extractFrames, videoFrames } from "./ffmpeg.testkit";
import { buildPass1 } from "./pass1";
import { buildPass2 } from "./pass2";
import { makeBlinkApng, makeSolid, makeWorkDir, meanAround, removeDir, runPass1, runPass2, splitYuv420 } from "./render.testkit";
import type { OverlayInput } from "./types";
useNativeGlobals();

// REAL ffmpeg, pass 2 with overlays (the slot 3b fills with text PNGs and
// stickers): the overlay windows are frame-exact, an animated overlay's loop
// starts on its layer's first frame, a sticker is scaled to its box, and none
// of it changes the exact length (invariant 20, SP1's `endall` rule).
//
// The photo is flat grey (limited-range luma 126), the overlays are white
// (235) or black (16), so "is the overlay here" is one luma mean.

const TOTAL = 90; // two 1.5 s clips (S14: clips of at most 2 s), joined at frame 45
const GREY = 126;
const WHITE = 235;
const BLACK = 16;
const SAMPLE_AT = [0, 29, 30, 32, 33, 35, 36, 45, 48, 59, 60, 89];

let dir: string;
let output: string;
let frameCount: number;
const lumaPlanes = new Map<number, Uint8Array>();

// Overlay centres (box centre) on the 1080x1920 frame.
const STILL_WINDOWED = { x: 100, y: 200, w: 200, h: 200 }; // frames [30, 60)
const BLINK = { x: 600, y: 200, w: 200, h: 200 }; // frames [30, 60), animated
const STILL_WHOLE = { x: 100, y: 600, w: 200, h: 200 }; // frames [0, 90)
const RESIZED = { x: 600, y: 600, w: 216, h: 216 }; // frames [0, 90), 50x50 source scaled up
const STILL_TAIL = { x: 100, y: 1000, w: 200, h: 200 }; // frames [60, 90): runs to the last frame

const centre = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const clip: Clip = { clipId: "flat", durationMs: 1500, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: "flat" }, focus: null }, motion: "static" };

beforeAll(async () => {
  dir = makeWorkDir("overlay");
  const flat = join(dir, "flat.jpg");
  const white = join(dir, "white.png");
  const small = join(dir, "small.png");
  const blink = join(dir, "blink.png");
  await makeSolid(flat, "0x808080", 720, 1280, "jpeg");
  await makeSolid(white, "white", 200, 200, "png-rgba");
  await makeSolid(small, "white", 50, 50, "png-rgba");
  await makeBlinkApng(blink, 200);

  await runPass1(buildPass1({ seed: 1, clips: [clip, { ...clip, clipId: "flat-2" }], resolvePhoto: () => ({ path: flat, width: 720, height: 1280 }), clipDir: dir }));
  const overlays: OverlayInput[] = [
    { path: white, format: "png", box: STILL_WINDOWED, resize: false, startFrame: 30, endFrame: 60 },
    { path: blink, format: "apng", box: BLINK, resize: false, startFrame: 30, endFrame: 60 },
    { path: white, format: "png", box: STILL_WHOLE, resize: false, startFrame: 0, endFrame: TOTAL },
    { path: small, format: "png", box: RESIZED, resize: true, startFrame: 0, endFrame: TOTAL },
    { path: white, format: "png", box: STILL_TAIL, resize: false, startFrame: 60, endFrame: TOTAL },
  ];
  output = join(dir, "final.mp4");
  await runPass2(buildPass2({ clips: [clip, { ...clip, clipId: "flat-2" }], clipDir: dir, output, overlays, audio: { kind: "silent" } }));

  frameCount = await videoFrames(output);
  const frames = await extractFrames(output, SAMPLE_AT, "yuv420p", { w: 1080, h: 1920 });
  SAMPLE_AT.forEach((f, i) => lumaPlanes.set(f, splitYuv420(frames[i] ?? new Uint8Array(), 1080, 1920).y));
}, 180_000);

afterAll(() => removeDir(dir));

function luma(frame: number, x: number, y: number): number {
  const plane = lumaPlanes.get(frame);
  if (!plane) throw new Error(`frame ${frame} was not sampled`);
  return meanAround(plane, 1080, x, y, 8);
}
const at = (frame: number, box: { x: number; y: number; w: number; h: number }): number => luma(frame, centre(box).x, centre(box).y);

describe("overlays on real ffmpeg: length", () => {
  test("five overlays, one of them animated, one lasting the whole timeline and one running to the last frame, leave the output at exactly 90 frames", () => {
    expect(frameCount).toBe(TOTAL);
  });
});

describe("overlays on real ffmpeg: a still overlay's window is [start, end)", () => {
  test("is not there on the frame before its start", () => {
    expect(at(29, STILL_WINDOWED)).toBeCloseTo(GREY, -1);
  });

  test("is there on its first frame", () => {
    expect(at(30, STILL_WINDOWED)).toBeCloseTo(WHITE, -1);
  });

  test("is still there on its last frame", () => {
    expect(at(59, STILL_WINDOWED)).toBeCloseTo(WHITE, -1);
  });

  test("is gone on its end frame, which belongs to nobody", () => {
    expect(at(60, STILL_WINDOWED)).toBeCloseTo(GREY, -1);
  });
});

describe("overlays on real ffmpeg: a layer that runs to the last frame but starts later", () => {
  test("is not there on the frame before its start", () => {
    expect(at(59, STILL_TAIL)).toBeCloseTo(GREY, -1);
  });

  test("is there on its first frame", () => {
    expect(at(60, STILL_TAIL)).toBeCloseTo(WHITE, -1);
  });

  test("is there on the last frame of the montage", () => {
    expect(at(89, STILL_TAIL)).toBeCloseTo(WHITE, -1);
  });
});

describe("overlays on real ffmpeg: an overlay that lasts the whole timeline", () => {
  test("is there on the first frame", () => {
    expect(at(0, STILL_WHOLE)).toBeCloseTo(WHITE, -1);
  });

  test("is there on the last frame", () => {
    expect(at(89, STILL_WHOLE)).toBeCloseTo(WHITE, -1);
  });
});

describe("overlays on real ffmpeg: an animated overlay loops from its layer's first frame", () => {
  // The blink is white for 3 frames, then black for 3: a period of 6 frames, starting white at layer frame 0 (timeline frame 30).
  test.each([
    [30, "white", WHITE, "layer frame 0"],
    [32, "white", WHITE, "layer frame 2, the last white one"],
    [33, "black", BLACK, "layer frame 3, the first black one"],
    [35, "black", BLACK, "layer frame 5"],
    [36, "white", WHITE, "layer frame 6, where the loop restarts"],
    [45, "black", BLACK, "layer frame 15, the third loop"],
    [48, "white", WHITE, "layer frame 18, the fourth loop"],
  ] as const)("frame %d shows %s (%s)", (frame, _colour, want) => {
    expect(at(frame, BLINK)).toBeCloseTo(want, -1);
  });

  test("is not there before its layer starts", () => {
    expect(at(29, BLINK)).toBeCloseTo(GREY, -1);
  });

  test("is not there after its layer ends", () => {
    expect(at(60, BLINK)).toBeCloseTo(GREY, -1);
  });
});

describe("overlays on real ffmpeg: a sticker is scaled to its box", () => {
  test("covers the box's far corner", () => {
    expect(luma(45, RESIZED.x + RESIZED.w - 16, RESIZED.y + RESIZED.h - 16)).toBeCloseTo(WHITE, -1);
  });

  test("stops at the box's edge", () => {
    expect(luma(45, RESIZED.x + RESIZED.w + 16, RESIZED.y + RESIZED.h + 16)).toBeCloseTo(GREY, -1);
  });
});
