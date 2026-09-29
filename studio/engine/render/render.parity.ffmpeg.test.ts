import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { exiftool } from "exiftool-vendored";
import type { Clip, Focus } from "../../shared/engine/montage";
import { cellMotionGeometry, clipMotionPlan, collageRects, msToFrames, type Rect } from "../../shared/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { edgePositions, extractFrames, runFfmpegOk, fitAxis, horizontalDiff, makeStripeJpeg, stripeEdges, verticalDiff } from "./ffmpeg.testkit";
import { buildPass1 } from "./pass1";
import { MOVING_CASES, planWhere } from "./plans.testkit";
import { makeWorkDir, removeDir, runPass1 } from "./render.testkit";
import { zoompanFilter, type MovingMotionPlan } from "./zoompan";
import { zoompanWindow, type ModelWindow } from "./zoompanModel.testkit";
useNativeGlobals();

// ZOOMPAN PARITY, measured on real pixels. The preview draws the window
// `motionWindow` computes; the render must show the same window. Two links:
//
// 1. `zoompan.test.ts` (no ffmpeg): the zoompan expressions, through an
//    explicit model of ffmpeg (size truncated, position snapped down to even),
//    give a window within 1 canvas pixel of `motionWindow`.
// 2. THIS file: real frames match that model to 0.4 canvas pixel, so the model
//    is what ffmpeg does, on this build and on the Windows build in CI.
//
// The probe:
// - the source is a 720x1280 JPEG of luma stripes (period 40 px both ways),
//   additively separable, so its edges sit at known source pixels and any
//   linear resampler keeps the x edges and the y edges independent;
// - the clip goes through the REAL pass-1 graph (colour chain, cover-crop,
//   4x lanczos canvas, zoompan, encode);
// - on a decoded frame, each stripe edge is located to sub-pixel accuracy
//   (the centroid of the luma step), and a least-squares line through
//   `output position = a * canvas position + b` gives the window: its length
//   is `outLength / a` and its start is `-b / a`, in CANVAS pixels.
//
// A control proves the probe can tell frames apart: a clip measured against
// the model one frame early or late must be more than 2 px off.

const PERIOD_X = 40;
const PERIOD_Y = 40;
const SRC = { w: 720, h: 1280 };
const FRAMES = 60; // 2 s (S14: clips of at most 2 s)
/** Sampled away from the ends too, where a one-frame shift is still a visible motion. */
const SAMPLE_AT = [0, 15, 30, 45, FRAMES - 1];
/** The measurement's noise: 0.1 to 0.3 px measured; real frames must sit this close to the model. */
const TOLERANCE = 0.4;
/** A model one frame off must miss by more than this. */
const SHIFT_MISS = 2;
const FOCUS: Focus = { x: 0.3, y: 0.6 };
const FOCUS_B: Focus = { x: 0.7, y: 0.2 };
const FULL: Rect = { x: 0, y: 0, w: 1080, h: 1920 };

let dir: string;
let stripes: string;
const outputs = new Map<string, string>();
const deviations: number[] = [];

const photoClip = (clipId: string, motion: "kenburns" | "pan" | "static"): Clip => ({
  clipId,
  durationMs: 2000,
  transitionIn: "cut",
  kind: "photo",
  cell: { photo: { source: "scene", photoId: "stripes" }, focus: FOCUS },
  motion,
});

const collageClip = (clipId: string): Extract<Clip, { kind: "collage" }> => ({
  clipId,
  durationMs: 2000,
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

async function render(name: string, clip: Clip, seed: number, photo: string = stripes): Promise<void> {
  const jobs = buildPass1({ seed, clips: [clip], resolvePhoto: () => ({ path: photo, width: SRC.w, height: SRC.h }), clipDir: join(dir, name) });
  await Bun.$`mkdir -p ${join(dir, name)}`.quiet();
  await runPass1(jobs);
  outputs.set(name, jobs[0]?.output ?? "");
}

const collageSeed = (): number => planWhere("parity-collage", "kenburns", (p) => p.kind === "kenburns" && p.direction === "in").seed;
const caseClipId = (name: string): string => `parity-${name.replace(" ", "-")}`;

beforeAll(async () => {
  dir = makeWorkDir("parity");
  stripes = await makeStripeJpeg(dir, "stripes", SRC.w, SRC.h, PERIOD_X, PERIOD_Y);
  for (const c of MOVING_CASES) await render(c.name, photoClip(caseClipId(c.name), c.motion), planWhere(caseClipId(c.name), c.motion, c.pick).seed);
  await render("static", photoClip("parity-static", "static"), 1);
  await render("collage2", collageClip("parity-collage"), collageSeed());

  // The same stripes with EXIF Orientation 6 (rotate 90): STORED as 720x1280, tagged as if it should show as 1280x720.
  const oriented = join(dir, "oriented.jpg");
  copyFileSync(stripes, oriented);
  await exiftool.write(oriented, { Orientation: 6 }, { writeArgs: ["-n", "-overwrite_original"] });
  await render("oriented-collage2", collageClip("parity-collage"), collageSeed(), oriented);
}, 180_000);

afterAll(() => {
  const sorted = [...deviations].sort((a, b) => a - b);
  const worst = sorted.at(-1) ?? 0;
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(`zoompan parity vs the ffmpeg model: ${sorted.length} windows measured, median ${median.toFixed(2)}, worst ${worst.toFixed(2)} canvas px (bound ${TOLERANCE})`);
  removeDir(dir);
});

/** Measures the window shown in `cell` of a decoded frame, in canvas pixels of that cell's canvas. `predicted` only pairs edges up. */
function measure(frame: Uint8Array, cell: Rect, focus: Focus, predicted: ModelWindow): ModelWindow {
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

function deviation(a: ModelWindow, b: ModelWindow): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
}

interface Row {
  readonly frame: number;
  readonly measured: ModelWindow;
  /** What ffmpeg's zoompan should show at `frame` (`modelAt(frame)`), and at any other frame. */
  readonly model: ModelWindow;
  readonly modelAt: (frame: number) => ModelWindow;
}

async function windowsFor(name: string, cell: Rect, focus: Focus, clip: Clip, seed: number): Promise<Row[]> {
  const path = outputs.get(name);
  if (!path) throw new Error(`no render for ${name}`);
  if (clip.kind === "video") throw new Error("no video clips here");
  const g = cellMotionGeometry({ w: cell.w, h: cell.h }, SRC, focus);
  const plan = clipMotionPlan(seed, clip);
  const frames = msToFrames(clip.durationMs);
  const filter = plan.kind === "static" ? undefined : zoompanFilter(plan, g.canvas, g.anchor, frames, { w: cell.w, h: cell.h });
  const modelAt = (frame: number): ModelWindow => (filter === undefined ? { x: 0, y: 0, ...g.canvas } : zoompanWindow(filter, g.canvas, frame));
  const decoded = await extractFrames(path, SAMPLE_AT, "gray", { w: 1080, h: 1920 });
  return SAMPLE_AT.map((frame, i) => ({ frame, measured: measure(decoded[i] ?? new Uint8Array(), cell, focus, modelAt(frame)), model: modelAt(frame), modelAt }));
}

function expectOnModel(rows: readonly Row[]): void {
  for (const row of rows) {
    const d = deviation(row.measured, row.model);
    deviations.push(d);
    expect({ frame: row.frame, ok: d <= TOLERANCE, d: Number(d.toFixed(2)) }).toEqual({ frame: row.frame, ok: true, d: Number(d.toFixed(2)) });
  }
}

describe("zoompan parity on real pixels: a photo cell matches the ffmpeg model to 0.4 canvas pixel", () => {
  for (const c of MOVING_CASES) {
    test(`${c.name}: the window at frames ${SAMPLE_AT.join(", ")}`, async () => {
      expectOnModel(await windowsFor(c.name, FULL, FOCUS, photoClip(caseClipId(c.name), c.motion), planWhere(caseClipId(c.name), c.motion, c.pick).seed));
    });
  }

  test("static: the whole canvas is shown, unzoomed and unshifted", async () => {
    expectOnModel(await windowsFor("static", FULL, FOCUS, photoClip("parity-static", "static"), 1));
  });

  test("the last frame of a Ken Burns clip has reached its full zoom", async () => {
    const clipId = caseClipId("kenburns in");
    const { seed, plan } = planWhere(clipId, "kenburns", (p) => p.kind === "kenburns" && p.direction === "in");
    const rows = await windowsFor("kenburns in", FULL, FOCUS, photoClip(clipId, "kenburns"), seed);
    const g = cellMotionGeometry({ w: 1080, h: 1920 }, SRC, FOCUS);
    expect(plan.zoomToPermille).toBe(1100);
    expect((rows.at(-1)?.measured.w ?? 0) * 1.1).toBeCloseTo(g.canvas.w, -1);
  });
});

describe("zoompan parity on real pixels: the cells of a collage match the model to 0.4 canvas pixel", () => {
  const rects = collageRects("collage2");

  test("the top cell (a 1080x954 crop with its own focus)", async () => {
    expectOnModel(await windowsFor("collage2", rects[0] ?? FULL, FOCUS, collageClip("parity-collage"), collageSeed()));
  });

  test("the bottom cell, below the 12 px gutter", async () => {
    expectOnModel(await windowsFor("collage2", rects[1] ?? FULL, FOCUS_B, collageClip("parity-collage"), collageSeed()));
  });
});

describe("zoompan parity: the probe can tell one frame from the next", () => {
  for (const c of MOVING_CASES) {
    test(`${c.name}: measured against the model one frame early or late, the window is more than 2 canvas pixels off`, async () => {
      const rows = await windowsFor(c.name, FULL, FOCUS, photoClip(caseClipId(c.name), c.motion), planWhere(caseClipId(c.name), c.motion, c.pick).seed);
      for (const row of rows) {
        // An interior frame: both neighbours exist.
        if (row.frame === 0 || row.frame === FRAMES - 1) continue;
        expect({ frame: row.frame, early: deviation(row.measured, row.modelAt(row.frame - 1)) > SHIFT_MISS, late: deviation(row.measured, row.modelAt(row.frame + 1)) > SHIFT_MISS }).toEqual({
          frame: row.frame,
          early: true,
          late: true,
        });
      }
    });
  }
});

describe("stored orientation (EXIF Orientation 6 fixture), M3", () => {
  test("a collage cell of a JPEG tagged Orientation 6 is cropped and moved by its STORED geometry, like the same photo untagged", async () => {
    const rects = collageRects("collage2");
    for (const [cell, focus] of [[rects[0] ?? FULL, FOCUS], [rects[1] ?? FULL, FOCUS_B]] as const) {
      expectOnModel(await windowsFor("oriented-collage2", cell, focus, collageClip("parity-collage"), collageSeed()));
    }
  });

  test("the pass-1 argv carries -noautorotate, and without it the same file would be drawn rotated: the probe fails", async () => {
    const jobs = buildPass1({ seed: collageSeed(), clips: [collageClip("parity-collage")], resolvePhoto: () => ({ path: join(dir, "oriented.jpg"), width: SRC.w, height: SRC.h }), clipDir: join(dir, "no-noautorotate") });
    const job = jobs[0];
    if (!job) throw new Error("no job");
    expect(job.argv).toContain("-noautorotate");
    await Bun.$`mkdir -p ${join(dir, "no-noautorotate")}`.quiet();
    // An autorotated 1280x720 picture under a crop for a 720x1280 one: ffmpeg may fail outright or draw the wrong pixels.
    const outcome = await runFfmpegOk(job.argv.filter((a) => a !== "-noautorotate")).then(
      () => "rendered" as const,
      () => "failed" as const,
    );
    if (outcome === "failed") return;
    const cell = collageRects("collage2")[0] ?? FULL;
    const g = cellMotionGeometry({ w: cell.w, h: cell.h }, SRC, FOCUS);
    const filter = zoompanFilter(movingPlan(), g.canvas, g.anchor, msToFrames(2000), { w: cell.w, h: cell.h });
    const model = zoompanWindow(filter, g.canvas, 0);
    const frame = (await extractFrames(job.output, [0], "gray", { w: 1080, h: 1920 }))[0] ?? new Uint8Array();
    let miss = Number.POSITIVE_INFINITY; // no edges matching at all is certainly not the stored picture
    try {
      miss = deviation(measure(frame, cell, FOCUS, model), model);
    } catch {
      miss = Number.POSITIVE_INFINITY;
    }
    expect(miss).toBeGreaterThan(10);
  });
});

function movingPlan(): MovingMotionPlan {
  const plan = clipMotionPlan(collageSeed(), collageClip("parity-collage"));
  if (plan.kind === "static") throw new Error("kenburns is not static");
  return plan;
}
