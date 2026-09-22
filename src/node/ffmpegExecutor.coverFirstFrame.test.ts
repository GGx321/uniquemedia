import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { PhotoExecutor } from "./photoExecutor";
import { makeTestClip, makeTestPhoto } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import { computePdqHash } from "../core/pdq/pdq";
import { hammingDistance } from "../core/pdq/hamming";
import type { MediaInfo, Recipe, ResolvedCopyOptions, ResolvedCover } from "../core/types";

/**
 * The photo first frame, measured on a real encode — the same way the black
 * one is, and for the same reason: the graph string cannot show whether the
 * cover survived the encoder's CFR duplication as one frame or three, nor
 * whether what landed on frame 0 is the cover at all.
 *
 * "Is the cover" is asked of the hash, not the eye: the cover is rendered on
 * its own through the same photo recipe, fitted to the video the way the
 * graph fits it, and its PDQ compared with frame 0's. A pasted cover would
 * match too, so a second copy from another seed has to land on a different
 * hash — the cover was uniquified per copy, not just placed.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const FFPROBE = ffprobeStatic.path;

/** The source rate `makeTestClip` encodes at. */
const SOURCE_FPS = 15;

const SIDE = 64;

/** A re-encode alone moves PDQ by 0-2 on texture (design notes); frame 0 is
 *  the fitted cover through x264 at crf 18-22, so a few bits more. Well under
 *  the 38 the pipeline calls "different". */
const SAME_PICTURE_MAX = 16;

/** Frame 1 is the footage: testsrc against a mandelbrot. Anything under this
 *  would mean the cover leaked into a second frame or the video never came back. */
const OTHER_PICTURE_MIN = 60;

/** Copies drawn from two seeds crop different windows of the cover; a pasted
 *  cover would sit at 0-2 (encode noise alone). */
const UNIQUIFIED_MIN = 8;

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

function grayFrames(file: string, count: number, side = SIDE): Uint8Array[] {
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", file, "-frames:v", String(count),
     "-vf", `scale=${side}:${side},format=gray`, "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 26 }
  );
  if (r.status !== 0) throw new Error(`gray read failed: ${r.stderr.toString().slice(-300)}`);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = r.stdout.subarray(i * side * side, (i + 1) * side * side);
    if (chunk.length < side * side) break;
    frames.push(new Uint8Array(chunk));
  }
  return frames;
}

/** Frame 0 of `file` as a full-resolution gray plane. */
function fullGrayFrame0(file: string, w: number, h: number): Uint8Array {
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", file, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 26 }
  );
  if (r.status !== 0) throw new Error(`gray read failed: ${r.stderr.toString().slice(-300)}`);
  if (r.stdout.length < w * h) throw new Error(`expected ${w * h} bytes, got ${r.stdout.length}`);
  return new Uint8Array(r.stdout.subarray(0, w * h));
}

/** A still fitted to `w`x`h` the way the graph fits the cover — the smallest
 *  same-aspect cover of the frame, centre-cropped — as a gray plane of `side`
 *  (64 for hashing) or of the full size (`side` = 0). */
function fittedGray(file: string, w: number, h: number, side = SIDE): Uint8Array {
  const tail = side > 0 ? `,scale=${side}:${side}` : "";
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", file, "-frames:v", "1",
     "-vf", `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}${tail},format=gray`,
     "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 26 }
  );
  if (r.status !== 0) throw new Error(`fit read failed: ${r.stderr.toString().slice(-300)}`);
  const n = side > 0 ? side * side : w * h;
  if (r.stdout.length < n) throw new Error(`expected ${n} bytes, got ${r.stdout.length}`);
  return new Uint8Array(r.stdout.subarray(0, n));
}

const pdq = (f: Uint8Array): Uint8Array => computePdqHash(f);
const meanOf = (f: Uint8Array): number => f.reduce((s, v) => s + v, 0) / f.length;

function probeField(file: string, entry: string, stream: "v" | "a"): string {
  const r = spawnSync(
    FFPROBE,
    ["-v", "error", "-select_streams", stream, "-show_entries", entry,
     "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  );
  return r.stdout.trim();
}

function coverOf(recipe: Recipe): Extract<Recipe["firstFrame"], { mode: "photo" }> {
  if (recipe.firstFrame.mode !== "photo") throw new Error(`first frame is ${recipe.firstFrame.mode}`);
  return recipe.firstFrame;
}

/** Column `x` of a `w`x`h` gray plane. */
function column(plane: Uint8Array, w: number, h: number, x: number): Uint8Array {
  const out = new Uint8Array(h);
  for (let y = 0; y < h; y++) out[y] = plane[y * w + x];
  return out;
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

let dir: string;
let input: string;
let coverPath: string;
let info: MediaInfo;
let cover: ResolvedCover;
let recipeA: Recipe;
let pathA: string;
let pathB: string;
let offPath: string;
let blackPath: string;
/** The cover of copy A, rendered on its own through its own recipe. */
let standaloneA: string;
const exec = new FfmpegExecutor();
const stills = new PhotoExecutor();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-cover-"));
  input = join(dir, "in.mp4");
  coverPath = join(dir, "cover.jpg");
  makeTestClip(input);
  // Square, against a 4:3 clip: the fit has to crop, and the crop has to be
  // centred with nothing left over on either side.
  makeTestPhoto(coverPath, 400, 400);
  info = await exec.probe(input);
  cover = { path: coverPath, edge: { mode: "crop" }, info: await stills.probe(coverPath) };

  const photoOpts: ResolvedCopyOptions = { ...opts, firstFrame: { mode: "photo", cover } };
  // One seed, two renders: the recipes differ in the mode alone, so anything
  // that differs between the files is the cover's doing.
  recipeA = sampleRecipe(photoOpts, 42, 1);
  const recipeOff = sampleRecipe(opts, 42, 1);
  const recipeBlack = sampleRecipe({ ...opts, firstFrame: { mode: "black" } }, 42, 1);
  const recipeB = sampleRecipe(photoOpts, 43, 1);
  pathA = join(dir, "a.mp4");
  pathB = join(dir, "b.mp4");
  offPath = join(dir, "off.mp4");
  blackPath = join(dir, "black.mp4");
  standaloneA = join(dir, "standalone_a.jpg");
  await exec.render(input, info, recipeA, pathA);
  await exec.render(input, info, recipeOff, offPath);
  await exec.render(input, info, recipeBlack, blackPath);
  await exec.render(input, info, recipeB, pathB);
  await stills.render(coverPath, cover.info, coverOf(recipeA).recipe, standaloneA);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const targetFps = (): number => Number(recipeA.video.find((o) => o.id === "encode")?.params.fps);

test("frame 0 is the cover: its hash sits next to the cover rendered standalone through the same recipe", () => {
  const [frame0] = grayFrames(pathA, 1);
  const reference = fittedGray(standaloneA, info.width, info.height);
  const distance = hammingDistance(pdq(frame0), pdq(reference));
  console.log(`[cover-first-frame] frame0 vs standalone cover: PDQ distance ${distance}`);
  expect(distance).toBeLessThanOrEqual(SAME_PICTURE_MAX);
});

test("frame 1 is the footage again: far from frame 0", () => {
  const [frame0, frame1] = grayFrames(pathA, 2);
  const distance = hammingDistance(pdq(frame0), pdq(frame1));
  console.log(`[cover-first-frame] frame0 vs frame1: PDQ distance ${distance}`);
  expect(distance).toBeGreaterThanOrEqual(OTHER_PICTURE_MIN);
});

test("exactly one cover frame comes out at a source/target fps mismatch", () => {
  // The precondition the test rests on: the encoder has to be duplicating
  // frames, or the fps filter would have nothing to pre-empt.
  expect(targetFps()).not.toBe(SOURCE_FPS);
  const reference = pdq(fittedGray(standaloneA, info.width, info.height));
  const frames = grayFrames(pathA, 8);
  expect(frames.length).toBe(8);
  const distances = frames.map((f) => hammingDistance(pdq(f), reference));
  const coverCount = distances.filter((d) => d <= SAME_PICTURE_MAX).length;
  console.log(
    `[cover-first-frame] source=${SOURCE_FPS}fps target=${targetFps()}fps ` +
      `cover frames in first 8: ${coverCount} (distances: ${distances.join(",")})`
  );
  expect(coverCount).toBe(1);
  expect(distances[0]).toBeLessThanOrEqual(SAME_PICTURE_MAX);
});

test("with the mode off, frame 0 is the footage", () => {
  // The control: the source does not open on the cover of its own accord.
  const [first] = grayFrames(offPath, 1);
  const reference = fittedGray(standaloneA, info.width, info.height);
  expect(hammingDistance(pdq(first), pdq(reference))).toBeGreaterThanOrEqual(OTHER_PICTURE_MIN);
});

test("two copies from different seeds open on different renditions of the cover", () => {
  const [a] = grayFrames(pathA, 1);
  const [b] = grayFrames(pathB, 1);
  const distance = hammingDistance(pdq(a), pdq(b));
  console.log(`[cover-first-frame] copy A frame0 vs copy B frame0: PDQ distance ${distance}`);
  expect(distance).toBeGreaterThanOrEqual(UNIQUIFIED_MIN);
});

test("the cover leaves the output duration within one frame of the plain render", () => {
  const on = Number(probeField(pathA, "stream=duration", "v"));
  const off = Number(probeField(offPath, "stream=duration", "v"));
  expect(on).toBeGreaterThan(1.5);
  expect(Math.abs(on - off)).toBeLessThanOrEqual(1 / targetFps() + 1e-3);
});

test("the cover costs no frame beyond what the fps pre-conversion already costs", () => {
  // The `fps=` in front of the overlay is the black branch's `fps=`, and on a
  // 15 -> 24 conversion it rounds the tail to one frame more than the encoder's
  // own CFR would (49 against 48 over 2 s; 25 and 30 agree). That is the
  // shipped black behaviour, pinned as "within one frame" above. The overlay
  // itself must add nothing: the count equals the black render's exactly.
  const photoFrames = Number(probeField(pathA, "stream=nb_frames", "v"));
  const blackFrames = Number(probeField(blackPath, "stream=nb_frames", "v"));
  const offFrames = Number(probeField(offPath, "stream=nb_frames", "v"));
  expect(photoFrames).toBe(blackFrames);
  expect(Math.abs(photoFrames - offFrames)).toBeLessThanOrEqual(1);
});

test("the cover leaves the audio track in place and in sync", () => {
  expect(probeField(pathA, "stream=codec_name", "a")).toContain("aac");
  const vd = Number(probeField(pathA, "stream=duration", "v"));
  const ad = Number(probeField(pathA, "stream=duration", "a"));
  expect(Math.abs(vd - ad)).toBeLessThan(0.2);
});

test("the cover keeps the copy CFR at the recipe fps", () => {
  const [num, den] = probeField(pathA, "stream=r_frame_rate", "v").split("/").map(Number);
  expect(den ? num / den : num).toBe(targetFps());
});

test("a cover of another aspect is centre-cropped to the video's size, with no bars at the edges", () => {
  // Output size is the video's, not the cover's.
  expect(probeField(pathA, "stream=width", "v")).toBe(String(info.width));
  expect(probeField(pathA, "stream=height", "v")).toBe(String(info.height));
  // The edge columns and rows of frame 0 are the cover's edge columns and
  // rows — not black (a bar) and not the footage (a sliver).
  const { width: w, height: h } = info;
  const frame0 = fullGrayFrame0(pathA, w, h);
  const reference = fittedGray(standaloneA, w, h, 0);
  for (const x of [0, 1, w - 2, w - 1]) {
    const got = column(frame0, w, h, x);
    expect(meanAbsDiff(got, column(reference, w, h, x))).toBeLessThan(16);
    expect(meanOf(got)).toBeGreaterThan(8);
  }
  for (const y of [0, 1, h - 2, h - 1]) {
    const got = frame0.subarray(y * w, (y + 1) * w);
    expect(meanAbsDiff(got, reference.subarray(y * w, (y + 1) * w))).toBeLessThan(16);
    expect(meanOf(got)).toBeGreaterThan(8);
  }
});

test("the cover covers the whole frame when rotate grows an original-format copy past its source size", async () => {
  // `original` keeps the source size only nominally: `rotate`'s `ow=rotw`
  // widens the canvas and the even-crop keeps the result. At 0.05° — the top
  // of the baseline draw — a 1080x1920 source comes out 1082 wide. A cover
  // fitted to a size computed from the source would leave a sliver of footage
  // down one side; fitted against the stream it cannot.
  const tall = join(dir, "tall.mp4");
  const r = spawnSync(FFMPEG, [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=duration=1:size=1080x1920:rate=15",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", tall,
  ]);
  if (r.status !== 0) throw new Error(`tall clip failed: ${r.stderr.toString().slice(-300)}`);
  const tallInfo = await exec.probe(tall);
  const base = sampleRecipe({ ...opts, firstFrame: { mode: "photo", cover } }, 42, 1);
  const grown: Recipe = {
    ...base,
    video: base.video.map((o) => (o.id === "rotate" ? { ...o, params: { deg: 0.05 } } : o)),
  };
  const out = join(dir, "tall_cover.mp4");
  await exec.render(tall, tallInfo, grown, out);

  const w = Number(probeField(out, "stream=width", "v"));
  const h = Number(probeField(out, "stream=height", "v"));
  // The premise: the frame really did grow past the source.
  expect(w).toBe(1082);
  expect(h).toBe(1920);

  const standalone = join(dir, "standalone_tall.jpg");
  await stills.render(coverPath, cover.info, coverOf(grown).recipe, standalone);
  const frame0 = fullGrayFrame0(out, w, h);
  const reference = fittedGray(standalone, w, h, 0);
  for (const x of [0, 1, w - 2, w - 1]) {
    expect(meanAbsDiff(column(frame0, w, h, x), column(reference, w, h, x))).toBeLessThan(16);
  }
  expect(hammingDistance(pdq(grayFrames(out, 1)[0]), pdq(fittedGray(standalone, w, h)))).toBeLessThanOrEqual(
    SAME_PICTURE_MAX
  );
});

test("a PNG cover with transparency is flattened the way the photo pipeline flattens it, not composited over the footage", async () => {
  // `overlay` honours an alpha plane. Left alone, a transparent region of the
  // cover would show the footage through it on frame 0, while the same file
  // through the photo pipeline (`-pix_fmt yuvj420p`) drops the alpha and
  // ships whatever colour sits under it. Frame 0 has to be the latter — the
  // cover as the still pipeline would have made it.
  const png = join(dir, "alpha.png");
  const r = spawnSync(FFMPEG, [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "mandelbrot=size=400x400",
    // Alpha: opaque on the left half, fully transparent on the right.
    "-f", "lavfi", "-i", "color=c=white:s=400x400,format=gray,geq=lum='if(lt(X,200),255,0)'",
    "-filter_complex", "[0:v]format=rgba[c];[c][1:v]alphamerge",
    "-frames:v", "1", "-pix_fmt", "rgba", png,
  ]);
  if (r.status !== 0) throw new Error(`alpha png failed: ${r.stderr.toString().slice(-300)}`);
  const pngCover: ResolvedCover = { path: png, edge: { mode: "crop" }, info: await stills.probe(png) };
  const recipe = sampleRecipe({ ...opts, firstFrame: { mode: "photo", cover: pngCover } }, 42, 1);
  const out = join(dir, "alpha_cover.mp4");
  await exec.render(input, info, recipe, out);
  const standalone = join(dir, "standalone_alpha.jpg");
  await stills.render(png, pngCover.info, coverOf(recipe).recipe, standalone);

  const { width: w, height: h } = info;
  const frame0 = fullGrayFrame0(out, w, h);
  const reference = fittedGray(standalone, w, h, 0);
  const footage = fullGrayFrame0(offPath, w, h);
  // The right half of frame 0 is the flattened cover, not the footage: a
  // column well inside the transparent half matches the standalone render
  // and not what the footage has there — the check that gives the first
  // assertion its teeth.
  for (const x of [Math.round(w * 0.75), w - 1]) {
    expect(meanAbsDiff(column(frame0, w, h, x), column(reference, w, h, x))).toBeLessThan(16);
    expect(meanAbsDiff(column(frame0, w, h, x), column(footage, w, h, x))).toBeGreaterThan(24);
  }
  const distance = hammingDistance(pdq(grayFrames(out, 1)[0]), pdq(fittedGray(standalone, w, h)));
  console.log(`[cover-first-frame] alpha PNG: frame0 vs standalone: PDQ distance ${distance}`);
  expect(distance).toBeLessThanOrEqual(SAME_PICTURE_MAX);
});
