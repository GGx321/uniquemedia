import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { FfmpegError, runFfmpegArgv, type RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { musicTracks } from "../music/fixtures";
import { probeVideo, videoFrames } from "../render/ffmpeg.testkit";
import { lumaPerFrame, makeSolid, makeWorkDir, removeDir, writeBytes } from "../render/render.testkit";
import type { OverlayInput } from "../render";
import { verifyRenderedMp4 } from "../verify";
import { createStickerAssets } from "../videos/stickerAssets";
import { runRenderJob } from "./runner";
useNativeGlobals();

// REAL ffmpeg, layers AND music through the runner (3b.6 with 3c.5): pass 2 is built twice for a track (silence is built up front, the
// music one after the true-peak measurement), and BOTH must overlay the layer pass's one file, never the layers themselves. With a track
// the pass-2 call also carries `-max_alloc 64 MiB` for the whole process: the FFV1 layer file must decode under it. What is asserted:
// the finished file has the exact frames and an audio stream, the layer is in its window only, and the argv of pass 2 has the layer file
// (not the layers) as an input and the track after it.

const TRACK_BYTES = new Uint8Array(readFileSync(musicTracks.threshold.file));
const STICKER_DIR = join(import.meta.dir, "..", "..", "assets", "stickers");
const clip: Clip = { clipId: "flat", durationMs: 1500, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: "flat" }, focus: null }, motion: "static" };
const clips: Clip[] = [clip, { ...clip, clipId: "flat-2" }]; // 90 frames, 3 s
const TEXT_BOX = { x: 100, y: 300, w: 400, h: 120 };
const STICKER_BOX = { x: 600, y: 800, w: 216, h: 216 };

let dir: string;
let output: string;
const argvs: Array<readonly string[]> = [];
let framesOut = 0;

beforeAll(async () => {
  dir = makeWorkDir("layers-music");
  const flat = join(dir, "flat.jpg");
  await makeSolid(flat, "0x808080", 720, 1280, "jpeg");
  const white = join(dir, "white.png");
  await makeSolid(white, "white", 400, 120, "png-rgba");
  const flash = await createStickerAssets(STICKER_DIR).read("lightning-flash");

  const tmpRoot = join(dir, "render-tmp");
  const jobDir = join(tmpRoot, "job-00000001");
  const overlays: OverlayInput[] = [
    { path: join(jobDir, "text-00.png"), format: "png", box: TEXT_BOX, resize: false, startFrame: 30, endFrame: 60 },
    { path: join(jobDir, "sticker-01.apng"), format: "apng", box: STICKER_BOX, resize: true, startFrame: 0, endFrame: 90, loopFrames: flash.loopFrames, sourceSize: { w: flash.width, h: flash.height } },
  ];
  output = join(dir, ".studio-part-job-00000001.mp4");
  const recording = async (opts: RunFfmpegArgvOptions): Promise<void> => {
    argvs.push(opts.argv);
    await runFfmpegArgv(opts);
  };
  await runRenderJob(
    {
      jobId: "job-00000001",
      tmpRoot,
      seed: 1,
      clips,
      resolvePhoto: () => ({ path: flat, width: 720, height: 1280 }),
      overlays,
      stageLayers: async (to) => {
        copyFileSync(white, join(to, "text-00.png"));
        writeBytes(join(to, "sticker-01.apng"), flash.bytes);
      },
      audio: { kind: "music", startMs: 2000, data: TRACK_BYTES },
      output,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    },
    { run: recording },
  );
  framesOut = await videoFrames(output);
}, 240_000);

afterAll(() => removeDir(dir));

describe("layers and music through the runner on real ffmpeg", () => {
  test("runs the clips, the layer call, then pass 2: four calls for two clips, one layer file and a track", () => {
    expect(argvs).toHaveLength(4);
    expect(argvs.map((a) => a.at(-1)?.split(/[\\/]/).at(-1))).toEqual(["clip-00.mkv", "clip-01.mkv", "layers-00.mkv", ".studio-part-job-00000001.mp4"]);
  });

  test("pass 2 reads the clips' list, then the layer file, then the job's private copy of the track (`track.m4a`): the layers themselves never reach it", () => {
    const pass2 = argvs.at(-1) ?? [];
    const inputs = pass2.flatMap((a, i) => (a === "-i" ? [pass2[i + 1] ?? ""] : []));
    expect(inputs.map((p) => p.split(/[\\/]/).at(-1))).toEqual(["list.txt", "layers-00.mkv", "track.m4a"]);
    expect(pass2.some((a) => a.endsWith("text-00.png") || a.endsWith("sticker-01.apng"))).toBe(false);
  });

  test("the track is mapped from input 2, after the one layer input, and the process is capped at 64 MiB per allocation", () => {
    const pass2 = argvs.at(-1) ?? [];
    expect(pass2).toContain("2:a:0");
    expect(pass2.slice(pass2.indexOf("-max_alloc"), pass2.indexOf("-max_alloc") + 2)).toEqual(["-max_alloc", "67108864"]);
  });

  test("the FFV1 layer file decodes under that cap: the finished file has exactly 90 frames and an AAC audio stream at 48 kHz stereo", async () => {
    expect(framesOut).toBe(90);
    const probed = await probeVideo(output);
    expect(probed.streams.find((s) => s.codec_type === "audio")).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });
  });

  test("the finished file passes the verifier: the box allow-list, the exact length, no tag of the track or the layers", async () => {
    expect(await verifyRenderedMp4(output, { frames: 90 })).toEqual({ ok: true });
  });

  test("the text layer is in its window [30, 60) and nowhere else", async () => {
    const luma = await lumaPerFrame(output, TEXT_BOX, 24);
    const shown = luma.map((v) => Math.abs(v - 235) <= 3);
    expect(shown).toEqual(luma.map((_, f) => f >= 30 && f < 60));
  });

  test("the sticker layer is there on every frame: its box is not the flat background", async () => {
    const luma = await lumaPerFrame(output, STICKER_BOX, 0);
    expect(luma).toHaveLength(90);
    expect(Math.max(...luma) - Math.min(...luma)).toBeGreaterThan(1);
  });

  test("a failure of the layer call stops the render before pass 2, with no track measured twice", async () => {
    const failing = async (opts: RunFfmpegArgvOptions): Promise<void> => {
      if (opts.output.includes("layers-")) throw new FfmpegError("ffmpeg exited with code 1", 1, "boom");
      await runFfmpegArgv(opts);
    };
    const flat = join(dir, "flat.jpg");
    await expect(
      runRenderJob(
        {
          jobId: "job-00000002",
          tmpRoot: join(dir, "render-tmp"),
          seed: 1,
          clips,
          resolvePhoto: () => ({ path: flat, width: 720, height: 1280 }),
          overlays: [{ path: join(dir, "render-tmp", "job-00000002", "text-00.png"), format: "png", box: TEXT_BOX, resize: false, startFrame: 30, endFrame: 60 }],
          stageLayers: async (to) => copyFileSync(join(dir, "white.png"), join(to, "text-00.png")),
          audio: { kind: "music", startMs: 2000, data: TRACK_BYTES },
          output: join(dir, ".studio-part-job-00000002.mp4"),
          signal: new AbortController().signal,
          onProgress: () => undefined,
        },
        { run: failing },
      ),
    ).rejects.toBeInstanceOf(FfmpegError);
  });
});
