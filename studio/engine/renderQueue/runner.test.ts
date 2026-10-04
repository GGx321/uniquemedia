import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { FfmpegError, FfmpegTimeoutError, runFfmpegArgv, type RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { fakeSpawner, outputOf, type SpawnCall } from "../../node/fakeFfmpeg.testkit";
import { LAYER_FILE_BYTES_PER_FRAME, RenderGraphError } from "../render";
import { renderTimeoutMs } from "./progress";
import { RenderFailure } from "./queue";
import { runRenderJob, type RenderRunInput, type RenderRunDeps } from "./runner";
import { scrubber } from "./scrubber";
import { __setFfmpegPathOverrideForTests } from "../../node/ffmpegBinary";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The runner of one render job against a scripted ffmpeg and a real temp
// folder: the two passes in order, the folded progress, the timeout, and the
// cleanup on every way out.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-runner-"));
  dirs.push(dir);
  return dir;
}

const scene = (id: string) => ({ photo: { source: "scene" as const, photoId: id }, focus: { x: 0.5, y: 0.5 } });
const clip = (clipId: string, durationMs: number): Clip => ({ clipId, durationMs, transitionIn: "cut", kind: "photo", cell: scene(`photo-${clipId}`), motion: "static" });
const CLIPS: Clip[] = [clip("a", 1000), clip("b", 1000)]; // 60 frames of the final video

interface Rig {
  readonly tmpRoot: string;
  readonly exportDir: string;
  readonly output: string;
  readonly jobDir: string;
  readonly input: RenderRunInput;
  readonly progress: number[];
}

function rig(over: Partial<RenderRunInput> = {}): Rig {
  const root = tempDir();
  const tmpRoot = join(root, "render-tmp");
  const exportDir = join(root, "export");
  mkdirSync(exportDir, { recursive: true });
  const output = join(exportDir, ".studio-part-job-00000001.mp4");
  const progress: number[] = [];
  const input: RenderRunInput = {
    jobId: "job-00000001",
    tmpRoot,
    seed: 1,
    clips: CLIPS,
    resolvePhoto: (ref) => ({ path: join(root, `${ref.source === "scene" ? ref.photoId : ref.mediaId}.jpg`), width: 720, height: 1280 }),
    overlays: [],
    audio: { kind: "silent" },
    output,
    signal: new AbortController().signal,
    onProgress: (done) => progress.push(done),
    ...over,
  };
  return { tmpRoot, exportDir, output, jobDir: join(tmpRoot, "job-00000001"), input, progress };
}

/** A well-behaved ffmpeg: writes its output, reports its frames in steps, exits 0. */
function goodFfmpeg(call: SpawnCall): void {
  writeFileSync(outputOf(call.args), "data");
  const frames = call.args.includes("concat") ? 60 : 30;
  call.child.report(Math.floor(frames / 2));
  call.child.report(frames, true);
  call.child.exit(0);
}

function depsWith(script: (call: SpawnCall, index: number) => void, extra: Partial<RenderRunDeps> = {}, killExits = true): { deps: RenderRunDeps; calls: SpawnCall[] } {
  const { spawner, calls } = fakeSpawner(script, killExits);
  const run = (opts: RunFfmpegArgvOptions): Promise<void> => runFfmpegArgv({ ...opts, spawner, env: {} });
  return { deps: { run, ...extra }, calls };
}

describe("runRenderJob: the passes", () => {
  test("runs pass 1 for each clip into the job folder, then pass 2 into the given output, in that order", async () => {
    const r = rig();
    const { deps, calls } = depsWith(goodFfmpeg);

    await runRenderJob(r.input, deps);

    expect(calls.map((c) => outputOf(c.args))).toEqual([join(r.jobDir, "clip-00.mkv"), join(r.jobDir, "clip-01.mkv"), r.output]);
    expect(calls[2]?.args).toContain("concat");
    expect(existsSync(r.output)).toBe(true);
  });

  test("runs one ffmpeg at a time within a job", async () => {
    const r = rig();
    let live = 0;
    let peak = 0;
    const { deps } = depsWith((call) => {
      live++;
      peak = Math.max(peak, live);
      setTimeout(() => {
        live--;
        goodFfmpeg(call);
      }, 5);
    });

    await runRenderJob(r.input, deps);

    expect(peak).toBe(1);
  });

  test("writes the concat list into the job folder before pass 2 starts and runs pass 2 there", async () => {
    const r = rig();
    let listAtPass2: string | undefined;
    const { deps, calls } = depsWith((call, index) => {
      if (index === 2) listAtPass2 = readFileSync(join(r.jobDir, "list.txt"), "utf8");
      goodFfmpeg(call);
    });

    await runRenderJob(r.input, deps);

    expect(listAtPass2).toBe("file 'clip-00.mkv'\nfile 'clip-01.mkv'\n");
    expect(calls[2]?.options.cwd).toBe(r.jobDir);
    expect(calls[0]?.options.cwd).toBeUndefined();
  });

  test("resolves with the frames of the final video", async () => {
    const r = rig();
    const { deps } = depsWith(goodFfmpeg);

    await expect(runRenderJob(r.input, deps)).resolves.toEqual({ totalFrames: 60 });
  });
});

describe("runRenderJob: progress", () => {
  test("reports frames of the final video: monotonic, and below the total until the job itself ends", async () => {
    const r = rig();
    const { deps } = depsWith(goodFfmpeg);

    await runRenderJob(r.input, deps);

    expect(r.progress.length).toBeGreaterThan(2);
    for (let i = 1; i < r.progress.length; i++) expect(r.progress[i]).toBeGreaterThan(r.progress[i - 1] ?? 0);
    expect(Math.max(...r.progress)).toBeLessThan(60);
  });

  test("reaches the end of pass 1's share before pass 2 reports anything", async () => {
    const r = rig();
    const seenBeforePass2: number[] = [];
    const { deps } = depsWith((call, index) => {
      if (index === 2) seenBeforePass2.push(...r.progress);
      goodFfmpeg(call);
    });

    await runRenderJob(r.input, deps);

    expect(seenBeforePass2.at(-1)).toBe(21); // floor(60 x 35 / 100): both clips done
    expect(r.progress.at(-1)).toBe(59);
  });

  test("counts the frames of clips already done when the next clip reports its own", async () => {
    const r = rig();
    const { deps } = depsWith((call, index) => {
      if (index === 1) {
        // The second clip's first report: 30 frames of clip 0 + 15 of clip 1 = 45 of 60 pass-1 frames.
        call.child.report(15);
        call.child.report(30, true);
        writeFileSync(outputOf(call.args), "data");
        call.child.exit(0);
        return;
      }
      goodFfmpeg(call);
    });

    await runRenderJob(r.input, deps);

    expect(r.progress).toContain(Math.floor((45 * 35) / 100)); // 15
  });

  test("a listener that throws stops the job with its own error", async () => {
    const boom = new Error("window closed");
    const r = rig({
      onProgress: () => {
        throw boom;
      },
    });
    const { deps } = depsWith((call) => call.child.report(10));

    await expect(runRenderJob(r.input, deps)).rejects.toBe(boom);
    expect(existsSync(r.jobDir)).toBe(false);
  });
});

describe("runRenderJob: the job folder and the output", () => {
  test("removes the job folder and keeps the output when it succeeds", async () => {
    const r = rig();
    const { deps } = depsWith(goodFfmpeg);

    await runRenderJob(r.input, deps);

    expect(existsSync(r.jobDir)).toBe(false);
    expect(readdirSync(r.tmpRoot)).toEqual([]);
    expect(existsSync(r.output)).toBe(true);
  });

  test("when ffmpeg fails in pass 1, rejects with its error and a short stderr tail, runs no pass 2, and leaves nothing", async () => {
    const r = rig();
    const { deps, calls } = depsWith((call) => {
      writeFileSync(outputOf(call.args), "half a clip");
      call.child.complain(`${"noise\n".repeat(5000)}Error: Cannot open input\n`);
      call.child.exit(1);
    });

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegError);
    if (!(error instanceof FfmpegError)) throw error;
    expect(error.exitCode).toBe(1);
    expect(error.stderrTail.length).toBeLessThanOrEqual(2000);
    expect(error.stderrTail).toContain("Cannot open input");
    expect(calls).toHaveLength(1);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("when pass 2 fails, removes the half-written output and the job folder", async () => {
    const r = rig();
    const { deps } = depsWith((call, index) => {
      if (index < 2) return goodFfmpeg(call);
      writeFileSync(outputOf(call.args), "half a video");
      call.child.exit(1);
    });

    await expect(runRenderJob(r.input, deps)).rejects.toBeInstanceOf(FfmpegError);

    expect(existsSync(r.output)).toBe(false);
    expect(existsSync(r.jobDir)).toBe(false);
  });

  test("when ffmpeg cannot be started, rejects with that error and leaves nothing", async () => {
    const r = rig();
    const run = (): Promise<void> => Promise.reject(new Error("spawn ffmpeg ENOENT"));

    await expect(runRenderJob(r.input, { run })).rejects.toThrow("ENOENT");

    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("a folder that cannot be removed is reported through warn and never masks the render's own error", async () => {
    const r = rig();
    const warnings: Array<[string, unknown]> = [];
    const { deps } = depsWith((call) => call.child.exit(1), {
      removeTree: () => Promise.reject(Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" })),
      removeFile: () => Promise.reject(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })),
      warn: (what, error) => warnings.push([what, error]),
    });

    await expect(runRenderJob(r.input, deps)).rejects.toBeInstanceOf(FfmpegError);

    expect(warnings.map(([what]) => what)).toEqual(["job folder", "unfinished output"]);
    expect(warnings[0]?.[1]).toBeInstanceOf(Error);
  });

  test("a folder that cannot be removed after a good render is reported, and the render still succeeds", async () => {
    const r = rig();
    const warnings: string[] = [];
    const { deps } = depsWith(goodFfmpeg, {
      removeTree: () => Promise.reject(new Error("EPERM")),
      warn: (what) => warnings.push(what),
    });

    await expect(runRenderJob(r.input, deps)).resolves.toEqual({ totalFrames: 60 });

    expect(warnings).toEqual(["job folder"]);
  });

  test("a graph the builder refuses rejects with that refusal before anything is created or started, and is never retried", async () => {
    const r = rig({ resolvePhoto: () => undefined });
    const { deps, calls } = depsWith(goodFfmpeg);

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderGraphError);
    expect(error).toMatchObject({ code: "PHOTO_UNRESOLVED" });
    expect(calls).toHaveLength(0);
    expect(existsSync(r.tmpRoot)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("refuses a job id that could leave the render-tmp folder", async () => {
    const r = rig({ jobId: "../evil" });

    await expect(runRenderJob(r.input, {})).rejects.toThrow(TypeError);
  });

  test.each(["JOB-00000001", "job-1", `job-${"0".repeat(70)}`, "job_00000001", ""])("refuses %p, which is not a contract Id", async (jobId) => {
    const r = rig({ jobId });

    await expect(runRenderJob(r.input, {})).rejects.toThrow(TypeError);
  });

  test.each([["precious.mp4"], [".studio-part-job-00000002.mp4"], [".studio-part-job-00000001.mov"]])(
    "refuses an output named %p: only .studio-part-<jobId>.mp4 may be deleted on failure, so nothing is built, started or removed",
    async (name) => {
      const r = rig();
      const output = join(r.exportDir, name);
      writeFileSync(output, "the owner's own file");
      const { deps, calls } = depsWith(goodFfmpeg);

      await expect(runRenderJob({ ...r.input, output }, deps)).rejects.toThrow(TypeError);

      expect(calls).toHaveLength(0);
      expect(readFileSync(output, "utf8")).toBe("the owner's own file");
      expect(existsSync(r.tmpRoot)).toBe(false);
    },
  );

  test("reports no progress after the cancel, even when ffmpeg exited 0 in the same tick as the abort", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const r = rig({ signal: controller.signal, onProgress: (n) => seen.push(n) });
    // The process exits 0 WITHOUT its last progress report, and the cancel lands in the same tick: the only
    // report left is the runner's own "this clip is done" one, and its guard is what keeps it out.
    const { deps } = depsWith((call) => {
      writeFileSync(outputOf(call.args), "data");
      call.child.exit(0);
      controller.abort(new Error("cancelled"));
    });

    await expect(runRenderJob(r.input, deps)).rejects.toThrow("cancelled");

    expect(seen).toEqual([]);
  });

  test("the same exit without a cancel does report the clip as done (so the test above is not vacuous)", async () => {
    const r = rig();
    const { deps } = depsWith((call) => {
      writeFileSync(outputOf(call.args), "data");
      call.child.exit(0);
    });

    await runRenderJob(r.input, deps);

    expect(r.progress[0]).toBe(10); // one of two 30-frame clips of 60: 35% of 30
  });

  test("keeps the user's folders out of the stderr tail: the temp root becomes <tmp>, the export folder <export>", async () => {
    const r = rig();
    const { deps } = depsWith((call) => {
      call.child.complain(`Error opening ${join(r.jobDir, "clip-00.mkv")}\nCannot write ${r.output}\n`);
      call.child.exit(1);
    });

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegError);
    if (!(error instanceof FfmpegError)) throw error;
    expect(error.stderrTail).not.toContain(r.tmpRoot);
    expect(error.stderrTail).not.toContain(r.exportDir);
    expect(error.stderrTail).toContain(`<tmp>/job-00000001/clip-00.mkv`);
    expect(error.stderrTail).toContain(`<export>/.studio-part-job-00000001.mp4`);
  });

  test("scrubs a timeout's tail the same way", async () => {
    const r = rig();
    const clock = { now: 0 };
    const run = (): Promise<void> => {
      clock.now += 1;
      return Promise.reject(new FfmpegTimeoutError(5, `writing ${r.output}`));
    };

    const error = await runRenderJob(r.input, { run, now: () => clock.now }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    if (!(error instanceof FfmpegTimeoutError)) throw error;
    expect(error.stderrTail).toBe("writing <export>/.studio-part-job-00000001.mp4");
  });
});

describe("runRenderJob: the user's input paths stay out of the error", () => {
  const failWith = (text: string): ((call: SpawnCall) => void) => (call) => {
    call.child.complain(text);
    call.child.exit(1);
  };

  test("a library photo's path in ffmpeg's error reaches the job as <photo>", async () => {
    const r = rig();
    const photo = r.input.resolvePhoto({ source: "scene", photoId: "photo-a" })?.path ?? "";
    const { deps } = depsWith(failWith(`Error opening input file ${photo}: No such file or directory\n`));

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegError);
    if (!(error instanceof FfmpegError)) throw error;
    expect(error.stderrTail).toBe("Error opening input file <photo>: No such file or directory\n");
  });

  test("the raw error is kept as a non-enumerable cause: serialising the scrubbed error shows no raw path", async () => {
    const r = rig();
    const photo = r.input.resolvePhoto({ source: "scene", photoId: "photo-a" })?.path ?? "";
    const { deps } = depsWith(failWith(`Error opening input file ${photo}\n`));

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    if (!(error instanceof FfmpegError)) throw error;
    expect(JSON.stringify(error)).not.toContain(dirname(r.tmpRoot));
    expect(Object.keys(error)).not.toContain("cause");
    expect(error.cause instanceof FfmpegError && error.cause.stderrTail).toContain(photo); // the raw one, for the log
  });

  test("a timeout's copy keeps its raw cause out of serialisation too", async () => {
    const r = rig();
    const clock = { now: 0 };
    const run = (): Promise<void> => {
      clock.now += 1;
      return Promise.reject(new FfmpegTimeoutError(5, `writing ${r.output}`));
    };

    const error = await runRenderJob(r.input, { run, now: () => clock.now }).catch((e: unknown) => e);

    if (!(error instanceof FfmpegTimeoutError)) throw error;
    expect(JSON.stringify(error)).not.toContain(r.exportDir);
    expect(error.cause).toBeInstanceOf(FfmpegTimeoutError);
  });

  test("an overlay's path in ffmpeg's error reaches the job as <overlay>", async () => {
    const r = rig();
    const overlayPath = join(dirname(r.tmpRoot), "stickers", "star.png");
    const overlay = { path: overlayPath, format: "png" as const, box: { x: 100, y: 300, w: 880, h: 200 }, resize: false, startFrame: 0, endFrame: 30 };
    const { deps } = depsWith(failWith(`Error opening input file ${overlayPath}: Invalid data\n`));

    const error = await runRenderJob({ ...r.input, overlays: [overlay] }, deps).catch((e: unknown) => e);

    if (!(error instanceof FfmpegError)) throw error;
    expect(error.stderrTail).toBe("Error opening input file <overlay>: Invalid data\n");
  });

  test("a path split by the 2000-character cut leaves no fragment of the user's folders", async () => {
    const r = rig();
    const photo = r.input.resolvePhoto({ source: "scene", photoId: "photo-a" })?.path ?? "";
    const prefix = "Error opening input file ";
    const line = `${prefix}${photo}: No such file`;
    // The tail's first character lands inside the temp folder's name, so the tail begins mid-path.
    const before = `${"x".repeat(100)}\n`;
    const cutAt = before.length + prefix.length + photo.indexOf("studio-runner-") + 3;
    const filler = "y".repeat(cutAt + 2000 - (before.length + line.length + 2));
    const stderr = `${before}${line}\n${filler}\n`;
    expect(stderr.length - cutAt).toBe(2000);
    const { deps } = depsWith(failWith(stderr));

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    if (!(error instanceof FfmpegError)) throw error;
    expect(error.stderrTail).not.toContain("dio-runner-");
    expect(error.stderrTail).not.toContain("photo-a");
  });
});

describe("runRenderJob: a file-system error names no user folder either", () => {
  test("a job folder that cannot be made fails with the temp root masked as <tmp>, keeping its errno code", async () => {
    const r = rig();
    writeFileSync(r.tmpRoot, "a file where the temp root should be");
    const warnings: string[] = [];
    const { deps } = depsWith(goodFfmpeg, { warn: (what) => warnings.push(what) });

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    if (!(error instanceof Error)) throw new Error("expected the job to fail");
    expect(error.message).not.toContain(r.tmpRoot);
    expect(error.message).toContain("<tmp>");
    expect("code" in error && error.code).toBe("ENOTDIR");
    expect(error.cause).toBeInstanceOf(Error); // the raw error, for the log
  });
});

describe("runRenderJob: what else may name the user's folders", () => {
  const FAKE_HOME_NAME = "Mia Secret";

  afterEach(() => __setFfmpegPathOverrideForTests(undefined));

  test("a spawn error for the ffmpeg binary under the user's home reaches the job with the home masked as ~", async () => {
    const r = rig();
    const home = join(dirname(r.tmpRoot), FAKE_HOME_NAME);
    __setFfmpegPathOverrideForTests(join(home, "AppData", "Programs", "studio", "ffmpeg"));
    const run = (opts: RunFfmpegArgvOptions): Promise<void> => runFfmpegArgv({ ...opts, env: {} });

    const error = await runRenderJob(r.input, { run, home }).catch((e: unknown) => e);

    if (!(error instanceof Error)) throw new Error("expected the job to fail");
    expect(error.message).not.toContain(FAKE_HOME_NAME);
    expect(error.message).toContain("~/AppData/Programs/studio/ffmpeg");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause instanceof Error && error.cause.message).toContain(FAKE_HOME_NAME);
  });

  test("a cancel is not wrapped: the abort reason itself comes out", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const r = rig({ signal: controller.signal });
    const { deps } = depsWith((call) => {
      controller.abort(reason);
      call.child.exit(null, "SIGKILL");
    });

    await expect(runRenderJob(r.input, deps)).rejects.toBe(reason);
  });

  test("a multi-byte character split across two stderr chunks does not hide a Cyrillic path from the scrubber", async () => {
    const r = rig();
    const path = join(dirname(r.tmpRoot), "Мия", "Фото", "photo-a.jpg");
    const input = { ...r.input, resolvePhoto: () => ({ path, width: 720, height: 1280 }) };
    const bytes = Buffer.from(`Error opening input file ${path}: No such file\n`);
    const cut = bytes.indexOf(Buffer.from("М")) + 1; // inside the two bytes of "М"
    const { deps } = depsWith((call) => {
      call.child.complain(bytes.subarray(0, cut));
      setTimeout(() => {
        call.child.complain(bytes.subarray(cut));
        call.child.exit(1);
      }, 5);
    });

    const error = await runRenderJob(input, deps).catch((e: unknown) => e);

    if (!(error instanceof FfmpegError)) throw error;
    expect(error.stderrTail).toBe("Error opening input file <photo>: No such file\n");
  });
});

describe("runRenderJob: cancel", () => {
  test("a cancel during pass 1 kills ffmpeg, rejects with the reason, runs nothing more and leaves nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const r = rig({ signal: controller.signal });
    const { deps, calls } = depsWith((call) => {
      writeFileSync(outputOf(call.args), "half a clip");
      call.child.report(5);
      setTimeout(() => controller.abort(reason), 5);
    }, {}, true);

    await expect(runRenderJob(r.input, deps)).rejects.toBe(reason);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
    expect(calls[0]?.child.closed).toBe(true);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("a cancel between the passes runs no pass 2", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled between passes");
    const r = rig({ signal: controller.signal });
    const { deps, calls } = depsWith((call, index) => {
      goodFfmpeg(call);
      if (index === 1) controller.abort(reason);
    });

    await expect(runRenderJob(r.input, deps)).rejects.toBe(reason);

    expect(calls).toHaveLength(2);
    expect(existsSync(r.jobDir)).toBe(false);
  });

  test("a job cancelled before it starts creates no folder and starts no ffmpeg", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled while queued"));
    const r = rig({ signal: controller.signal });
    const { deps, calls } = depsWith(goodFfmpeg);

    await expect(runRenderJob(r.input, deps)).rejects.toThrow("cancelled while queued");

    expect(calls).toHaveLength(0);
    expect(existsSync(r.tmpRoot)).toBe(false);
  });

  test("a cancel that arrives after pass 2 exited 0 is too late: the render resolves and the output stays", async () => {
    const controller = new AbortController();
    const r = rig({ signal: controller.signal });
    const { deps } = depsWith((call, index) => {
      goodFfmpeg(call);
      if (index === 2) controller.abort(new Error("too late"));
    });

    await expect(runRenderJob(r.input, deps)).resolves.toEqual({ totalFrames: 60 });

    expect(existsSync(r.output)).toBe(true);
    expect(existsSync(r.jobDir)).toBe(false);
  });
});

describe("runRenderJob: beforePass2 (the export folder is re-checked right before the long write)", () => {
  test("runs after pass 1 has finished and before pass 2 starts, once", async () => {
    const order: string[] = [];
    const r = rig({ beforePass2: () => void order.push("hook") });
    const { deps } = depsWith((call, index) => {
      order.push(`ffmpeg-${index}`);
      goodFfmpeg(call);
    });

    await runRenderJob(r.input, deps);

    expect(order).toEqual(["ffmpeg-0", "ffmpeg-1", "hook", "ffmpeg-2"]);
  });

  test("a refusal from the hook stops the job before pass 2, removes the job folder and the output, and is the error the job ends with", async () => {
    const refusal = new Error("the export folder is not what it was");
    const r = rig({ beforePass2: () => Promise.reject(refusal) });
    writeFileSync(r.output, "pre-created"); // what the hook's owner made before pass 2
    const { deps, calls } = depsWith(goodFfmpeg);

    await expect(runRenderJob(r.input, deps)).rejects.toBe(refusal);

    expect(calls).toHaveLength(2);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("is not called for a job cancelled between the passes", async () => {
    const controller = new AbortController();
    let called = false;
    const r = rig({ signal: controller.signal, beforePass2: () => void (called = true) });
    const { deps } = depsWith((call, index) => {
      goodFfmpeg(call);
      if (index === 1) controller.abort(new Error("cancelled between passes"));
    });

    await expect(runRenderJob(r.input, deps)).rejects.toThrow("cancelled between passes");

    expect(called).toBe(false);
  });
});

describe("runRenderJob: the timeout", () => {
  function recordingRun(clock: { now: number }, advance: number[]): { run: (o: RunFfmpegArgvOptions) => Promise<void>; timeouts: Array<number | undefined> } {
    const timeouts: Array<number | undefined> = [];
    const run = (opts: RunFfmpegArgvOptions): Promise<void> => {
      timeouts.push(opts.timeoutMs);
      writeFileSync(opts.argv.at(-1) ?? "", "data");
      clock.now += advance[timeouts.length - 1] ?? 0;
      return Promise.resolve();
    };
    return { run, timeouts };
  }

  test("gives the whole job max(90 s, 30 x its seconds), shared by its calls: each gets what is left", async () => {
    const r = rig();
    const clock = { now: 1_000_000 };
    const { run, timeouts } = recordingRun(clock, [10_000, 20_000, 0]);

    await runRenderJob(r.input, { run, now: () => clock.now });

    const whole = renderTimeoutMs(60);
    expect(whole).toBe(90_000);
    expect(timeouts).toEqual([whole, whole - 10_000, whole - 30_000]);
  });

  test("fails with a timeout error naming the whole budget, without starting a call the budget cannot pay for", async () => {
    const r = rig();
    const clock = { now: 0 };
    const { run, timeouts } = recordingRun(clock, [95_000]);

    const error = await runRenderJob(r.input, { run, now: () => clock.now }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    if (!(error instanceof FfmpegTimeoutError)) throw error;
    expect(error.timeoutMs).toBe(90_000);
    expect(timeouts).toHaveLength(1);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("names the whole budget when a single call runs out its slice", async () => {
    const r = rig();
    const clock = { now: 0 };
    const run = (opts: RunFfmpegArgvOptions): Promise<void> => {
      clock.now += 30_000;
      return Promise.reject(new FfmpegTimeoutError(opts.timeoutMs ?? 0, "last words"));
    };

    const error = await runRenderJob(r.input, { run, now: () => clock.now }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    if (!(error instanceof FfmpegTimeoutError)) throw error;
    expect(error.timeoutMs).toBe(90_000);
    expect(error.stderrTail).toBe("last words");
  });
});

describe("runRenderJob: the layer pass (3b.6)", () => {
  /** A text PNG over frames [10, 40) and a sticker over the whole 60-frame timeline, with paths inside the job folder as `resolveLayers` makes them. */
  const layersOf = (jobDir: string): RenderRunInput["overlays"] => [
    { path: join(jobDir, "text-00.png"), format: "png", box: { x: 100, y: 300, w: 880, h: 200 }, resize: false, startFrame: 10, endFrame: 40 },
    { path: join(jobDir, "sticker-01.apng"), format: "apng", box: { x: 600, y: 200, w: 216, h: 216 }, resize: true, startFrame: 0, endFrame: 60, loopFrames: 24, sourceSize: { w: 320, h: 320 } },
  ];
  /** A good ffmpeg that reports the frames its call makes: a layer call and pass 2 make 60, a clip 30. */
  function layerAwareFfmpeg(call: SpawnCall): void {
    writeFileSync(outputOf(call.args), "data");
    const frames = call.args.includes("concat") || outputOf(call.args).includes("layers-") ? 60 : 30;
    call.child.report(Math.floor(frames / 2));
    call.child.report(frames, true);
    call.child.exit(0);
  }
  const inputsOf = (args: readonly string[]): string[] => args.flatMap((a, i) => (a === "-i" ? [args[i + 1] ?? ""] : []));

  test("runs the layer call after every clip and before pass 2, one ffmpeg at a time", async () => {
    const r = rig();
    const { deps, calls } = depsWith(layerAwareFfmpeg);

    await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, deps);

    expect(calls.map((c) => outputOf(c.args))).toEqual([join(r.jobDir, "clip-00.mkv"), join(r.jobDir, "clip-01.mkv"), join(r.jobDir, "layers-00.mkv"), r.output]);
  });

  test("hands pass 2 the layer file as its one overlay, never the layers themselves", async () => {
    const r = rig();
    const { deps, calls } = depsWith(layerAwareFfmpeg);

    await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, deps);

    expect(inputsOf(calls.at(-1)?.args ?? [])).toEqual(["list.txt", join(r.jobDir, "layers-00.mkv")]);
  });

  test("the layer call reads the staged files by their own paths and stops on a broken frame", async () => {
    const r = rig();
    const { deps, calls } = depsWith(layerAwareFfmpeg);

    await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, deps);

    const layerCall = calls[2]?.args ?? [];
    expect(inputsOf(layerCall)).toEqual([join(r.jobDir, "text-00.png"), join(r.jobDir, "sticker-01.apng")]);
    expect(layerCall).toContain("-xerror");
  });

  test("stages the layer files once, into the job folder, after it exists and before any ffmpeg starts", async () => {
    const r = rig();
    const staged: string[] = [];
    let folderExistedWhenStaged = false;
    let callsWhenStaged = -1;
    const { deps, calls } = depsWith(layerAwareFfmpeg);

    await runRenderJob(
      {
        ...r.input,
        overlays: layersOf(r.jobDir),
        stageLayers: async (dir) => {
          staged.push(dir);
          folderExistedWhenStaged = existsSync(dir);
          callsWhenStaged = calls.length;
        },
      },
      deps,
    );

    expect(staged).toEqual([r.jobDir]);
    expect(folderExistedWhenStaged).toBe(true);
    expect(callsWhenStaged).toBe(0);
  });

  test("a job with no layers stages nothing and runs no layer call, exactly the old three calls", async () => {
    const r = rig();
    let staged = false;
    const { deps, calls } = depsWith(goodFfmpeg);

    await runRenderJob({ ...r.input, stageLayers: async () => void (staged = true) }, deps);

    expect(staged).toBe(false);
    expect(calls).toHaveLength(3);
  });

  test("splits heavy layers into chained calls and gives pass 2 the last file", async () => {
    const r = rig();
    const heavy = (k: number) => ({ path: join(r.jobDir, `sticker-0${k}.apng`), format: "apng" as const, box: { x: 10 * k, y: 100, w: 648, h: 648 }, resize: true, startFrame: 0, endFrame: 60, loopFrames: 300, sourceSize: { w: 360, h: 360 } });
    const { deps, calls } = depsWith(layerAwareFfmpeg);

    await runRenderJob({ ...r.input, overlays: [heavy(0), heavy(1), heavy(2)] }, deps);

    const outputs = calls.map((c) => outputOf(c.args));
    const layerFiles = outputs.filter((o) => o.includes("layers-"));
    expect(layerFiles.length).toBeGreaterThan(1);
    expect(layerFiles).toEqual(layerFiles.map((_, i) => join(r.jobDir, `layers-0${i}.mkv`)));
    expect(inputsOf(calls.at(-1)?.args ?? [])).toEqual(["list.txt", layerFiles.at(-1) ?? ""]);
  });

  test("reports progress that stays monotonic and below the total, and spends the whole pass-1 share on the clips AND the layer call", async () => {
    const r = rig();
    const seenBeforePass2: number[] = [];
    const { deps } = depsWith((call, index) => {
      if (index === 3) seenBeforePass2.push(...r.progress);
      layerAwareFfmpeg(call);
    });

    await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, deps);

    expect(seenBeforePass2.at(-1)).toBe(21); // floor(60 x 35 / 100): clips and layer call all done
    for (let i = 1; i < r.progress.length; i++) expect(r.progress[i]).toBeGreaterThan(r.progress[i - 1] ?? 0);
    expect(Math.max(...r.progress)).toBeLessThan(60);
  });

  test("halfway through the layer call the share is halfway between the clips' end and its own end", async () => {
    const r = rig();
    const beforePass2: number[] = [];
    const { deps } = depsWith((call, index) => {
      if (index === 3) beforePass2.push(...r.progress);
      if (index === 2) {
        call.child.report(30); // 30 of 60 layer frames: (60 + 30) of (60 + 60) stage frames, which is 45 of the 60 the final video has
        call.child.report(60, true);
        writeFileSync(outputOf(call.args), "data");
        call.child.exit(0);
        return;
      }
      layerAwareFfmpeg(call);
    });

    await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, deps);

    // The two clips are half of the stage's work (10 = floor(30 x 35 / 100)), the layer call's own half-way is 15, its end 21.
    expect(beforePass2).toEqual(expect.arrayContaining([10, Math.floor((45 * 35) / 100), 21]));
  });

  test("a layer call that fails ends the job with its error, runs no pass 2, and leaves nothing", async () => {
    const r = rig();
    const { deps, calls } = depsWith((call, index) => {
      if (index < 2) return goodFfmpeg(call);
      call.child.complain(`Error opening input file ${join(r.jobDir, "sticker-01.apng")}: Invalid data found\n`);
      call.child.exit(1);
    });

    const error = await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, deps).catch((e: unknown) => e);

    if (!(error instanceof FfmpegError)) throw error;
    expect(error.stderrTail).toContain("Invalid data found");
    expect(error.stderrTail).not.toContain(r.tmpRoot);
    expect(calls).toHaveLength(3);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("a staging failure that is the engine's own answer is thrown unchanged, before any ffmpeg, and leaves nothing", async () => {
    const r = rig();
    const failure = new RenderFailure({ code: "RENDER_FAILED", detail: "a built-in sticker could not be used (tampered)" });
    const { deps, calls } = depsWith(layerAwareFfmpeg);

    const error = await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir), stageLayers: () => Promise.reject(failure) }, deps).catch((e: unknown) => e);

    expect(error).toBe(failure);
    expect(calls).toHaveLength(0);
    expect(existsSync(r.jobDir)).toBe(false);
  });

  test("a staging failure from the file system names no user folder", async () => {
    const r = rig();
    const { deps } = depsWith(layerAwareFfmpeg);
    const eexist = Object.assign(new Error(`EEXIST: file already exists, open '${join(r.jobDir, "text-00.png")}'`), { code: "EEXIST" });

    const error = await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir), stageLayers: () => Promise.reject(eexist) }, deps).catch((e: unknown) => e);

    if (!(error instanceof Error)) throw new Error("expected the job to fail");
    expect(error.message).not.toContain(r.tmpRoot);
    expect(error.message).toBe("EEXIST: file already exists, open '<overlay>'"); // a staged file is one of the job's inputs, so it reads as one
    expect(Reflect.get(error, "code")).toBe("EEXIST");
  });

  test("a cancel during the layer call stops it and leaves nothing", async () => {
    const r = rig();
    const stop = new AbortController();
    const reason = new Error("cancelled");
    const { deps } = depsWith((call, index) => {
      if (index === 2) {
        setImmediate(() => stop.abort(reason));
        return; // the layer call hangs until the kill
      }
      goodFfmpeg(call);
    });

    const error = await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir), signal: stop.signal }, deps).catch((e: unknown) => e);

    expect(error).toBe(reason);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("removes each layer file once the next call has written its own, so at most two exist at once", async () => {
    const r = rig();
    const heavy = (k: number) => ({ path: join(r.jobDir, `sticker-0${k}.apng`), format: "apng" as const, box: { x: 10 * k, y: 100, w: 648, h: 648 }, resize: true, startFrame: 0, endFrame: 60, loopFrames: 300, sourceSize: { w: 360, h: 360 } });
    const seen: string[][] = [];
    const { deps, calls } = depsWith((call) => {
      if (outputOf(call.args).includes("layers-")) seen.push(readdirSync(r.jobDir).filter((f) => f.startsWith("layers-")).sort());
      layerAwareFfmpeg(call);
    });

    await runRenderJob({ ...r.input, overlays: [heavy(0), heavy(1), heavy(2), heavy(3)] }, deps);

    const layerCalls = calls.filter((c) => outputOf(c.args).includes("layers-")).length;
    expect(layerCalls).toBeGreaterThan(2);
    // When call n starts, layers-(n-1) is there (it is the call's main input) and everything older is already gone: with call n's own file
    // that is two files at the most.
    seen.forEach((files, n) => expect(files).toEqual(n === 0 ? [] : [`layers-0${n - 1}.mkv`]));
  });

  test("keeps the last layer file for pass 2, which reads it", async () => {
    const r = rig();
    let atPass2: string[] = [];
    const { deps } = depsWith((call) => {
      if (call.args.includes("concat")) atPass2 = readdirSync(r.jobDir).filter((f) => f.startsWith("layers-"));
      layerAwareFfmpeg(call);
    });

    await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, deps);

    expect(atPass2).toEqual(["layers-00.mkv"]);
  });

  test("refuses, before any ffmpeg and with no path, when the render folder's volume has less room than the layer files can take", async () => {
    const r = rig();
    const { deps, calls } = depsWith(layerAwareFfmpeg);
    const asked: string[] = [];

    const error = await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, { ...deps, freeBytes: async (dir) => (asked.push(dir), 1024 * 1024) }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderFailure);
    expect((error as RenderFailure).engineError.code).toBe("RENDER_FAILED");
    expect((error as RenderFailure).engineError.detail).toContain("free space");
    expect((error as RenderFailure).engineError.detail).not.toContain(r.tmpRoot);
    expect(calls).toHaveLength(0);
    expect(asked).toEqual([r.jobDir]);
    expect(existsSync(r.jobDir)).toBe(false);
  });

  test("goes on when the room is exactly what the layer files can take", async () => {
    const r = rig();
    const { deps } = depsWith(layerAwareFfmpeg);
    const need = 60 * LAYER_FILE_BYTES_PER_FRAME; // one call over 60 frames

    await expect(runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, { ...deps, freeBytes: async () => need })).resolves.toEqual({ totalFrames: 60 });
  });

  test("refuses when it is one byte short", async () => {
    const r = rig();
    const { deps } = depsWith(layerAwareFfmpeg);

    await expect(runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, { ...deps, freeBytes: async () => 60 * LAYER_FILE_BYTES_PER_FRAME - 1 })).rejects.toBeInstanceOf(RenderFailure);
  });

  test("goes on when the free space cannot be read: a volume that does not say is not refused", async () => {
    const r = rig();
    const { deps } = depsWith(layerAwareFfmpeg);

    await expect(runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, { ...deps, freeBytes: async () => null })).resolves.toEqual({ totalFrames: 60 });
  });

  test("never asks for the free space when there are no layers", async () => {
    const r = rig();
    const { deps } = depsWith(goodFfmpeg);
    let asked = false;

    await runRenderJob(r.input, { ...deps, freeBytes: async () => ((asked = true), 0) });

    expect(asked).toBe(false);
  });

  test("a layer call that wrote fewer frames than the timeline has stops the job before pass 2: a layer file is checked, not trusted", async () => {
    const r = rig();
    const { deps, calls } = depsWith((call) => {
      if (outputOf(call.args).includes("layers-")) {
        writeFileSync(outputOf(call.args), "data");
        call.child.report(59, true); // one frame short
        call.child.exit(0);
        return;
      }
      goodFfmpeg(call);
    });

    const error = await runRenderJob({ ...r.input, overlays: layersOf(r.jobDir) }, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("layer");
    expect(calls.some((c) => c.args.includes("concat"))).toBe(false);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("a layer past the montage's end is refused by the layer pass, before any ffmpeg starts", async () => {
    const r = rig();
    const past = { path: join(r.jobDir, "text-00.png"), format: "png" as const, box: { x: 100, y: 300, w: 880, h: 200 }, resize: false, startFrame: 30, endFrame: 61 };
    const { deps, calls } = depsWith(goodFfmpeg);

    await expect(runRenderJob({ ...r.input, overlays: [past] }, deps)).rejects.toMatchObject({ code: "BAD_OVERLAY" });
    expect(calls).toHaveLength(0);
  });
});

describe("runRenderJob: the private copies of own photos (3f.2)", () => {
  test("stages the copies once, into the job folder, after it exists and before any ffmpeg starts", async () => {
    const r = rig();
    const staged: string[] = [];
    let folderExistedWhenStaged = false;
    let callsWhenStaged = -1;
    const { deps, calls } = depsWith(goodFfmpeg);

    await runRenderJob(
      {
        ...r.input,
        stageOwnPhotos: async (dir) => {
          staged.push(dir);
          folderExistedWhenStaged = existsSync(dir);
          callsWhenStaged = calls.length;
        },
      },
      deps,
    );

    expect(staged).toEqual([r.jobDir]);
    expect(folderExistedWhenStaged).toBe(true);
    expect(callsWhenStaged).toBe(0);
  });

  test("a job with no own photos stages nothing and runs the same three calls", async () => {
    const r = rig();
    const { deps, calls } = depsWith(goodFfmpeg);

    await runRenderJob(r.input, deps);

    expect(calls).toHaveLength(3);
  });

  test("a staging failure that is the engine's own answer is thrown unchanged, before any ffmpeg, and leaves nothing", async () => {
    const r = rig();
    const failure = new RenderFailure({ code: "RENDER_FAILED", detail: "an own photo of this montage is no longer available: it was removed or changed" });
    const { deps, calls } = depsWith(goodFfmpeg);

    const error = await runRenderJob({ ...r.input, stageOwnPhotos: () => Promise.reject(failure) }, deps).catch((e: unknown) => e);

    expect(error).toBe(failure);
    expect(calls).toHaveLength(0);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("a staging failure from the file system names no user folder", async () => {
    const r = rig();
    const { deps } = depsWith(goodFfmpeg);
    const eexist = Object.assign(new Error(`EEXIST: file already exists, open '${join(r.tmpRoot, "job-00000001", "own-media-0000001.jpg")}'`), { code: "EEXIST" });

    const error = await runRenderJob({ ...r.input, stageOwnPhotos: () => Promise.reject(eexist) }, deps).catch((e: unknown) => e);

    if (!(error instanceof Error)) throw new Error("expected the job to fail");
    expect(error.message).not.toContain(r.tmpRoot);
  });

  test("a cancel that fires while the copies are made ends the job with the cancel's reason and leaves nothing", async () => {
    const controller = new AbortController();
    const r = rig({ signal: controller.signal });
    const { deps, calls } = depsWith(goodFfmpeg);
    const stop = new Error("cancelled by the owner");

    const error = await runRenderJob(
      {
        ...r.input,
        stageOwnPhotos: async () => {
          controller.abort(stop);
          throw stop;
        },
      },
      deps,
    ).catch((e: unknown) => e);

    expect(error).toBe(stop);
    expect(calls).toHaveLength(0);
    expect(existsSync(r.jobDir)).toBe(false);
  });
});

describe("runRenderJob: own video clips (3f.3b)", () => {
  const videoClip = (clipId: string, durationMs: number, trimStartMs = 0): Clip => ({ clipId, durationMs, transitionIn: "cut", kind: "video", mediaId: "media-0000001", trimStartMs, focus: null });
  /** One own video of one second and a photo of one second: the final video is 60 frames. */
  const videoRig = (over: Partial<RenderRunInput> = {}): Rig => {
    const r = rig();
    const copy = join(r.jobDir, "own-media-0000001.mp4");
    return { ...r, input: { ...r.input, clips: [videoClip("v", 1000, 300), clip("b", 1000)], resolveVideo: () => ({ path: copy, width: 1080, height: 570 }), ...over } };
  };

  test("stages the videos once, after the folder exists and the own photos are staged, and before any ffmpeg starts", async () => {
    const r = videoRig();
    const order: string[] = [];
    let callsWhenStaged = -1;
    const { deps, calls } = depsWith(goodFfmpeg);

    await runRenderJob(
      {
        ...r.input,
        stageOwnPhotos: async () => void order.push("photos"),
        stageOwnVideos: async (dir) => {
          order.push(`videos:${existsSync(dir)}:${dir === r.jobDir}`);
          callsWhenStaged = calls.length;
        },
      },
      deps,
    );

    expect(order).toEqual(["photos", "videos:true:true"]);
    expect(callsWhenStaged).toBe(0);
  });

  test("builds the video clip from the copy: the first ffmpeg reads the copy in the job folder", async () => {
    const r = videoRig();
    const { deps, calls } = depsWith(goodFfmpeg);

    await runRenderJob(r.input, deps);

    expect(calls[0]?.args[calls[0].args.indexOf("-i") + 1]).toBe(join(r.jobDir, "own-media-0000001.mp4"));
  });

  test("a staging failure that is the engine's own answer is thrown unchanged, before any ffmpeg, and leaves nothing", async () => {
    const r = videoRig();
    const failure = new RenderFailure({ code: "RENDER_FAILED", detail: "an own video of this montage is no longer available: it was removed or changed" });
    const { deps, calls } = depsWith(goodFfmpeg);

    const error = await runRenderJob({ ...r.input, stageOwnVideos: () => Promise.reject(failure) }, deps).catch((e: unknown) => e);

    expect(error).toBe(failure);
    expect(calls).toHaveLength(0);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("a staging failure from the file system names no user folder", async () => {
    const r = videoRig();
    const { deps } = depsWith(goodFfmpeg);
    const eio = Object.assign(new Error(`EIO: i/o error, write '${join(r.jobDir, "own-media-0000001.mp4")}'`), { code: "EIO" });

    const error = await runRenderJob({ ...r.input, stageOwnVideos: () => Promise.reject(eio) }, deps).catch((e: unknown) => e);

    if (!(error instanceof Error)) throw new Error("expected the job to fail");
    expect(error.message).not.toContain(r.tmpRoot);
  });

  test("a cancel that fires while the videos are copied ends the job with the cancel's reason and leaves nothing", async () => {
    const controller = new AbortController();
    const r = videoRig({ signal: controller.signal });
    const { deps, calls } = depsWith(goodFfmpeg);
    const stop = new Error("cancelled by the owner");

    const error = await runRenderJob(
      {
        ...r.input,
        stageOwnVideos: async () => {
          controller.abort(stop);
          throw stop;
        },
      },
      deps,
    ).catch((e: unknown) => e);

    expect(error).toBe(stop);
    expect(calls).toHaveLength(0);
    expect(existsSync(r.jobDir)).toBe(false);
  });

  test("the copy's path in ffmpeg's error reaches the job as <video>", async () => {
    const r = videoRig();
    const copy = join(r.jobDir, "own-media-0000001.mp4");
    const { deps } = depsWith((call) => {
      call.child.complain(`Error opening input file ${copy}: Invalid data found when processing input\n`);
      call.child.exit(1);
    });

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    if (!(error instanceof FfmpegError)) throw new Error("expected an FfmpegError");
    expect(error.stderrTail).toBe("Error opening input file <video>: Invalid data found when processing input\n");
  });

  test("a video clip whose ffmpeg wrote FEWER frames than the clip is long fails the job (never a silent shorter clip), naming no path", async () => {
    const r = videoRig();
    const { deps, calls } = depsWith((call) => {
      writeFileSync(outputOf(call.args), "data");
      // The video clip's file holds 29 frames, not 30.
      const frames = call.args.includes("concat") ? 60 : call.args.includes("-ss") ? 29 : 30;
      call.child.report(frames, true);
      call.child.exit(0);
    });

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderFailure);
    expect(error instanceof RenderFailure && error.engineError.code).toBe("RENDER_FAILED");
    expect(String(error)).toContain("29");
    expect(String(error)).not.toContain(r.tmpRoot);
    // It stops at the first bad clip: pass 1 of the photo and pass 2 never run.
    expect(calls).toHaveLength(1);
    expect(existsSync(r.jobDir)).toBe(false);
  });

  test("a video clip whose ffmpeg wrote MORE frames than the clip is long fails the job the same way", async () => {
    const r = videoRig();
    const { deps } = depsWith((call) => {
      writeFileSync(outputOf(call.args), "data");
      call.child.report(call.args.includes("-ss") ? 31 : 30, true);
      call.child.exit(0);
    });

    await expect(runRenderJob(r.input, deps)).rejects.toMatchObject({ engineError: { code: "RENDER_FAILED" } });
  });

  test("a video clip with exactly its frames passes, and so does the whole job", async () => {
    const r = videoRig();
    const { deps, calls } = depsWith(goodFfmpeg);

    await runRenderJob(r.input, deps);

    expect(calls).toHaveLength(3);
  });

  test("an ffmpeg that reports NO frames for a video clip fails the job closed (L-1): a real ffmpeg always reports them, and a count nobody saw is not a count", async () => {
    const r = videoRig();
    const { deps, calls } = depsWith((call) => {
      writeFileSync(outputOf(call.args), "data");
      call.child.exit(0);
    });

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderFailure);
    expect(error instanceof RenderFailure && error.engineError.code).toBe("RENDER_FAILED");
    expect(String(error)).not.toContain(r.tmpRoot);
    expect(calls).toHaveLength(1);
  });

  test("a photo job whose scripted ffmpeg reports no frames is still fine: only a video clip's count is held to ffmpeg's report", async () => {
    const r = rig();
    const { deps, calls } = depsWith((call) => {
      writeFileSync(outputOf(call.args), "data");
      call.child.exit(0);
    });

    await runRenderJob(r.input, deps);

    expect(calls).toHaveLength(3);
  });

  test("the ffmpeg budget starts AFTER the copies are made: a copy that takes longer than the whole budget leaves ffmpeg its full time (M-2)", async () => {
    const r = videoRig();
    let clock = 0;
    const { deps, calls } = depsWith(goodFfmpeg, { now: () => clock });

    await runRenderJob(
      {
        ...r.input,
        stageOwnVideos: async () => {
          clock += 10 * renderTimeoutMs(60);
        },
      },
      deps,
    );

    expect(calls).toHaveLength(3);
  });

  test("and the budget is still the budget once ffmpeg runs: a call after the copies that outlives it is a timeout", async () => {
    const r = videoRig();
    let clock = 0;
    const { deps } = depsWith(
      (call) => {
        clock += 10 * renderTimeoutMs(60);
        goodFfmpeg(call);
      },
      { now: () => clock },
    );

    await expect(runRenderJob({ ...r.input, stageOwnVideos: async () => void (clock += 5) }, deps)).rejects.toBeInstanceOf(FfmpegTimeoutError);
  });

  test("the copies report their progress: the job's own progress moves during staging, before ffmpeg, never backwards and never to the total (M-2)", async () => {
    const r = videoRig();
    let atFirstCall: number[] | null = null;
    const { deps } = depsWith((call) => {
      atFirstCall ??= [...r.progress];
      goodFfmpeg(call);
    });

    await runRenderJob(
      {
        ...r.input,
        stageOwnVideos: async (_dir, progress) => {
          progress(25, 100);
          progress(50, 100);
          progress(100, 100);
        },
      },
      deps,
    );

    const before: number[] = atFirstCall ?? [];
    expect(before.length).toBeGreaterThan(0);
    expect(before).toEqual([...before].sort((a, b) => a - b));
    expect(Math.max(...before)).toBeLessThan(60);
    expect(Math.min(...before)).toBeGreaterThan(0);
    expect(r.progress).toEqual([...r.progress].sort((a, b) => a - b));
  });

  test("a photo clip is not judged this way: its frames are checked by pass 2 and the verifier, as before", async () => {
    const r = rig();
    const { deps, calls } = depsWith((call) => {
      writeFileSync(outputOf(call.args), "data");
      call.child.report(call.args.includes("concat") ? 60 : 29, true);
      call.child.exit(0);
    });

    await runRenderJob(r.input, deps);

    expect(calls).toHaveLength(3);
  });
});

describe("scrubber", () => {
  const scrub = scrubber("C:\\Users\\mia\\AppData\\Local\\Temp\\render-tmp", "D:\\Videos\\Reels");

  test("a Windows temp path printed with backslashes reads with slashes all the way down", () => {
    expect(scrub("Error opening C:\\Users\\mia\\AppData\\Local\\Temp\\render-tmp\\job-00000001\\clip-00.mkv: no")).toBe("Error opening <tmp>/job-00000001/clip-00.mkv: no");
  });

  test("the same path printed with forward slashes reads the same", () => {
    expect(scrub("Error opening C:/Users/mia/AppData/Local/Temp/render-tmp/job-00000001/clip-00.mkv")).toBe("Error opening <tmp>/job-00000001/clip-00.mkv");
  });

  test("the export folder is scrubbed the same way, and its file name keeps its dots", () => {
    expect(scrub("Cannot write D:\\Videos\\Reels\\.studio-part-job-00000001.mp4\n")).toBe("Cannot write <export>/.studio-part-job-00000001.mp4\n");
  });

  test("a backslash after the scrubbed path is left alone (only the path's own separators change)", () => {
    expect(scrub("C:\\Users\\mia\\AppData\\Local\\Temp\\render-tmp\\a.mkv and a\\b")).toBe("<tmp>/a.mkv and a\\b");
  });

  test("text that names neither folder is unchanged", () => {
    expect(scrub("Invalid data found when processing input\\n")).toBe("Invalid data found when processing input\\n");
  });
});
