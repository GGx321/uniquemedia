import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fakeSpawner } from "../../node/fakeFfmpeg.testkit";
import { FfmpegError, FfmpegTimeoutError } from "../../node/runFfmpeg";
import { imageSize } from "../library/media";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { FRAME_STEP_MS, makePoster, sampleFrames } from "./frames";
import { meanLuma, meanRgb, useClipFixtures } from "./testing/clipFixtures";
useNativeGlobals();

// §5.11 and §5.10: one frame every half second as a 720 x 1280 JPEG (a frame at 0, then 0.5, 1, ...), and the poster, the frame at 0.5 s. Both read the library's file under a
// time bound, with the file protocol only; the scratch folder is left as it was found, whatever happens.

const clip = useClipFixtures();
let scratch = "";
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "studio-frames-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("sampleFrames", () => {
  test("takes one frame every half second", () => {
    expect(FRAME_STEP_MS).toBe(500);
  });

  test("takes 10 or 11 frames from a 5 s clip", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 5 });
    const frames = await sampleFrames({ clipPath: path, durationMs: 5_000, scratchDir: scratch });
    expect(frames.length).toBeGreaterThanOrEqual(10);
    expect(frames.length).toBeLessThanOrEqual(11);
  });

  test("takes 20 or 21 frames from a 10 s clip", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 10 });
    const frames = await sampleFrames({ clipPath: path, durationMs: 10_000, scratchDir: scratch });
    expect(frames.length).toBeGreaterThanOrEqual(20);
    expect(frames.length).toBeLessThanOrEqual(21);
  });

  test("returns every frame as a 720 x 1280 JPEG, whatever size the clip is", async () => {
    const path = await clip({ width: 1080, height: 1920, seconds: 5 });
    const frames = await sampleFrames({ clipPath: path, durationMs: 5_000, scratchDir: scratch });
    expect(frames.length).toBeGreaterThanOrEqual(10);
    for (const frame of frames) {
      expect(frame[0]).toBe(0xff);
      expect(frame[1]).toBe(0xd8);
      expect(imageSize(frame)).toEqual({ width: 720, height: 1280 });
    }
  });

  test("returns the frames in time order: the first is the clip's first frame", async () => {
    // The fixture is black until 0.25 s and white after it.
    const path = await clip({ width: 720, height: 1280, seconds: 5 });
    const frames = await sampleFrames({ clipPath: path, durationMs: 5_000, scratchDir: scratch });
    expect(await meanLuma(frames[0] ?? new Uint8Array())).toBeLessThan(40);
    expect(await meanLuma(frames[1] ?? new Uint8Array())).toBeGreaterThan(200);
  });

  test("leaves the scratch folder empty after a good run", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 5 });
    await sampleFrames({ clipPath: path, durationMs: 5_000, scratchDir: scratch });
    expect(await readdir(scratch)).toEqual([]);
  });

  test("rejects when ffmpeg cannot read the file, and leaves the scratch folder empty", async () => {
    await expect(sampleFrames({ clipPath: join(scratch, "nothing.mp4"), durationMs: 5_000, scratchDir: scratch })).rejects.toBeInstanceOf(FfmpegError);
    expect(await readdir(scratch)).toEqual([]);
  });

  test("kills ffmpeg when the time bound passes, rejects with a timeout, and removes the temp folder", async () => {
    // A child that never finishes.
    const { spawner, calls } = fakeSpawner(() => {});
    const run = sampleFrames({ clipPath: "/clips/a.mp4", durationMs: 5_000, scratchDir: scratch, timeoutMs: 30, spawner });
    await expect(run).rejects.toBeInstanceOf(FfmpegTimeoutError);
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
    expect(await readdir(scratch)).toEqual([]);
  });

  test("kills ffmpeg when the call is aborted, rejects, and removes the temp folder", async () => {
    const { spawner, calls } = fakeSpawner(() => {});
    const controller = new AbortController();
    const run = sampleFrames({ clipPath: "/clips/a.mp4", durationMs: 5_000, scratchDir: scratch, signal: controller.signal, spawner });
    setTimeout(() => controller.abort(new Error("owner cancelled")), 20);
    await expect(run).rejects.toThrow("owner cancelled");
    expect(calls[0]?.child.killedWith.length).toBeGreaterThan(0);
    expect(await readdir(scratch)).toEqual([]);
  });

  test("allows only the file protocol, forces the MP4 demuxer and drops sound", async () => {
    const { spawner, calls } = fakeSpawner(({ child }) => child.exit(0));
    await sampleFrames({ clipPath: "/clips/a.mp4", durationMs: 5_000, scratchDir: scratch, spawner });
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
    expect(args[args.indexOf("-f") + 1]).toBe("mov");
    expect(args).toContain("-an");
  });
});

// The providers' files are BT.709; a JPEG is read as BT.601. A conversion that changes only the range tints every frame (the green-tint pain of the uniquifier), and grey cannot show it.
describe("colour", () => {
  const PATCHES: [string, string, [number, number, number]][] = [
    ["green", "0x2EB32E", [46, 179, 46]],
    ["red", "0xC43031", [196, 48, 47]],
    ["blue", "0x3C5ABE", [60, 90, 190]],
  ];
  const near = (got: readonly number[], want: readonly number[]): void => {
    got.forEach((channel, i) => expect(Math.abs(channel - (want[i] ?? 0))).toBeLessThanOrEqual(3));
  };

  for (const [name, hex, rgb] of PATCHES) {
    test(`the poster of a BT.709 ${name} clip is ${name} within 3 per channel`, async () => {
      const path = await clip({ width: 720, height: 1280, seconds: 5, patch: hex });
      const out = join(scratch, "poster.tmp");
      await makePoster({ clipPath: path, outPath: out });
      near(await meanRgb(new Uint8Array(await readFile(out))), rgb);
    });

    test(`every sampled frame of a BT.709 ${name} clip is ${name} within 3 per channel`, async () => {
      const path = await clip({ width: 1080, height: 1920, seconds: 5, patch: hex });
      const frames = await sampleFrames({ clipPath: path, durationMs: 5_000, scratchDir: scratch });
      for (const frame of [frames[0], frames.at(-1)]) near(await meanRgb(frame ?? new Uint8Array()), rgb);
    });
  }
});

describe("makePoster", () => {
  test("writes a 720 x 1280 JPEG from a 720 x 1280 clip", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 5 });
    const out = join(scratch, "poster.tmp");
    await makePoster({ clipPath: path, outPath: out });
    const bytes = new Uint8Array(await readFile(out));
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect(imageSize(bytes)).toEqual({ width: 720, height: 1280 });
  });

  test("scales a 1080 x 1920 clip down to a 720 x 1280 poster", async () => {
    const path = await clip({ width: 1080, height: 1920, seconds: 5 });
    const out = join(scratch, "poster.tmp");
    await makePoster({ clipPath: path, outPath: out });
    expect(imageSize(new Uint8Array(await readFile(out)))).toEqual({ width: 720, height: 1280 });
  });

  test("takes the frame at 0.5 s, not the first frame", async () => {
    // Black until 0.25 s, white after: the first frame is black and the frame at 0.5 s is white.
    const path = await clip({ width: 720, height: 1280, seconds: 5 });
    const out = join(scratch, "poster.tmp");
    await makePoster({ clipPath: path, outPath: out });
    expect(await meanLuma(new Uint8Array(await readFile(out)))).toBeGreaterThan(200);
  });

  test("rejects when ffmpeg cannot read the file, and leaves no poster", async () => {
    const out = join(scratch, "poster.tmp");
    await expect(makePoster({ clipPath: join(scratch, "nothing.mp4"), outPath: out })).rejects.toBeInstanceOf(FfmpegError);
    expect(await readdir(scratch)).toEqual([]);
  });

  test("kills ffmpeg when the time bound passes", async () => {
    const { spawner, calls } = fakeSpawner(() => {});
    await expect(makePoster({ clipPath: "/clips/a.mp4", outPath: join(scratch, "poster.tmp"), timeoutMs: 30, spawner })).rejects.toBeInstanceOf(FfmpegTimeoutError);
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
  });
});
