import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { PhotoExecutor } from "./photoExecutor";
import { createBackends, resolveEdge, routeForKind, uniquifyRoute } from "./mediaRoute";
import { makeTestPhoto, makeTestStory, STORY_EDGE_MARKS } from "./testClip";
import type { EdgeMode, StartOptions } from "../core/types";
import type { ResolvedEdge } from "../core/photo/types";

/**
 * The defect this whole slice exists for, end to end on a story-shaped still.
 *
 * A real 1080x1920 story came back reading "NEVER GONNA MAKE I" where the
 * original said "NEVER GONNA MAKE IT." — at a PDQ distance of 54, with every
 * check passing, because a hash distance cannot see that a word lost its last
 * letter. So the check that matters here is not the distance: it is whether the
 * picture that went in is still the picture that came out.
 *
 * Run in all three modes off one fixture, so the test states the defect and the
 * fix together. Crop is not a control that happens to pass — it is the failure,
 * pinned, and fit has to differ from it.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const W = 1080;
const H = 1920;
const TARGET = 38;
const COPIES = 6;
const SEED_BASE = 9000;
const NOW = 1_780_000_000_000;

/** Half-width of the box a mark is looked for in, as a frame fraction. The
 *  window may move the picture by up to (1 - 0.88) of the frame at the safety
 *  ceiling, so 0.09 covers every placement the sampler can draw. */
const MARK_SLACK = 0.09;

/** A mark is white on black; anything this bright in its box is the mark and
 *  not the vignette, the noise or the JPEG. */
const MARK_BRIGHT = 128;

/** A block of pure background: clear of all four marks, clear of the centre
 *  block at every placement the window can draw, and clear of the padding,
 *  which sits against an edge. What is left acting on it is the recipe. */
const BACKGROUND_BOX = { x: 60, y: 150, w: 300, h: 300 };

interface Measured {
  index: number;
  distance: number;
  passed: boolean;
  width: number;
  height: number;
  backgroundMean: number;
  backgroundMax: number;
  markCounts: number[];
}

function grayFull(path: string): Uint8Array {
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", path, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 28 }
  );
  if (r.status !== 0) throw new Error(`gray read failed: ${r.stderr.toString().slice(-300)}`);
  return new Uint8Array(r.stdout.subarray(0, W * H));
}

/** Bright pixels within `MARK_SLACK` of where a mark started out. */
function markCount(g: Uint8Array, mx: number, my: number): number {
  const x0 = Math.max(0, Math.round((mx - MARK_SLACK) * W));
  const x1 = Math.min(W - 1, Math.round((mx + MARK_SLACK) * W));
  const y0 = Math.max(0, Math.round((my - MARK_SLACK) * H));
  const y1 = Math.min(H - 1, Math.round((my + MARK_SLACK) * H));
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) if (g[y * W + x] >= MARK_BRIGHT) n++;
  }
  return n;
}

/** Mean and peak of the background block — the statistics the defect was found
 *  with. A frame-wide minimum proves nothing here: the vignette darkens the
 *  corners and the centre block has black in it, so a lifted background would
 *  still read 0. */
function background(g: Uint8Array): { mean: number; max: number } {
  const { x, y, w, h } = BACKGROUND_BOX;
  let sum = 0;
  let max = 0;
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      const v = g[j * W + i];
      sum += v;
      if (v > max) max = v;
    }
  }
  return { mean: sum / (w * h), max };
}

const exec = new PhotoExecutor();
let dir: string;
let story: string;
let photograph: string;
let sourceMarks: number[];
const runs = new Map<EdgeMode, Measured[]>();
let photographEdge: ResolvedEdge;

const base: StartOptions = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  targetDistance: TARGET,
  spoofMetadata: false,
  edgeMode: "auto",
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-story-"));
  story = join(dir, "story.png");
  photograph = join(dir, "photo.jpg");
  makeTestStory(story, W, H);
  makeTestPhoto(photograph, 1440, 1080);

  sourceMarks = STORY_EDGE_MARKS.map((m) => markCount(grayFull(story), m.x, m.y));

  for (const edgeMode of ["auto", "crop", "fit"] as const) {
    const route = routeForKind("photo", createBackends());
    const results = await uniquifyRoute(route, story, { ...base, edgeMode }, COPIES, {
      seedBase: SEED_BASE,
      nowMs: NOW,
      outputPath: (i) => join(dir, `${edgeMode}_${i + 1}.jpg`),
    });
    const perCopy: Measured[] = [];
    for (const r of results) {
      const g = grayFull(r.outputPath);
      // Read back off the file, not assumed from the source: "the copy is the
      // same size" is the claim, so it has to be measured.
      const info = await exec.probe(r.outputPath);
      perCopy.push({
        index: r.index,
        distance: r.verify.minDistance,
        passed: r.verify.passed,
        width: info.width,
        height: info.height,
        backgroundMean: background(g).mean,
        backgroundMax: background(g).max,
        markCounts: STORY_EDGE_MARKS.map((m) => markCount(g, m.x, m.y)),
      });
    }
    runs.set(edgeMode, perCopy);
  }

  photographEdge = await resolveEdge(exec, photograph, "auto");

  const fit = runs.get("fit") ?? [];
  const crop = runs.get("crop") ?? [];
  console.log(
    `[story-e2e] target=${TARGET} fit=${fit.map((m) => m.distance).join(",")} ` +
      `crop=${crop.map((m) => m.distance).join(",")} ` +
      `bg=${[...runs.values()].flat().map((m) => m.backgroundMean.toFixed(2)).join(",")} ` +
      `fitMarks=${fit.map((m) => m.markCounts.join("/")).join(" ")} ` +
      `cropMarks=${crop.map((m) => m.markCounts.join("/")).join(" ")} ` +
      `sourceMarks=${sourceMarks.join("/")}`
  );
}, 600_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const measured = (mode: EdgeMode): Measured[] => {
  const m = runs.get(mode);
  if (!m) throw new Error(`no ${mode} run`);
  return m;
};

test("auto preserves the edges of a story on a flat background", () => {
  // Stated against the picture first, then against the explicit mode. Comparing
  // auto to fit alone would be satisfied by both of them cropping.
  for (const m of measured("auto")) {
    for (let i = 0; i < m.markCounts.length; i++) {
      expect(m.markCounts[i]).toBeGreaterThan(sourceMarks[i] * 0.75);
    }
  }
  expect(measured("auto").map((m) => m.distance)).toEqual(measured("fit").map((m) => m.distance));
  expect(measured("auto").map((m) => m.markCounts.join("/"))).toEqual(
    measured("fit").map((m) => m.markCounts.join("/"))
  );
});

test("auto keeps cropping a photograph, whose padding would show", () => {
  // The other side of the decision, on a real decode rather than a synthetic
  // buffer: a detailed frame has no flat border to hide a pad against.
  expect(photographEdge.mode).toBe("crop");
});

test("every padded copy clears the PDQ target against the original", () => {
  for (const m of measured("fit")) {
    expect(m.passed).toBe(true);
    expect(m.distance).toBeGreaterThanOrEqual(TARGET);
  }
});

test("every padded copy is exactly the size of the source", () => {
  for (const m of measured("fit")) {
    expect(m.width).toBe(W);
    expect(m.height).toBe(H);
  }
});

test("padding keeps every mark that sits at the frame edge", () => {
  // The whole point. A mark shrinks with the picture — scalePct is never below
  // 0.88, so the area is never below ~0.77 of the source — but none of it goes.
  for (const m of measured("fit")) {
    for (let i = 0; i < m.markCounts.length; i++) {
      expect(m.markCounts[i]).toBeGreaterThan(sourceMarks[i] * 0.75);
    }
  }
});

test("padding shrinks the picture and never enlarges it", () => {
  // Cropping magnifies whatever survives, which is how a mark can come back
  // LARGER than it started while a neighbouring one has been cut in half.
  for (const m of measured("fit")) {
    for (let i = 0; i < m.markCounts.length; i++) {
      expect(m.markCounts[i]).toBeLessThanOrEqual(sourceMarks[i]);
    }
  }
});

test("cropping destroys a mark at the frame edge — the defect being fixed", () => {
  // Pinned, not tolerated. If this ever stops failing to preserve the picture,
  // either the fixture stopped reaching the edge or the crop window stopped
  // being off-centre, and the fit mode above would be proving nothing.
  const worst = Math.min(...measured("crop").flatMap((m) => m.markCounts));
  expect(worst).toBeLessThan(sourceMarks[0] * 0.5);
});

test("cropping still passes the hash check while doing it", () => {
  // Why a distance cannot be the whole test: the damaged copies are all "fine".
  for (const m of measured("crop")) expect(m.passed).toBe(true);
});

/**
 * The background the original had at 0.00 came back at mean 7.07 on a real
 * copy. On the AMOLED screen a story is read on, a black pixel is an unlit
 * pixel and 7/255 glows.
 *
 * Three terms could do it, and only one of them was obvious:
 *
 *   `brightness` is additive and shifts the whole scale including zero —
 *     5/255 at 0.03, 43/255 at its old 0.15 ceiling. Removed outright.
 *   `contrast` is multiplicative about MID-GREY, so the floor becomes
 *     (0 - 0.5)*c + 0.5 and any c < 1 lifts it — 24/255 at the old 0.8 floor,
 *     worse than the brightness it sat beside. Now drawn one-sided, 1.0..1.25.
 *   `gamma` likewise — 13/255 at 1.25, 0 at 0.8. Now drawn one-sided, 0.8..1.0.
 *
 * Each safe bound holds by arithmetic, not by measurement: (0 - 0.5)*c + 0.5
 * is <= 0 for every c >= 1. So this is a functional confirmation that the
 * arithmetic reaches the rendered file intact — through the geometry, the
 * vignette, the spatial noise and the JPEG — and the guard against a lever
 * wandering back across its neutral point lives in the sampler test, where it
 * cannot be satisfied by a lucky batch of seeds.
 */
test("the background of every copy is still exactly black", () => {
  for (const mode of ["fit", "crop"] as const) {
    for (const m of measured(mode)) {
      expect(m.backgroundMean).toBe(0);
      expect(m.backgroundMax).toBe(0);
    }
  }
});

test("the source's own background is exactly black, so the bound means something", () => {
  // Without this the test above would also pass on a fixture that was never
  // black to begin with.
  const src = background(grayFull(story));
  expect(src.mean).toBe(0);
  expect(src.max).toBe(0);
});
