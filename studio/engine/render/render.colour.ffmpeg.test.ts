import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { extractFrames } from "./ffmpeg.testkit";
import { buildPass1 } from "./pass1";
import { buildPass2 } from "./pass2";
import { OVERLAY_COLOUR_CHAIN, PHOTO_COLOUR_CHAIN } from "./profile";
import {
  CHART_BLOCK_L,
  CHART_BLOCK_R,
  CHART_GRID,
  STICKER_COLOURS,
  STICKER_H,
  STICKER_W,
  expectedBt709Limited,
  makeChartJpeg,
  makeStickerPng,
  makeWorkDir,
  meanAround,
  mixRgb,
  removeDir,
  runPass1,
  runPass2,
  splitYuv420,
  tamperGraph,
  type RGB,
} from "./render.testkit";
useNativeGlobals();

// INVARIANT 36, colour and fidelity, on real ffmpeg. A chart of 24 patches
// (a full-range BT.601 JPEG, like a camera's) with a coloured RGBA sticker
// over it goes through BOTH passes, and the finished frame is decoded WITHOUT
// any colour conversion (raw yuv420p planes). Each patch mean is compared with
// the limited-range BT.709 Y'CbCr computed from the patch's RGB.
//
// Tolerances (plan): photo patches within 2 code values of expected (Y, Cb and
// Cr), the opaque sticker within 1. The alpha-128 sticker row is blended over
// the block below it and is held to 2 like the photo. SP1 measured 0.96 / 1.60
// / 1.54 for the photo and 0.48 for the opaque sticker.
//
// NEGATIVE CONTROLS: the same check on the two known traps must FAIL its
// tolerance, which proves the test can catch a regression. The traps are
// made from the builder's own output by swapping the explicit chain for the
// naive one:
// - the sticker left to the auto scaler (`format=yuva420p` only): 14.6 codes off;
// - the photo through a bare `format=yuv420p`: 27.6 codes off.

const PHOTO_TOLERANCE = 2;
const OPAQUE_STICKER_TOLERANCE = 1;
const ALPHA_STICKER_TOLERANCE = 2;
const STICKER_AT = { x: 70, y: 1500 };

let dir: string;
let chart: string;
let sticker: string;

interface Deviation {
  readonly Y: number;
  readonly Cb: number;
  readonly Cr: number;
}
interface ChartResult {
  readonly photo: Deviation;
  readonly opaque: Deviation;
  readonly alpha: Deviation;
}
const results = new Map<string, ChartResult>();

const worstOf = (d: Deviation): number => Math.max(d.Y, d.Cb, d.Cr);

/** The pass-1 clip: the chart shown static for one second, with no focus (the fallback). */
const chartClip: Clip = {
  clipId: "chart",
  durationMs: 1000,
  transitionIn: "cut",
  kind: "photo",
  cell: { photo: { source: "scene", photoId: "chart" }, focus: null },
  motion: "static",
};

function maxDeviation(planes: ReturnType<typeof splitYuv420>, patches: ReadonlyArray<{ x: number; y: number; rgb: RGB }>): Deviation {
  let Y = 0;
  let Cb = 0;
  let Cr = 0;
  for (const p of patches) {
    const [ey, ecb, ecr] = expectedBt709Limited(p.rgb);
    Y = Math.max(Y, Math.abs(meanAround(planes.y, 1080, p.x, p.y, 10) - ey));
    Cb = Math.max(Cb, Math.abs(meanAround(planes.u, 540, p.x / 2, p.y / 2, 4) - ecb));
    Cr = Math.max(Cr, Math.abs(meanAround(planes.v, 540, p.x / 2, p.y / 2, 4) - ecr));
  }
  return { Y, Cb, Cr };
}

/** The patches whose Y, Cb or Cr is more than `over` code values off, for the log (which patch drifts on a build). */
function driftingPatches(planes: ReturnType<typeof splitYuv420>, patches: ReadonlyArray<{ x: number; y: number; rgb: RGB }>, over: number): string[] {
  return patches.flatMap((p) => {
    const [ey, ecb, ecr] = expectedBt709Limited(p.rgb);
    const dy = meanAround(planes.y, 1080, p.x, p.y, 10) - ey;
    const dcb = meanAround(planes.u, 540, p.x / 2, p.y / 2, 4) - ecb;
    const dcr = meanAround(planes.v, 540, p.x / 2, p.y / 2, 4) - ecr;
    return Math.max(Math.abs(dy), Math.abs(dcb), Math.abs(dcr)) > over ? [`rgb(${p.rgb.join(",")}) at ${Math.round(p.x)},${Math.round(p.y)}: dY ${dy.toFixed(2)} dCb ${dcb.toFixed(2)} dCr ${dcr.toFixed(2)}`] : [];
  });
}

const PHOTO_PATCHES: ReadonlyArray<{ x: number; y: number; rgb: RGB }> = [
  ...CHART_GRID.map((rgb, i) => ({ x: ((i % 4) + 0.5) * 270, y: (Math.floor(i / 4) + 0.5) * 240, rgb })),
  { x: 270, y: 1460, rgb: CHART_BLOCK_L },
  { x: 810, y: 1680, rgb: CHART_BLOCK_R },
];
const OPAQUE_PATCHES = STICKER_COLOURS.map((rgb, i) => ({ x: STICKER_AT.x + 50 + 100 * i, y: STICKER_AT.y + 50, rgb }));
const ALPHA_PATCHES = STICKER_COLOURS.map((c, i) => ({ x: STICKER_AT.x + 50 + 100 * i, y: STICKER_AT.y + 150, rgb: mixRgb(c, CHART_BLOCK_L, 128 / 255) }));

/** Renders the chart plus sticker through both passes, optionally with a trap swapped in, and measures the frame. */
async function renderAndMeasure(name: string, trap: { photo?: boolean; sticker?: boolean }): Promise<ChartResult> {
  const work = join(dir, name);
  await Bun.$`mkdir -p ${work}`.quiet();
  const jobs = buildPass1({ seed: 1, clips: [chartClip], resolvePhoto: () => ({ path: chart, width: 720, height: 1280 }), clipDir: work });
  const job = jobs[0];
  if (!job) throw new Error("no pass-1 job");
  const argv = trap.photo ? tamperGraph(job.argv, PHOTO_COLOUR_CHAIN, "format=yuv420p") : job.argv;
  await runPass1([{ ...job, argv }]);

  const output = join(work, "final.mp4");
  const pass2 = buildPass2({
    clips: [chartClip],
    clipDir: work,
    output,
    overlays: [{ path: sticker, format: "png", box: { x: STICKER_AT.x, y: STICKER_AT.y, w: STICKER_W, h: STICKER_H }, resize: false, startFrame: 0, endFrame: 30 }],
    audio: { kind: "silent" },
  });
  await runPass2({ ...pass2, argv: trap.sticker ? tamperGraph(pass2.argv, OVERLAY_COLOUR_CHAIN, "format=yuva420p") : pass2.argv });

  const [frame] = await extractFrames(output, [0], "yuv420p", { w: 1080, h: 1920 });
  const planes = splitYuv420(frame ?? new Uint8Array(), 1080, 1920);
  if (name === "explicit") console.log(`colour, explicit chain, photo patches over 1.2 codes:\n  ${driftingPatches(planes, PHOTO_PATCHES, 1.2).join("\n  ")}`);
  return { photo: maxDeviation(planes, PHOTO_PATCHES), opaque: maxDeviation(planes, OPAQUE_PATCHES), alpha: maxDeviation(planes, ALPHA_PATCHES) };
}

beforeAll(async () => {
  dir = makeWorkDir("colour");
  chart = await makeChartJpeg(dir, "chart");
  sticker = await makeStickerPng(dir, "sticker");
  results.set("explicit", await renderAndMeasure("explicit", {}));
  results.set("sticker-trap", await renderAndMeasure("sticker-trap", { sticker: true }));
  results.set("photo-trap", await renderAndMeasure("photo-trap", { photo: true }));
}, 180_000);

afterAll(() => {
  const fmt = (d?: Deviation): string => (d ? `Y ${d.Y.toFixed(2)} Cb ${d.Cb.toFixed(2)} Cr ${d.Cr.toFixed(2)}` : "n/a");
  const e = results.get("explicit");
  console.log(`colour, explicit chain: photo ${fmt(e?.photo)} | opaque sticker ${fmt(e?.opaque)} | alpha-128 sticker ${fmt(e?.alpha)}`);
  console.log(`colour, sticker trap: opaque sticker ${fmt(results.get("sticker-trap")?.opaque)}; photo trap: photo ${fmt(results.get("photo-trap")?.photo)}`);
  removeDir(dir);
});

const result = (name: string): ChartResult => {
  const r = results.get(name);
  if (!r) throw new Error(`no result for ${name}`);
  return r;
};

describe("colour on real ffmpeg: the explicit chains (invariant 36)", () => {
  test("every photo patch is within 2 code values of limited-range BT.709 in Y, Cb and Cr", () => {
    expect(worstOf(result("explicit").photo)).toBeLessThanOrEqual(PHOTO_TOLERANCE);
  });

  test("the opaque sticker is within 1 code value of limited-range BT.709", () => {
    expect(worstOf(result("explicit").opaque)).toBeLessThanOrEqual(OPAQUE_STICKER_TOLERANCE);
  });

  test("the alpha-128 sticker, blended over the block under it, is within 2 code values", () => {
    expect(worstOf(result("explicit").alpha)).toBeLessThanOrEqual(ALPHA_STICKER_TOLERANCE);
  });
});

describe("colour on real ffmpeg: negative controls, the two known traps must fail the tolerance", () => {
  test("a sticker left to the auto scaler misses the opaque tolerance by a wide margin (SP1: 14.6 codes)", () => {
    const worst = worstOf(result("sticker-trap").opaque);
    // macOS 6.0 and Windows 6.1.1 (the builds Studio ships) convert an untagged RGBA sticker with BT.601 and drift.
    // The Linux ffmpeg of the CI canary does not: its auto scaler is already right, so there is no trap to catch there.
    if (process.platform === "linux" && worst <= OPAQUE_STICKER_TOLERANCE) {
      console.log("colour: this Linux ffmpeg's auto scaler already converts the sticker correctly; the sticker trap control does not apply");
      return;
    }
    expect(worst).toBeGreaterThan(OPAQUE_STICKER_TOLERANCE);
    expect(worst).toBeGreaterThan(5);
  });

  test("a photo through a bare format=yuv420p misses the photo tolerance by a wide margin (SP1: 27.6 codes)", () => {
    const worst = worstOf(result("photo-trap").photo);
    expect(worst).toBeGreaterThan(PHOTO_TOLERANCE);
    expect(worst).toBeGreaterThan(10);
  });

  test("the sticker trap leaves the photo patches alone, so the two controls test different things", () => {
    expect(worstOf(result("sticker-trap").photo)).toBeLessThanOrEqual(PHOTO_TOLERANCE);
  });

  test("the photo trap leaves the opaque sticker alone", () => {
    expect(worstOf(result("photo-trap").opaque)).toBeLessThanOrEqual(OPAQUE_STICKER_TOLERANCE);
  });
});
