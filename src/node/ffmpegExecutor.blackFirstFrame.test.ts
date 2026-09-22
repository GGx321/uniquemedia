import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import type { ResolvedCopyOptions, MediaInfo, Recipe } from "../core/types";

/**
 * The black first frame, measured on a real encode rather than on the graph
 * string — because the graph is where the trap is invisible.
 *
 * `makeTestClip` is 15 fps and the encoder targets 24, 25 or 30, so ffmpeg has
 * to duplicate frames to reach CFR. A drawbox on its own gets duplicated with
 * them: two black frames at 30, not one. The `fps=` filter in front of it is
 * what brings the count down to exactly one, and "exactly one" is the number
 * this file exists to pin.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const FFPROBE = ffprobeStatic.path;

/** The source rate `makeTestClip` encodes at. */
const SOURCE_FPS = 15;

/** Size the first frames are read back at. Black stays black under scaling,
 *  and a 64x64 gray plane is what the pipeline reads for its hashes too. */
const SIDE = 64;

/** Encoder rounding on a limited-range black can leave a 1; anything above
 *  that is picture. */
const BLACK_MAX = 1;

/** testsrc frames average ~128; a frame this bright is clearly not black. */
const PICTURE_MEAN = 32;

const opts: ResolvedCopyOptions = {
  strength: 1.0,
  exportFormat: "original",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 60,
  identity: "engine",
  edgeMode: "auto",
  firstFrame: { mode: "off" },
};

function grayFrames(file: string, count: number): Uint8Array[] {
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", file, "-frames:v", String(count),
     "-vf", `scale=${SIDE}:${SIDE},format=gray`, "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 26 }
  );
  if (r.status !== 0) throw new Error(`gray read failed: ${r.stderr.toString().slice(-300)}`);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = r.stdout.subarray(i * SIDE * SIDE, (i + 1) * SIDE * SIDE);
    if (chunk.length < SIDE * SIDE) break;
    frames.push(new Uint8Array(chunk));
  }
  return frames;
}

const maxOf = (f: Uint8Array): number => f.reduce((m, v) => (v > m ? v : m), 0);
const meanOf = (f: Uint8Array): number => f.reduce((s, v) => s + v, 0) / f.length;
const isBlack = (f: Uint8Array): boolean => maxOf(f) <= BLACK_MAX;

function probeField(file: string, entry: string, stream: "v" | "a"): string {
  const r = spawnSync(
    FFPROBE,
    ["-v", "error", "-select_streams", stream, "-show_entries", entry,
     "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  );
  return r.stdout.trim();
}

let dir: string;
let info: MediaInfo;
let recipeOn: Recipe;
let onPath: string;
let offPath: string;
const exec = new FfmpegExecutor();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-bff-"));
  const input = join(dir, "in.mp4");
  makeTestClip(input);
  info = await exec.probe(input);
  // One seed, two renders: the recipes differ in the toggle alone, so anything
  // that differs between the files is the toggle's doing.
  recipeOn = sampleRecipe({ ...opts, firstFrame: { mode: "black" } }, 42, 1);
  const recipeOff = sampleRecipe({ ...opts, firstFrame: { mode: "off" } }, 42, 1);
  onPath = join(dir, "on.mp4");
  offPath = join(dir, "off.mp4");
  await exec.render(input, info, recipeOn, onPath);
  await exec.render(input, info, recipeOff, offPath);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const targetFps = (): number =>
  Number(recipeOn.video.find((o) => o.id === "encode")?.params.fps);

test("with the toggle on, the first frame of the rendered copy is pure black", () => {
  const [first] = grayFrames(onPath, 1);
  expect(maxOf(first)).toBeLessThanOrEqual(BLACK_MAX);
});

test("with the toggle on, the second frame is picture, not black", () => {
  const [, second] = grayFrames(onPath, 2);
  expect(meanOf(second)).toBeGreaterThan(PICTURE_MEAN);
});

test("exactly one black frame comes out at a source/target fps mismatch", () => {
  // The precondition the whole test rests on: the encoder has to be
  // duplicating frames, or the fps filter would have nothing to pre-empt.
  expect(targetFps()).not.toBe(SOURCE_FPS);
  const frames = grayFrames(onPath, 8);
  expect(frames.length).toBe(8);
  const blackCount = frames.filter(isBlack).length;
  console.log(
    `[black-first-frame] source=${SOURCE_FPS}fps target=${targetFps()}fps ` +
      `black frames in first 8: ${blackCount} ` +
      `(maxes: ${frames.map(maxOf).join(",")})`
  );
  expect(blackCount).toBe(1);
});

test("with the toggle off, the first frame is the picture", () => {
  // The control: the source does not open on black of its own accord, so a
  // black first frame in the other render is the toggle and not the footage.
  const [first] = grayFrames(offPath, 1);
  expect(meanOf(first)).toBeGreaterThan(PICTURE_MEAN);
});

test("the toggle leaves the output duration within one frame of the plain render", () => {
  const on = Number(probeField(onPath, "stream=duration", "v"));
  const off = Number(probeField(offPath, "stream=duration", "v"));
  expect(on).toBeGreaterThan(1.5);
  expect(Math.abs(on - off)).toBeLessThanOrEqual(1 / targetFps() + 1e-3);
});

test("the toggle leaves the audio track in place", () => {
  expect(probeField(onPath, "stream=codec_name", "a")).toContain("aac");
  const vd = Number(probeField(onPath, "stream=duration", "v"));
  const ad = Number(probeField(onPath, "stream=duration", "a"));
  expect(Math.abs(vd - ad)).toBeLessThan(0.2);
});

test("the toggle keeps the copy CFR at the recipe fps", () => {
  // The fps filter must agree with the `-r` that follows, or the output rate
  // would drift from what the recipe promised.
  const [num, den] = probeField(onPath, "stream=r_frame_rate", "v").split("/").map(Number);
  expect(den ? num / den : num).toBe(targetFps());
});
