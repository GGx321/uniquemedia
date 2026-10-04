import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import type { Clip, Focus } from "../../shared/engine/montage";
import { ownVideoIssues } from "../../shared/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { RAMP } from "../videos/testing/fixtures/index";
import { firstFrameMeans, flatFrames, gradientFrames, importAsMezzanine, frameNumbersOf, lumaGrid, mezzanineOf, rampFrames, type Mezzanine } from "../videos/testing/mezzanineKit";
import { probeVideo, videoFrames } from "./ffmpeg.testkit";
import { buildPass1 } from "./pass1";
import { makeWorkDir, removeDir, runPass1 } from "./render.testkit";
import type { VideoSource } from "./types";
useNativeGlobals();
setDefaultTimeout(120_000);

// Pass 1 for an own video clip on REAL ffmpeg (3f.3b), from stored mezzanines made by 3f.3a's real importer: which frames a clip plays (a ramp mezzanine whose frame i
// reads back as i), the exact frame count at the montage's limits and at the mezzanine's end, the cover-crop with focus at the edges (a gradient mezzanine shows
// which part was cropped), no motion, the colours (invariant 36) and a variable-rate source that the mezzanine has already made constant.

let dir = "";
let n = 0;
const made = new Map<string, Mezzanine>();
const ramp: Mezzanine = { mediaId: "media-ramp", path: RAMP.file, sha256: RAMP.sha256, bytes: RAMP.bytes, width: RAMP.width, height: RAMP.height, durationMs: RAMP.durationMs, frames: RAMP.frames };

async function make(name: string, build: () => Promise<Mezzanine>): Promise<Mezzanine> {
  const mezzanine = await build();
  made.set(name, mezzanine);
  return mezzanine;
}
const get = (name: string): Mezzanine => {
  const found = made.get(name);
  if (found === undefined) throw new Error(`no mezzanine ${name}`);
  return found;
};

beforeAll(async () => {
  dir = makeWorkDir("own-video");
  await make("flat-long", () => mezzanineOf(dir, "media-long", flatFrames(96, 192, 520, 120, 128, 128)));
  await make("short-89", () => mezzanineOf(dir, "media-s89", rampFrames(96, 192, 89)));
  await make("landscape", () => mezzanineOf(dir, "media-wide", gradientFrames(1080, 570, 15, "x")));
  await make("tall", () => mezzanineOf(dir, "media-tall", gradientFrames(540, 1920, 15, "y")));
  await make("portrait", () => mezzanineOf(dir, "media-full", gradientFrames(1080, 1920, 15, "x")));
  await make("colour", () => mezzanineOf(dir, "media-colour", flatFrames(96, 192, 15, 100, 90, 170)));
  await make("vfr", () => importAsMezzanine(dir, "media-vfr", "h264-vfr.mp4"));
});
afterAll(() => removeDir(dir));

const videoClip = (mezzanine: Mezzanine, durationMs: number, trimStartMs = 0, focus: Focus | null = null): Clip => ({ clipId: "v", durationMs, transitionIn: "cut", kind: "video", mediaId: mezzanine.mediaId, trimStartMs, focus });

/** Builds and runs pass 1 for one clip of `mezzanine`, reading a private copy in a fresh job folder as the runner does; answers the finished file. */
async function render(mezzanine: Mezzanine, clip: Clip): Promise<{ output: string; frames: number }> {
  const clipDir = join(dir, `job-${++n}`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(clipDir, { recursive: true });
  const copy = join(clipDir, `own-${mezzanine.mediaId}.mp4`);
  copyFileSync(mezzanine.path, copy);
  const resolveVideo = (): VideoSource => ({ path: copy, width: mezzanine.width, height: mezzanine.height });
  const jobs = buildPass1({ seed: 1, clips: [clip], resolvePhoto: () => undefined, resolveVideo, clipDir });
  await runPass1(jobs);
  const job = jobs[0];
  if (job === undefined) throw new Error("no job");
  return { output: job.output, frames: job.frames };
}

describe("an own video clip on real ffmpeg: which frames it plays", () => {
  test.each([
    { trimStartMs: 0, durationMs: 500, from: 0, frames: 15 },
    { trimStartMs: 1_100, durationMs: 500, from: 33, frames: 15 },
    { trimStartMs: 300, durationMs: 1_500, from: 9, frames: 45 },
    { trimStartMs: 1_000, durationMs: 1_000, from: 30, frames: 30 },
    { trimStartMs: 0, durationMs: 3_000, from: 0, frames: 90 },
  ])("a clip of $durationMs ms from $trimStartMs ms plays exactly frames $from to $from + $frames of the mezzanine, in order", async ({ trimStartMs, durationMs, from, frames }) => {
    const { output } = await render(ramp, videoClip(ramp, durationMs, trimStartMs));
    expect(frameNumbersOf(output)).toEqual(Array.from({ length: frames }, (_, i) => from + i));
  });

  test("a trim of 0 starts at the mezzanine's very first frame", async () => {
    const { output } = await render(ramp, videoClip(ramp, 500, 0));
    expect(frameNumbersOf(output)[0]).toBe(0);
  });

  test("a trim that ends EXACTLY at the mezzanine's end plays its last frame, and not a frame more", async () => {
    const { output, frames } = await render(ramp, videoClip(ramp, 1_000, 2_000));
    const played = frameNumbersOf(output);
    expect(frames).toBe(30);
    expect(played[0]).toBe(60);
    expect(played.at(-1)).toBe(RAMP.frames - 1);
    expect(played).toHaveLength(30);
  });

  test("a clip never plays frames from before its trim: the first frame is the trim's, whatever keyframe it was cut from", async () => {
    // The mezzanine's keyframes are every 30 frames, so a trim of frame 33 is 3 frames after a keyframe.
    const { output } = await render(ramp, videoClip(ramp, 500, 1_100));
    expect(frameNumbersOf(output)[0]).toBe(33);
  });
});

describe("an own video clip on real ffmpeg: an exact frame count", () => {
  test.each([
    { durationMs: 500, frames: 15 },
    { durationMs: 15_000, frames: 450 },
    { durationMs: 4_700, frames: 141 },
  ])("a clip of $durationMs ms is $frames frames, to the frame, at 1080 x 1920 and a constant 30 fps", async ({ durationMs, frames }) => {
    const { output } = await render(get("flat-long"), videoClip(get("flat-long"), durationMs, 1_000));
    const probed = await probeVideo(output);
    const video = probed.streams.find((s) => s.codec_type === "video");
    expect({ w: video?.width, h: video?.height, fps: video?.r_frame_rate, frames: Number(video?.nb_read_frames) }).toEqual({ w: 1080, h: 1920, fps: "30/1", frames });
  });

  test("a clip that starts deep into a long mezzanine is still exact", async () => {
    const mezzanine = get("flat-long");
    const { output } = await render(mezzanine, videoClip(mezzanine, 1_500, 13_900));
    expect(await videoFrames(output)).toBe(45);
  });

  test("a mezzanine ONE FRAME short of what the clip asks for makes a clip one frame short: ffmpeg does not pad, which is why the runner refuses it", async () => {
    // 89 frames, 2967 ms: a 3 s clip from 0 needs 90.
    const short = get("short-89");
    expect(ownVideoIssues({ clips: [videoClip(short, 3_000, 0)] }, () => ({ durationMs: short.durationMs }))).toEqual([{ code: "video-too-short", path: ["clips", 0] }]);
    const { output, frames } = await render(short, videoClip(short, 3_000, 0));
    expect(frames).toBe(90);
    expect(await videoFrames(output)).toBe(89);
  });

  test("a source of variable frame rate, already made constant 30 fps by the importer, gives the exact count", async () => {
    const vfr = get("vfr");
    const whole = Math.floor(vfr.frames / 3) * 3;
    expect(whole).toBeGreaterThanOrEqual(15);
    const { output, frames } = await render(vfr, videoClip(vfr, (whole * 100) / 3, 0));
    expect(frames).toBe(whole);
    expect(await videoFrames(output)).toBe(whole);
    const video = (await probeVideo(output)).streams.find((s) => s.codec_type === "video");
    expect(video?.r_frame_rate).toBe("30/1");
  });
});

describe("an own video clip on real ffmpeg: cover-crop with focus", () => {
  /** The mean luma of each of 4 columns (2 rows) of the first frame. */
  const columns = (output: string): number[] => {
    const [first = []] = lumaGrid(output, 4, 2);
    return [0, 1, 2, 3].map((c) => ((first[c] ?? 0) + (first[4 + c] ?? 0)) / 2);
  };
  /** The luma a column of 4 shows when the crop starts at `x0` of a 1080-wide gradient (16 at the first column, 216 at the last) and is 320 wide. */
  const expectedAt = (x0: number, c: number): number => 16 + (200 * (x0 + ((c + 0.5) * 320) / 4)) / 1079;

  test.each([
    { name: "left edge", focus: { x: 0, y: 0.5 }, x0: 0 },
    { name: "centre", focus: { x: 0.5, y: 0.5 }, x0: 380 },
    { name: "right edge", focus: { x: 1, y: 0.5 }, x0: 760 },
  ])("a short landscape 1080 x 570 mezzanine with the focus at its $name shows the slice that starts at $x0", async ({ focus, x0 }) => {
    const wide = get("landscape");
    const { output } = await render(wide, videoClip(wide, 500, 0, focus));
    const got = columns(output);
    got.forEach((luma, c) => expect(Math.abs(luma - expectedAt(x0, c))).toBeLessThanOrEqual(3));
  });

  test("with no focus the face-less fallback is used: the same slice as the centre, since the fallback is centred", async () => {
    const wide = get("landscape");
    const { output } = await render(wide, videoClip(wide, 500, 0, null));
    columns(output).forEach((luma, c) => expect(Math.abs(luma - expectedAt(380, c))).toBeLessThanOrEqual(3));
  });

  test("a tall narrow 540 x 1920 mezzanine with the focus at its top shows its top half, and at its bottom its bottom half", async () => {
    const tall = get("tall");
    const rowMeans = (output: string): [number, number] => {
      const [first = []] = lumaGrid(output, 2, 4);
      return [((first[0] ?? 0) + (first[1] ?? 0)) / 2, ((first[6] ?? 0) + (first[7] ?? 0)) / 2];
    };
    const top = rowMeans((await render(tall, videoClip(tall, 500, 0, { x: 0.5, y: 0 }))).output);
    const bottom = rowMeans((await render(tall, videoClip(tall, 500, 0, { x: 0.5, y: 1 }))).output);
    // The crop is 540 x 960: y 0 to 960 (luma 16 to 116) at the top, y 960 to 1920 (116 to 216) at the bottom.
    expect(top[0]).toBeLessThan(40);
    expect(top[1]).toBeGreaterThan(80);
    expect(top[1]).toBeLessThan(125);
    expect(bottom[0]).toBeGreaterThan(116);
    expect(bottom[0]).toBeLessThan(160);
    expect(bottom[1]).toBeGreaterThan(190);
  });

  test("a portrait mezzanine of exactly the frame's size is not cropped or scaled: every column is what it was", async () => {
    const full = get("portrait");
    const { output } = await render(full, videoClip(full, 500, 0, { x: 0.2, y: 0.9 }));
    const before = lumaGrid(full.path, 4, 2)[0] ?? [];
    const after = lumaGrid(output, 4, 2)[0] ?? [];
    after.forEach((luma, i) => expect(Math.abs(luma - (before[i] ?? 0))).toBeLessThanOrEqual(2));
  });
});

describe("an own video clip on real ffmpeg: static, silent, and the right colours", () => {
  test("has no motion: every frame of a clip of a still picture is the same picture", async () => {
    const wide = get("landscape");
    const { output } = await render(wide, videoClip(wide, 500, 0, { x: 0.3, y: 0.5 }));
    const frames = lumaGrid(output, 4, 2);
    expect(frames).toHaveLength(15);
    for (const frame of frames) expect(frame).toEqual(frames[0] ?? []);
  });

  test("makes a picture with one video stream and no audio, H.264, yuv420p, BT.709 limited", async () => {
    const { output } = await render(ramp, videoClip(ramp, 500, 0));
    const probed = await probeVideo(output);
    expect(probed.streams.map((s) => s.codec_type)).toEqual(["video"]);
    expect(probed.streams[0]).toMatchObject({ codec_name: "h264", pix_fmt: "yuv420p", color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709" });
  });

  test("keeps the colours of the mezzanine to within a code (invariant 36 asks for 2): no BT.601 conversion is run over a BT.709 picture", async () => {
    const colour = get("colour");
    const { output } = await render(colour, videoClip(colour, 500, 0));
    const before = firstFrameMeans(colour.path, colour.width, colour.height);
    const after = firstFrameMeans(output, 1080, 1920);
    after.forEach((value, plane) => expect(Math.abs(value - (before[plane] ?? 0))).toBeLessThanOrEqual(1));
  });

  test("does keep a saturated colour: the chroma is not flattened (Cb 90 and Cr 170 stay far from 128)", async () => {
    const colour = get("colour");
    const { output } = await render(colour, videoClip(colour, 500, 0));
    const [, cb, cr] = firstFrameMeans(output, 1080, 1920);
    expect(128 - cb).toBeGreaterThan(30);
    expect(cr - 128).toBeGreaterThan(30);
  });
});
