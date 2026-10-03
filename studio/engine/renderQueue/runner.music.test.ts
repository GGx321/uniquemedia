import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { FfmpegError, FfmpegTimeoutError, runFfmpegArgv, type RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { fakeSpawner, outputOf, type SpawnCall } from "../../node/fakeFfmpeg.testkit";
import { buildMusicMeasure, RenderGraphError, type MusicMeasureJob } from "../render";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { renderTimeoutMs } from "./progress";
import { runRenderJob, type RenderRunDeps, type RenderRunInput } from "./runner";
useNativeGlobals();

// The runner with music (3c.5): the true-peak pass runs ONCE per render, on the clip segment, BEFORE pass 1 (so a track ffmpeg
// cannot read fails the job in a second), and its answer becomes the gain of pass 2. ffmpeg and the measurement are scripted.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scene = (id: string) => ({ photo: { source: "scene" as const, photoId: id }, focus: { x: 0.5, y: 0.5 } });
const clip = (clipId: string, durationMs: number): Clip => ({ clipId, durationMs, transitionIn: "cut", kind: "photo", cell: scene(`photo-${clipId}`), motion: "static" });
const CLIPS: Clip[] = [clip("a", 1000), clip("b", 1000)]; // 2 s, 60 frames
const TRACK_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

function rig(over: Partial<RenderRunInput> = {}) {
  const root = mkdtempSync(join(tmpdir(), "studio-runner-music-"));
  dirs.push(root);
  const tmpRoot = join(root, "render-tmp");
  const exportDir = join(root, "export");
  mkdirSync(exportDir, { recursive: true });
  const track = join(tmpRoot, "job-00000001", "track.m4a");
  const output = join(exportDir, ".studio-part-job-00000001.mp4");
  const input: RenderRunInput = {
    jobId: "job-00000001",
    tmpRoot,
    seed: 1,
    clips: CLIPS,
    resolvePhoto: (ref) => ({ path: join(root, `${ref.source === "scene" ? ref.photoId : ref.mediaId}.jpg`), width: 720, height: 1280 }),
    overlays: [],
    audio: { kind: "music", startMs: 1500, data: TRACK_BYTES },
    output,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...over,
  };
  return { tmpRoot, jobDir: join(tmpRoot, "job-00000001"), output, track, input };
}

function goodFfmpeg(call: SpawnCall): void {
  writeFileSync(outputOf(call.args), "data");
  const frames = call.args.includes("concat") ? 60 : 30;
  call.child.report(frames, true);
  call.child.exit(0);
}

type Measure = NonNullable<RenderRunDeps["measure"]>;

/** The order things happened in: `measure` and each ffmpeg call. */
function scripted(peak: number | (() => Promise<number>), script: (call: SpawnCall, index: number) => void = goodFfmpeg) {
  const events: string[] = [];
  const measured: Array<{ job: MusicMeasureJob; timeoutMs: number; signal: AbortSignal }> = [];
  const { spawner, calls } = fakeSpawner((call, index) => {
    events.push(call.args.includes("concat") ? "pass2" : "pass1");
    script(call, index);
  });
  const run = (opts: RunFfmpegArgvOptions): Promise<void> => runFfmpegArgv({ ...opts, spawner, env: {} });
  const measure: Measure = async (job, options) => {
    events.push("measure");
    measured.push({ job, ...options });
    return typeof peak === "number" ? peak : peak();
  };
  return { deps: { run, measure } satisfies RenderRunDeps, calls, events, measured };
}

describe("runRenderJob with music: the measurement", () => {
  test("measures the clip segment once, before pass 1 starts", async () => {
    const r = rig();
    const { deps, events, measured } = scripted(3.0);

    await runRenderJob(r.input, deps);

    expect(events).toEqual(["measure", "pass1", "pass1", "pass2"]);
    expect(measured).toHaveLength(1);
  });

  test("asks for the montage's own length from the track's startMs, by the builder's own argv", async () => {
    const r = rig();
    const { deps, measured } = scripted(3.0);

    await runRenderJob(r.input, deps);

    expect(measured[0]?.job).toEqual(buildMusicMeasure({ path: r.track, startMs: 1500, durationMs: 2000 }));
  });

  test("gives it the job's own signal and what is left of the job's budget", async () => {
    const controller = new AbortController();
    const r = rig({ signal: controller.signal });
    const { deps, measured } = scripted(3.0);

    await runRenderJob(r.input, { ...deps, now: () => 5_000 });

    expect(measured[0]?.signal).toBe(controller.signal);
    expect(measured[0]?.timeoutMs).toBe(renderTimeoutMs(60));
  });

  test("makes no measurement for a montage without music, and reports none", async () => {
    const r = rig({ audio: { kind: "silent" } });
    const { deps, events } = scripted(3.0);

    const outcome = await runRenderJob(r.input, deps);

    expect(events).toEqual(["pass1", "pass1", "pass2"]);
    expect(outcome.music).toBeUndefined();
  });
});

describe("runRenderJob with music: the gain reaches pass 2", () => {
  const pass2Of = (calls: readonly SpawnCall[]): readonly string[] => calls.find((c) => c.args.includes("concat"))?.args ?? [];
  const afOf = (argv: readonly string[]): string => argv[argv.indexOf("-af") + 1] ?? "";

  test("a +3.0 dBTP segment is attenuated by 4.5 dB in the render", async () => {
    const r = rig();
    const { deps, calls } = scripted(3.0);

    const outcome = await runRenderJob(r.input, deps);

    expect(afOf(pass2Of(calls))).toContain("volume=-4.5dB");
    expect(outcome.music).toEqual({ gainDb: -4.5, truePeakDb: 3.0 });
  });

  test("a -5.7 dBTP segment is not touched: no volume filter, a gain of 0", async () => {
    const r = rig();
    const { deps, calls } = scripted(-5.7);

    const outcome = await runRenderJob(r.input, deps);

    expect(afOf(pass2Of(calls))).not.toContain("volume");
    expect(outcome.music).toEqual({ gainDb: 0, truePeakDb: -5.7 });
  });

  test("a silent segment (minus infinity) is not touched either", async () => {
    const r = rig();
    const { deps, calls } = scripted(Number.NEGATIVE_INFINITY);

    const outcome = await runRenderJob(r.input, deps);

    expect(afOf(pass2Of(calls))).not.toContain("volume");
    expect(outcome.music?.gainDb).toBe(0);
  });

  test("the track is pass 2's input after the list, mapped by index, under the store's flags", async () => {
    const r = rig();
    const { deps, calls } = scripted(3.0);

    await runRenderJob(r.input, deps);

    const argv = pass2Of(calls);
    expect(argv.slice(argv.indexOf("-max_alloc"), argv.indexOf("-max_alloc") + 9)).toEqual(["-max_alloc", "67108864", "-protocol_whitelist", "file", "-f", "mov", "-c:a", "aac", "-i"]);
    expect(argv[argv.indexOf("-i", argv.indexOf("-max_alloc")) + 1]).toBe(r.track);
    expect(argv.slice(argv.indexOf("-map"), argv.indexOf("-map") + 4)).toEqual(["-map", "[v]", "-map", "1:a:0"]);
  });
});

describe("runRenderJob with music: a measurement that fails", () => {
  test("a track ffmpeg cannot read fails the job before pass 1, with nothing left behind", async () => {
    const r = rig();
    const { deps, calls } = scripted(() => Promise.reject(new FfmpegError("ffmpeg exited with code 1 while measuring the music", 1, "")));

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegError);
    expect(calls).toHaveLength(0);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.output)).toBe(false);
  });

  test("the track's path in ffmpeg's text reaches the job as <audio>", async () => {
    const r = rig();
    const { deps } = scripted(() => Promise.reject(new FfmpegError("failed", 1, `Error opening input file ${r.track}: Invalid data found\n`)));

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegError);
    if (!(error instanceof FfmpegError)) throw error;
    expect(error.stderrTail).toBe("Error opening input file <audio>: Invalid data found\n");
  });

  test("a segment with no readable peak is refused as BAD_AUDIO before any pass runs", async () => {
    const r = rig();
    const { deps, calls } = scripted(() => Promise.reject(new RenderGraphError("BAD_AUDIO", "ffmpeg's loudness summary holds no true peak")));

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderGraphError);
    expect(calls).toHaveLength(0);
  });

  test("a peak that is not a number is refused as BAD_AUDIO, never turned into a gain", async () => {
    const r = rig();
    const { deps, calls } = scripted(Number.NaN);

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderGraphError);
    expect(error instanceof RenderGraphError && error.code).toBe("BAD_AUDIO");
    expect(calls).toHaveLength(0);
  });

  test("a measurement that runs out of the budget names the whole budget, as pass 2's timeout does", async () => {
    const r = rig();
    const { deps } = scripted(() => Promise.reject(new FfmpegTimeoutError(12_345, "")));

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    expect(error instanceof FfmpegTimeoutError && error.timeoutMs).toBe(renderTimeoutMs(60));
  });

  test("a cancel during the measurement comes out as the abort reason, and nothing runs", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by the owner");
    const r = rig({ signal: controller.signal });
    const { deps, calls } = scripted(() => {
      controller.abort(reason);
      return Promise.reject(reason);
    });

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBe(reason);
    expect(calls).toHaveLength(0);
    expect(existsSync(r.jobDir)).toBe(false);
  });

  test("a failing pass 2 of a render with music still removes the output and the job folder", async () => {
    const r = rig();
    const { deps } = scripted(3.0, (call) => {
      writeFileSync(outputOf(call.args), "half");
      call.child.exit(call.args.includes("concat") ? 1 : 0);
    });

    const error = await runRenderJob(r.input, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegError);
    expect(existsSync(r.output)).toBe(false);
    expect(existsSync(r.jobDir)).toBe(false);
  });
});

describe("runRenderJob with music: the render works on a private copy of the verified bytes", () => {
  const copyOf = (r: ReturnType<typeof rig>): string => join(r.jobDir, "track.m4a");
  const same = (bytes: Uint8Array | null): boolean => bytes !== null && bytes.join() === TRACK_BYTES.join();

  test("writes the bytes to <job folder>/track.m4a before the measurement, and the measurement and pass 2 read that copy", async () => {
    const r = rig();
    const seen: Array<Uint8Array | null> = [];
    const base = scripted(3.0, (call) => {
      if (call.args.includes("concat")) seen.push(existsSync(copyOf(r)) ? new Uint8Array(readFileSync(copyOf(r))) : null);
      goodFfmpeg(call);
    });
    const measure: Measure = async (job, options) => {
      seen.push(new Uint8Array(readFileSync(job.argv[job.argv.indexOf("-i") + 1] ?? "")));
      return base.deps.measure(job, options);
    };

    await runRenderJob(r.input, { ...base.deps, measure });

    expect(base.measured[0]?.job.argv).toContain(copyOf(r));
    expect(base.calls.find((c) => c.args.includes("concat"))?.args).toContain(copyOf(r));
    expect(seen).toHaveLength(2);
    expect(seen.every(same)).toBe(true);
  });

  test("removes the copy with the job folder, on success and on failure", async () => {
    const ok = rig();
    await runRenderJob(ok.input, scripted(3.0).deps);
    expect(existsSync(copyOf(ok))).toBe(false);
    const bad = rig();
    await runRenderJob(bad.input, scripted(() => Promise.reject(new FfmpegError("failed", 1, ""))).deps).catch(() => undefined);
    expect(existsSync(bad.jobDir)).toBe(false);
  });

  test("has the store's check run on the copy first, before the measurement and any ffmpeg", async () => {
    const checked: string[] = [];
    const r = rig();
    const audio = { kind: "music" as const, startMs: 1500, data: TRACK_BYTES, check: async (path: string) => void checked.push(path, existsSync(path) ? "present" : "absent") };
    const { deps, events } = scripted(3.0);

    await runRenderJob({ ...r.input, audio }, deps);

    expect(checked).toEqual([copyOf(r), "present"]);
    expect(events[0]).toBe("measure");
  });

  test("a check that refuses the copy stops the job before the measurement, with nothing left", async () => {
    const r = rig();
    const refusal = new Error("not one audio stream");
    const audio = { kind: "music" as const, startMs: 1500, data: TRACK_BYTES, check: async () => Promise.reject(refusal) };
    const { deps, events } = scripted(3.0);

    const error = await runRenderJob({ ...r.input, audio }, deps).catch((e: unknown) => e);

    expect(error).toBe(refusal);
    expect(events).toEqual([]);
    expect(existsSync(r.jobDir)).toBe(false);
  });
});
