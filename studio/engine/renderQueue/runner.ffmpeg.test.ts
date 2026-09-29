import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { FfmpegTimeoutError, runFfmpegArgv, type FfmpegSpawner, type RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { probeVideo, videoFrames } from "../render/ffmpeg.testkit";
import { runRenderJob, type RenderRunInput } from "./runner";
useNativeGlobals();

// REAL ffmpeg (the bundled build) through the runner: one clip through both
// passes, a cancel in the middle of pass 1, and a timeout. Each leaves no job
// folder and no process behind. SHORT: about 3 s in all.

const PHOTO = join(import.meta.dir, "../face/fixtures/images/render-best-home-1.jpg");
const clip = (clipId: string, durationMs: number, motion: "static" | "kenburns"): Clip => ({
  clipId,
  durationMs,
  transitionIn: "cut",
  kind: "photo",
  cell: { photo: { source: "scene", photoId: "photo-00000001" }, focus: { x: 0.5, y: 0.38 } },
  motion,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rig(clips: Clip[], over: Partial<RenderRunInput> = {}) {
  const root = mkdtempSync(join(tmpdir(), "studio-runner-real-"));
  dirs.push(root);
  const exportDir = join(root, "export");
  mkdirSync(exportDir);
  const input: RenderRunInput = {
    jobId: "job-00000001",
    tmpRoot: join(root, "render-tmp"),
    seed: 3,
    clips,
    resolvePhoto: () => ({ path: PHOTO, width: 720, height: 1280 }),
    overlays: [],
    audio: { kind: "silent" },
    output: join(exportDir, ".studio-part-job-00000001.mp4"),
    signal: new AbortController().signal,
    onProgress: () => {},
    ...over,
  };
  return { input, jobDir: join(root, "render-tmp", "job-00000001") };
}

/** Node's spawn, remembering every pid so a test can check none is left alive. */
function recordingSpawner(): { spawner: FfmpegSpawner; pids: number[] } {
  const pids: number[] = [];
  const spawner: FfmpegSpawner = (command, args, options) => {
    const child = spawn(command, [...args], { ...options, stdio: [...options.stdio] });
    if (child.pid !== undefined) pids.push(child.pid);
    return child;
  };
  return { spawner, pids };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const withSpawner = (spawner: FfmpegSpawner, override: Partial<RunFfmpegArgvOptions> = {}) => (opts: RunFfmpegArgvOptions): Promise<void> => runFfmpegArgv({ ...opts, spawner, ...override });

describe("runRenderJob on real ffmpeg", () => {
  test("renders one clip through both passes into the given output, with the exact frame count, and leaves no job folder", async () => {
    const { input, jobDir } = rig([clip("a", 1000, "static")]);
    const progress: number[] = [];
    const { spawner, pids } = recordingSpawner();

    const outcome = await runRenderJob({ ...input, onProgress: (n) => progress.push(n) }, { run: withSpawner(spawner) });

    expect(outcome).toEqual({ totalFrames: 30 });
    expect(pids).toHaveLength(2); // pass 1, then pass 2
    expect(await videoFrames(input.output)).toBe(30);
    const probed = await probeVideo(input.output);
    expect(probed.streams.find((s) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
    expect(existsSync(jobDir)).toBe(false);
    expect(progress.every((n, i) => i === 0 || n > (progress[i - 1] ?? 0))).toBe(true);
    expect(Math.max(0, ...progress)).toBeLessThan(30);
    expect(pids.some(alive)).toBe(false);
  }, 20_000);

  test("a cancel in the middle of pass 1 kills ffmpeg, leaves no job folder and no output, and no process", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by the user");
    const { spawner, pids } = recordingSpawner();
    const { input, jobDir } = rig([clip("a", 2000, "kenburns")], {
      signal: controller.signal,
      onProgress: () => controller.abort(reason), // the first frames prove pass 1 is really running
    });

    await expect(runRenderJob(input, { run: withSpawner(spawner) })).rejects.toBe(reason);

    expect(pids).toHaveLength(1);
    expect(pids.some(alive)).toBe(false);
    expect(existsSync(jobDir)).toBe(false);
    expect(existsSync(input.output)).toBe(false);
  }, 20_000);

  test("a timeout kills ffmpeg, rejects with a timeout error of the whole budget, and leaves nothing", async () => {
    const { spawner, pids } = recordingSpawner();
    const { input, jobDir } = rig([clip("a", 2000, "kenburns")]);

    // The job's own budget is at least 90 s; the wrapper makes one call's slice 250 ms.
    const error = await runRenderJob(input, { run: withSpawner(spawner, { timeoutMs: 250 }) }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    expect(pids).toHaveLength(1);
    expect(pids.some(alive)).toBe(false);
    expect(existsSync(jobDir)).toBe(false);
    expect(existsSync(input.output)).toBe(false);
  }, 20_000);
});
