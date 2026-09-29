import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Clip, Focus } from "../../shared/engine/montage";
import { cellMotionGeometry, clipMotionPlan, collageRects, motionPlan, motionWindow, msToFrames, type Rect } from "../../shared/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { edgePositions, extractFrames, fitAxis, horizontalDiff, makeStripeJpeg, stripeEdges, verticalDiff } from "./ffmpeg.testkit";
import { buildPass1 } from "./pass1";
import { MOVING_CASES, planWhere } from "./plans.testkit";
import { makeWorkDir, removeDir, runPass1 } from "./render.testkit";
useNativeGlobals();

// ZOOMPAN PARITY, measured on real pixels. The preview draws the window
// `motionWindow` computes; the render must show the same window. The probe:
//
// - the source is a 720x1280 JPEG of luma stripes (period 40 px both ways), additively separable, so its edges sit at known source pixels and
//   any linear resampler keeps the x edges and the y edges independent;
// - the clip goes through the REAL pass-1 graph (colour chain, cover-crop,
//   4x lanczos canvas, zoompan, encode);
// - on a decoded frame, each stripe edge is located to sub-pixel accuracy
//   (the centroid of the luma step), and a least-squares line through
//   `output position = a * canvas position + b` gives the window: its length
//   is `outLength / a` and its start is `-b / a`, in CANVAS pixels;
// - that measured window is compared with `motionWindow` at the same frame.
//
// The claim is "within 1 canvas pixel": motionWindow's window is whole pixels
// and ffmpeg's zoompan truncates its size and snaps its offset to even for
// 4:2:0. The measurement itself is good to 0.1 to 0.3 px; the tolerance leaves
// 0.35 px of measurement noise on top of the pixel.

const PERIOD_X = 40;
const PERIOD_Y = 40;
const SRC = { w: 720, h: 1280 };
const FRAMES = 120; // 4 s
const SAMPLE_AT = [0, 30, 60, 90, FRAMES - 1];
/** One canvas pixel (the rounding the model allows) plus 0.35 px for the measurement; the measured noise was at most 0.27. */
const TOLERANCE = 1 + 0.35;
const FOCUS: Focus = { x: 0.3, y: 0.6 };
const FOCUS_B: Focus = { x: 0.7, y: 0.2 };

let dir: string;
let stripes: string;
const outputs = new Map<string, string>();
const deviations: number[] = [];

interface Measured {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const photoClip = (clipId: string, motion: "kenburns" | "pan" | "static"): Clip => ({
  clipId,
  durationMs: 4000,
  transitionIn: "cut",
  kind: "photo",
  cell: { photo: { source: "scene", photoId: "stripes" }, focus: FOCUS },
  motion,
});

const collageClip = (clipId: string): Clip => ({
  clipId,
  durationMs: 4000,
  transitionIn: "cut",
  kind: "collage",
  layout: "collage2",
  cells: [
    { photo: { source: "scene", photoId: "stripes" }, focus: FOCUS },
    { photo: { source: "scene", photoId: "stripes" }, focus: FOCUS_B },
  ],
  motion: "kenburns",
  stagger: false,
});

async function render(name: string, clip: Clip, seed: number): Promise<void> {
  const jobs = buildPass1({ seed, clips: [clip], resolvePhoto: () => ({ path: stripes, width: SRC.w, height: SRC.h }), clipDir: join(dir, name) });
  await Bun.$`mkdir -p ${join(dir, name)}`.quiet();
  await runPass1(jobs);
  outputs.set(name, jobs[0]?.output ?? "");
}

beforeAll(async () => {
  dir = makeWorkDir("parity");
  stripes = await makeStripeJpeg(dir, "stripes", SRC.w, SRC.h, PERIOD_X, PERIOD_Y);
  for (const c of MOVING_CASES) {
    const clipId = `parity-${c.name.replace(" ", "-")}`;
    await render(c.name, photoClip(clipId, c.motion), planWhere(clipId, c.motion, c.pick).seed);
  }
  await render("static", photoClip("parity-static", "static"), 1);
  await render("collage2", collageClip("parity-collage"), planWhere("parity-collage", "kenburns", (p) => p.kind === "kenburns" && p.direction === "in").seed);
}, 180_000);

afterAll(() => {
  const sorted = [...deviations].sort((a, b) => a - b);
  const worst = sorted.at(-1) ?? 0;
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(`zoompan parity: ${sorted.length} windows measured, median ${median.toFixed(2)}, worst ${worst.toFixed(2)} canvas px (bound ${TOLERANCE})`);
  removeDir(dir);
});

/** Measures the window shown in `cell` of a decoded frame, in canvas pixels of that cell's canvas. */
function measure(frame: Uint8Array, cell: Rect, focus: Focus, predicted: Rect): Measured {
  const g = cellMotionGeometry({ w: cell.w, h: cell.h }, SRC, focus);
  const canvasEdges = (period: number, length: number, cropStart: number, cropLength: number, canvasLength: number): number[] =>
    stripeEdges(period, length)
      .filter((e) => e > cropStart && e < cropStart + cropLength)
      .map((e) => ((e - cropStart) * canvasLength) / cropLength);
  const ex = canvasEdges(PERIOD_X, SRC.w, g.crop.x, g.crop.w, g.canvas.w);
  const ey = canvasEdges(PERIOD_Y, SRC.h, g.crop.y, g.crop.h, g.canvas.h);
  const region = { x: cell.x, y: cell.y, w: cell.w, h: cell.h };
  const dx = edgePositions(horizontalDiff(frame, 1080, region), 8);
  const dy = edgePositions(verticalDiff(frame, 1080, region), 8);
  const margin = 8;
  const inside = (predict: (c: number) => number, length: number) => (c: number) => predict(c) > margin && predict(c) < length - margin;
  const predictX = (c: number): number => ((c - predicted.x) * cell.w) / predicted.w;
  const predictY = (c: number): number => ((c - predicted.y) * cell.h) / predicted.h;
  const fx = fitAxis(dx, ex.filter(inside(predictX, cell.w)), predictX, cell.w, 12);
  const fy = fitAxis(dy, ey.filter(inside(predictY, cell.h)), predictY, cell.h, 12);
  return { x: fx.start, y: fy.start, w: fx.length, h: fy.length };
}

function deviation(measured: Measured, want: Rect): number {
  return Math.max(Math.abs(measured.x - want.x), Math.abs(measured.y - want.y), Math.abs(measured.w - want.w), Math.abs(measured.h - want.h));
}

async function windowsFor(name: string, cell: Rect, focus: Focus, clip: Clip, seed: number): Promise<Array<{ frame: number; measured: Measured; want: Rect }>> {
  const path = outputs.get(name);
  if (!path) throw new Error(`no render for ${name}`);
  const g = cellMotionGeometry({ w: cell.w, h: cell.h }, SRC, focus);
  if (clip.kind === "video") throw new Error("no video clips here");
  const plan = clipMotionPlan(seed, clip);
  const frames = await extractFrames(path, SAMPLE_AT, "gray", { w: 1080, h: 1920 });
  return SAMPLE_AT.map((frame, i) => {
    const want = motionWindow(plan, g.canvas, g.anchor, frame, msToFrames(clip.durationMs));
    return { frame, measured: measure(frames[i] ?? new Uint8Array(), cell, focus, want), want };
  });
}

describe("zoompan parity on real pixels: a photo cell", () => {
  for (const c of MOVING_CASES) {
    test(`${c.name}: the window at frames ${SAMPLE_AT.join(", ")} is within 1 canvas pixel of motionWindow`, async () => {
      const clipId = `parity-${c.name.replace(" ", "-")}`;
      const { seed } = planWhere(clipId, c.motion, c.pick);
      const rows = await windowsFor(c.name, { x: 0, y: 0, w: 1080, h: 1920 }, FOCUS, photoClip(clipId, c.motion), seed);
      for (const row of rows) {
        const d = deviation(row.measured, row.want);
        deviations.push(d);
        expect({ frame: row.frame, ok: d <= TOLERANCE, d: Number(d.toFixed(2)) }).toEqual({ frame: row.frame, ok: true, d: Number(d.toFixed(2)) });
      }
    });
  }

  test("static: the whole canvas is shown, unzoomed and unshifted", async () => {
    const rows = await windowsFor("static", { x: 0, y: 0, w: 1080, h: 1920 }, FOCUS, photoClip("parity-static", "static"), 1);
    for (const row of rows) {
      const d = deviation(row.measured, row.want);
      deviations.push(d);
      expect(d).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  test("the last frame of a Ken Burns clip has reached its full zoom", async () => {
    const clipId = "parity-kenburns-in";
    const { seed, plan } = planWhere(clipId, "kenburns", (p) => p.kind === "kenburns" && p.direction === "in");
    const rows = await windowsFor("kenburns in", { x: 0, y: 0, w: 1080, h: 1920 }, FOCUS, photoClip(clipId, "kenburns"), seed);
    const last = rows.at(-1);
    const g = cellMotionGeometry({ w: 1080, h: 1920 }, SRC, FOCUS);
    expect(plan.zoomToPermille).toBe(1100);
    expect((last?.measured.w ?? 0) * 1.1).toBeCloseTo(g.canvas.w, -1);
  });
});

describe("zoompan parity on real pixels: the cells of a collage", () => {
  const rects = collageRects("collage2");
  const clipId = "parity-collage";
  const seed = planWhere(clipId, "kenburns", (p) => p.kind === "kenburns" && p.direction === "in").seed;

  test("the top cell's window (a 1080x954 crop with its own focus) is within 1 canvas pixel of motionWindow", async () => {
    const rows = await windowsFor("collage2", rects[0] ?? { x: 0, y: 0, w: 0, h: 0 }, FOCUS, collageClip(clipId), seed);
    for (const row of rows) {
      const d = deviation(row.measured, row.want);
      deviations.push(d);
      expect(d).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  test("the bottom cell's window, below the 12 px gutter, is within 1 canvas pixel of motionWindow", async () => {
    const rows = await windowsFor("collage2", rects[1] ?? { x: 0, y: 0, w: 0, h: 0 }, FOCUS_B, collageClip(clipId), seed);
    for (const row of rows) {
      const d = deviation(row.measured, row.want);
      deviations.push(d);
      expect(d).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});

describe("zoompan parity: the probe can tell a wrong window from the right one", () => {
  test("a pan measured against the opposite pan's windows is many pixels off", async () => {
    const right = MOVING_CASES.find((c) => c.name === "pan right");
    const left = MOVING_CASES.find((c) => c.name === "pan left");
    if (!right || !left) throw new Error("missing case");
    const clipId = "parity-pan-right";
    const { seed } = planWhere(clipId, "pan", right.pick);
    const path = outputs.get("pan right") ?? "";
    const g = cellMotionGeometry({ w: 1080, h: 1920 }, SRC, FOCUS);
    const wrongPlan = motionPlan(planWhere("parity-pan-left", "pan", left.pick).seed, "parity-pan-left", "pan");
    const frames = await extractFrames(path, [0, FRAMES - 1], "gray", { w: 1080, h: 1920 });
    // Frame 0 of a right pan sits at the left edge, frame 119 at the right; the opposite pan is the mirror.
    const wrongAtStart = motionWindow(wrongPlan, g.canvas, g.anchor, 0, FRAMES);
    const rightPlan = clipMotionPlan(seed, photoClip(clipId, "pan"));
    const rightAtStart = motionWindow(rightPlan, g.canvas, g.anchor, 0, FRAMES);
    const measured = measure(frames[0] ?? new Uint8Array(), { x: 0, y: 0, w: 1080, h: 1920 }, FOCUS, rightAtStart);
    expect(deviation(measured, rightAtStart)).toBeLessThanOrEqual(TOLERANCE);
    expect(deviation(measured, wrongAtStart)).toBeGreaterThan(100);
  });
});
