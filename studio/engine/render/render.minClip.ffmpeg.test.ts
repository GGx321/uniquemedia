import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { collageRects, MIN_CLIP_MS, totalFrames } from "../../shared/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { frameTimesMs, probeVideo, videoFrames } from "./ffmpeg.testkit";
import { buildPass1 } from "./pass1";
import { buildPass2 } from "./pass2";
import { lumaPerFrame, makeSolid, makeWorkDir, removeDir, runPass1, runPass2 } from "./render.testkit";
useNativeGlobals();

// REAL ffmpeg, both passes: the shortest clip the contract allows (100 ms, 3 frames) is rendered inside a 4 s montage of
// the shortest length. Every clip kind and motion is there at 100 ms; the montage must hold exactly 120 frames. A collage of
// four at 100 ms has a 0-frame stagger step (ffmpeg's `fade` refuses n=0), so its cells must all be on screen at once, and
// a 500 ms collage in the same montage is the control that the luma probe tells a hidden cell from a shown one.

const scene = (id: string) => ({ photo: { source: "scene" as const, photoId: id }, focus: { x: 0.5, y: 0.38 } });
const cells = (n: number) => Array.from({ length: n }, (_, k) => scene(`p-${k}`));
const photo = (clipId: string, durationMs: number, motion: "kenburns" | "pan" | "static"): Clip => ({ clipId, durationMs, transitionIn: "cut", kind: "photo", cell: scene("p-0"), motion });
const collage = (clipId: string, layout: "collage2" | "collage4", durationMs: number, stagger: boolean): Clip => ({
  clipId,
  durationMs,
  transitionIn: "cut",
  kind: "collage",
  layout,
  cells: cells(layout === "collage2" ? 2 : 4),
  motion: "kenburns",
  stagger,
});

// Frames: 0-2 photo (Ken Burns), 3-5 collage 4, 6-8 collage 2, 9-11 photo (pan), 12-14 photo (static), 15-29 the 500 ms collage 4 control, 30-119 the rest.
const CLIPS: Clip[] = [
  photo("kb", MIN_CLIP_MS, "kenburns"),
  collage("c4", "collage4", MIN_CLIP_MS, true),
  collage("c2", "collage2", MIN_CLIP_MS, true),
  photo("pan", MIN_CLIP_MS, "pan"),
  photo("static", MIN_CLIP_MS, "static"),
  collage("c4-control", "collage4", 500, true),
  photo("rest", 3_000, "kenburns"),
];
const EXPECTED_FRAMES = 120; // 4 s at 30 fps
const SHORT_CLIPS = 5;

let dir: string;
let output: string;
let frameCounts: number[];
let lumaOfCell: (layout: "collage2" | "collage4", cell: number) => number[];
const lumas = new Map<string, number[]>();

beforeAll(async () => {
  dir = makeWorkDir("minclip");
  const white = join(dir, "white.jpg");
  await makeSolid(white, "white", 720, 1280, "jpeg");
  const jobs = buildPass1({ seed: 3, clips: CLIPS, resolvePhoto: () => ({ path: white, width: 720, height: 1280 }), clipDir: dir });
  await runPass1(jobs);
  frameCounts = [];
  for (const job of jobs) frameCounts.push(await videoFrames(job.output));
  output = join(dir, "final.mp4");
  await runPass2(buildPass2({ clips: CLIPS, clipDir: dir, output, overlays: [], audio: { kind: "silent" } }));
  for (const layout of ["collage2", "collage4"] as const) {
    for (const [k, rect] of collageRects(layout).entries()) lumas.set(`${layout}:${k}`, await lumaPerFrame(output, rect));
  }
  lumaOfCell = (layout, cell) => lumas.get(`${layout}:${cell}`) ?? [];
}, 180_000);

afterAll(() => removeDir(dir));

describe("a 100 ms clip on real ffmpeg", () => {
  test("the shortest clip is one 100 ms step", () => {
    expect(MIN_CLIP_MS).toBe(100);
  });

  test("every 100 ms clip, of every kind and motion, renders to exactly 3 frames in pass 1", () => {
    expect(frameCounts.slice(0, SHORT_CLIPS)).toEqual([3, 3, 3, 3, 3]);
    expect(frameCounts.slice(SHORT_CLIPS)).toEqual([15, 90]);
  });

  test("a 4 s montage with five 100 ms clips holds exactly 120 frames, in the sum of its clips' frames", async () => {
    expect(totalFrames(CLIPS)).toBe(EXPECTED_FRAMES);
    const probe = await probeVideo(output);
    const v = probe.streams.find((s) => s.codec_type === "video");
    expect(Number(v?.nb_read_frames)).toBe(EXPECTED_FRAMES);
    expect(Number(v?.duration)).toBeCloseTo(4, 3);
  });

  test("stays constant frame rate through the 3-frame clips: every frame is 33.333 ms after the last", async () => {
    const times = await frameTimesMs(output);
    expect(times.length).toBe(EXPECTED_FRAMES);
    const deltas = times.slice(1).map((t, i) => t - (times[i] ?? 0));
    expect(Math.min(...deltas)).toBeGreaterThan(33.3);
    expect(Math.max(...deltas)).toBeLessThan(33.4);
  });

  test("a 100 ms collage of four shows every cell on all 3 of its frames: the 0-frame step means no fade, not a black cell", () => {
    for (let k = 0; k < 4; k++) {
      const luma = lumaOfCell("collage4", k);
      for (const frame of [3, 4, 5]) expect(luma[frame]).toBeGreaterThan(200);
    }
  });

  test("control: a 500 ms collage of four in the same montage does hide its last cell on its first frame, and shows it by frame 12 of 15", () => {
    const last = lumaOfCell("collage4", 3);
    expect(last[15]).toBeLessThan(60);
    expect(last[15 + 12]).toBeGreaterThan(200);
  });

  test("a 100 ms collage of two has both cells fully in on the clip's last frame", () => {
    for (let k = 0; k < 2; k++) expect(lumaOfCell("collage2", k)[8]).toBeGreaterThan(200);
  });
});
