import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { JobState } from "../../shared/engine";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { JobRegistry } from "../jobs";
import { TrackUnavailableError, type RenderTrack, type RenderTrackSource } from "../music/renderTrack";
import { RenderQueue } from "../renderQueue/queue";
import type { VerifyExpected } from "../verify";
import { CommitTracker, createRenderExecute, totalFramesOf, type RenderPlan, type VideoRenderDeps } from "./execute";
import type { VideoRecord } from "./record";
import { acceptingVerify, fakeVideoBytes, libraryVideoFiles, specOf, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// 3c.5, the render job with music: the track is opened FIRST, by id, through the store (which checks it again), and a track that
// is missing, changed, not one audio stream, or too short ends the job with the contract's refusal before anything is created or
// any ffmpeg is started. A track that passes is the input of pass 2 with the gain the true-peak pass chose, and the video's record
// keeps what was resolved. ffmpeg is a fake here; the real one is in render.music.ffmpeg.test.ts.

const world = useWorld();
const BYTES = fakeVideoBytes(4096, 11);
const TRACK_ID = "4199287736976977";

const writingRun = (calls: string[][]) => async (opts: RunFfmpegArgvOptions): Promise<void> => {
  calls.push([...opts.argv]);
  await mkdir(dirname(opts.output), { recursive: true });
  await writeFile(opts.output, BYTES);
};

const trackOf = (over: Partial<RenderTrack> = {}): RenderTrack => ({
  data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  check: async () => undefined,
  bytes: 93_509,
  sha256: "b".repeat(64),
  decodedMs: 8_000,
  title: "A Song Title Here",
  artist: "The Artist Name",
  forbidden: ["A Song Title Here", "The Artist Name", "Core Media Audio"],
  ...over,
});

interface Rig {
  readonly w: World;
  readonly queue: RenderQueue;
  readonly tracker: CommitTracker;
  readonly ffmpeg: string[][];
  readonly records: VideoRecord[];
  readonly verified: VerifyExpected[];
  readonly opened: Array<{ trackId: string; signal: AbortSignal }>;
  readonly states: () => JobState[];
  submit(plan?: RenderPlan): void;
  run(plan?: RenderPlan): Promise<JobState | undefined>;
}

function planOf(w: World, over: Partial<RenderPlan> = {}): RenderPlan {
  return {
    jobId: "job-00000001",
    videoId: "video-00000001",
    avatarId: w.avatar.id,
    safeName: "Mia",
    exportRoot: { root: w.exportRoot, rootId: w.rootId },
    spec: { ...specOf(w.avatar.id, [w.photos[0]?.id ?? ""], 4_000), music: { source: "trending", trackId: TRACK_ID, startMs: 1_500 } },
    resolvePhoto: () => ({ path: "/photos/p.jpg", width: 720, height: 1280 }),
    audio: { kind: "silent" },
    track: { trackId: TRACK_ID, startMs: 1_500 },
    montageId: null,
    videoKind: "photo",
    music: null,
    ...over,
  };
}

function rig(options: { open?: (trackId: string, signal: AbortSignal) => Promise<RenderTrack>; peak?: number; withStore?: boolean; onPass2?: (argv: readonly string[]) => Promise<void> } = {}): Rig {
  const w = world();
  const tracker = new CommitTracker();
  const ffmpeg: string[][] = [];
  const records: VideoRecord[] = [];
  const verified: VerifyExpected[] = [];
  const opened: Array<{ trackId: string; signal: AbortSignal }> = [];
  const store: RenderTrackSource = {
    stored: () => ({ decodedMs: 8_000 }),
    openForRender: async (trackId, signal) => {
      opened.push({ trackId, signal });
      return (options.open ?? (async () => trackOf()))(trackId, signal);
    },
  };
  const deps: VideoRenderDeps = {
    library: w.library,
    tracker,
    renderTmpDir: w.renderTmp,
    caseProbe: { isCaseInsensitive: async () => false },
    now: () => new Date(2026, 8, 29, 10, 0, 0),
    verify: async (path, expected) => (verified.push(expected), acceptingVerify(path)),
    runDeps: { run: async (opts) => (opts.argv.includes("concat") ? await options.onPass2?.(opts.argv) : undefined, writingRun(ffmpeg)(opts)), measure: async () => options.peak ?? 3.0 },
    onCommitted: (record) => void records.push(record),
    ...(options.withStore === false ? {} : { tracks: store }),
  };
  const execute = createRenderExecute(deps);
  const queue = new RenderQueue({ jobs: new JobRegistry(), size: () => 1 });
  return {
    w,
    queue,
    tracker,
    ffmpeg,
    records,
    verified,
    opened,
    states: () => queue.states(),
    submit(plan = planOf(w)) {
      queue.submit({ jobId: plan.jobId, ref: { videoId: plan.videoId, avatarId: plan.avatarId, montageId: plan.montageId }, totalFrames: totalFramesOf(plan.spec.clips), photoIds: [w.photos[0]?.id ?? ""], execute: execute(plan) });
    },
    async run(plan = planOf(w)) {
      this.submit(plan);
      await queue.idle();
      return queue.states()[0];
    },
  };
}

/** Nothing about the render may be touched by a refused track: no folder, no intermediate, no ffmpeg, no record, nothing live. */
async function expectNothingTouched(r: Rig): Promise<void> {
  expect(r.ffmpeg).toEqual([]);
  expect(r.records).toEqual([]);
  expect(existsSync(join(r.w.exportRoot, "Mia"))).toBe(false);
  expect(await readdir(r.w.renderTmp)).toEqual([]);
  expect(await libraryVideoFiles(r.w)).toEqual([]);
  expect(r.tracker.liveJobIds().size).toBe(0);
}

const pass2Of = (calls: readonly string[][]): string[] => calls.find((argv) => argv.includes("concat")) ?? [];
const afOf = (argv: readonly string[]): string => (argv.includes("-af") ? (argv[argv.indexOf("-af") + 1] ?? "") : "");

describe("a render job with music: a track that passes", () => {
  test("opens the track by its id, with the job's own signal", async () => {
    const r = rig();
    await r.run();
    expect(r.opened.map((o) => o.trackId)).toEqual([TRACK_ID]);
    expect(r.opened[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("ends done, and pass 2 reads the store's path for the track, attenuated by the true-peak pass (+3.0 dBTP gives -4.5 dB)", async () => {
    const r = rig();
    const state = await r.run();
    expect(state).toMatchObject({ status: "done" });
    const argv = pass2Of(r.ffmpeg);
    expect(argv).toContain(join(r.w.renderTmp, "job-00000001", "track.m4a"));
    expect(afOf(argv)).toContain("atrim=start_sample=72000:end_sample=264000");
    expect(afOf(argv)).toContain("volume=-4.5dB");
  });

  test("a quiet track is not touched", async () => {
    const r = rig({ peak: -5.7 });
    await r.run();
    expect(afOf(pass2Of(r.ffmpeg))).not.toContain("volume");
  });

  test("the record keeps the tile's title and artist, and the resolved part: start, gain and the track's sha256", async () => {
    const r = rig();
    await r.run();
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.music).toEqual({ title: "A Song Title Here", artist: "The Artist Name" });
    expect(r.records[0]?.audio).toEqual({ trackSha: "b".repeat(64), startMs: 1_500, gainDb: -4.5 });
    expect(r.records[0]?.spec.music).toEqual({ source: "trending", trackId: TRACK_ID, startMs: 1_500 });
  });

  test("a gain of 0 is recorded as 0", async () => {
    const r = rig({ peak: -5.7 });
    await r.run();
    expect(r.records[0]?.audio?.gainDb).toBe(0);
  });

  test("hands the verifier the track's own tags and handler names as forbidden strings, with the photos' text", async () => {
    const r = rig();
    await r.run();
    expect(r.verified).toHaveLength(1);
    expect(r.verified[0]?.forbiddenStrings).toEqual(expect.arrayContaining(["A Song Title Here", "The Artist Name", "Core Media Audio"]));
  });

  test("a track with no title is shown under the store's own placeholder", async () => {
    const r = rig({ open: async () => trackOf({ title: "Untitled track", artist: null }) });
    await r.run();
    expect(r.records[0]?.music).toEqual({ title: "Untitled track", artist: null });
  });
});

describe("a render job with music: a track that does not pass, and nothing is touched", () => {
  test.each(["not-stored", "changed"] as const)("a track the store refuses as %s ends the job MONTAGE_INVALID track-unavailable", async (kind) => {
    const r = rig({ open: async () => Promise.reject(new TrackUnavailableError(kind)) });
    const state = await r.run();
    expect(state).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "track-unavailable", path: ["music"] }] } });
    await expectNothingTouched(r);
  });

  test("a copy ffmpeg does not see as one audio stream ends the job MONTAGE_INVALID track-unavailable, with no ffmpeg run and nothing left behind", async () => {
    const r = rig({ open: async () => trackOf({ check: async () => Promise.reject(new TrackUnavailableError("not-audio")) }) });
    const state = await r.run();
    expect(state).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "track-unavailable", path: ["music"] }] } });
    expect(r.ffmpeg).toEqual([]);
    expect(r.records).toEqual([]);
    expect(await readdir(r.w.renderTmp)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(r.tracker.liveJobIds().size).toBe(0);
  });

  test("replacing the stored file after the store opened the track does not change what pass 2 reads", async () => {
    const original = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const stored = join(world().renderTmp, "..", "stored-track.m4a");
    await writeFile(stored, original);
    const readByPass2: Uint8Array[] = [];
    const r = rig({
      open: async () => {
        const track = trackOf({ data: new Uint8Array(await readFile(stored)) });
        // The stored file changes the moment the store has handed its bytes over.
        await writeFile(stored, new Uint8Array(original.byteLength).fill(255));
        return track;
      },
      onPass2: async (argv) => void readByPass2.push(new Uint8Array(await readFile(argv[argv.indexOf("-i", argv.indexOf("-max_alloc")) + 1] ?? ""))),
    });
    await r.run();
    expect(readByPass2).toHaveLength(1);
    expect([...(readByPass2[0] ?? [])]).toEqual([...original]);
  });

  test("a track too short for startMs plus the montage, at this render, is track-too-short", async () => {
    const r = rig({ open: async () => trackOf({ decodedMs: 5_499 }) });
    const state = await r.run();
    expect(state).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "track-too-short", path: ["music"] }] } });
    await expectNothingTouched(r);
  });

  test("a track exactly as long as startMs plus the montage passes", async () => {
    const r = rig({ open: async () => trackOf({ decodedMs: 5_500 }) });
    expect(await r.run()).toMatchObject({ status: "done" });
  });

  test("no track store wired: the track is not held, and the job is refused the same way", async () => {
    const r = rig({ withStore: false });
    const state = await r.run();
    expect(state).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "track-unavailable", path: ["music"] }] } });
    await expectNothingTouched(r);
  });

  test("an error that is not the store's refusal is an INTERNAL failure whose text names no path", async () => {
    const r = rig({ open: async () => Promise.reject(new Error("EACCES: permission denied, open '/Users/alex/secret/tracks/1.m4a'")) });
    const state = await r.run();
    expect(state).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(JSON.stringify(state)).not.toContain("/Users/alex");
    await expectNothingTouched(r);
  });

  test("a cancel while the track is being checked ends the job cancelled, with nothing touched", async () => {
    const r = rig({ open: (_id, signal) => new Promise<RenderTrack>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
    r.submit();
    for (let waited = 0; r.opened.length === 0 && waited < 200; waited++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.opened).toHaveLength(1);
    r.queue.cancel("job-00000001");
    await r.queue.idle();
    expect(r.states()[0]).toMatchObject({ status: "cancelled" });
    await expectNothingTouched(r);
  });
});

describe("invariant 31 by type", () => {
  test("a plan cannot carry a music path: the audio of a plan is silence, and a track only comes through `track` and the store", () => {
    const w = world();
    // @ts-expect-error a `{ kind: "music", path }` plan would bypass `openForRender`
    const bypass: RenderPlan = planOf(w, { audio: { kind: "music", path: "/anywhere/track.m4a", startMs: 0 } });
    expect(bypass.track).toBeDefined();
  });
});

describe("a render job without music is unchanged", () => {
  test("never opens a track, renders the silent track, and records no resolved audio", async () => {
    const r = rig();
    const plan = planOf(r.w, { track: undefined, spec: specOf(r.w.avatar.id, [r.w.photos[0]?.id ?? ""], 4_000) });
    const state = await r.run(plan);
    expect(state).toMatchObject({ status: "done" });
    expect(r.opened).toEqual([]);
    expect(afOf(pass2Of(r.ffmpeg))).toBe("");
    expect(pass2Of(r.ffmpeg).join(" ")).toContain("anullsrc=r=48000:cl=stereo");
    expect(r.records[0]?.music).toBeNull();
    expect(r.records[0]?.audio).toBeUndefined();
  });
});
