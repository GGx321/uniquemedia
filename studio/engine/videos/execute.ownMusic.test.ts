import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { JobState } from "../../shared/engine";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { JobRegistry } from "../jobs";
import { fixtureBytes } from "../media/fixtures/music";
import { RenderQueue } from "../renderQueue/queue";
import type { VerifyExpected } from "../verify";
import { CommitTracker, createRenderExecute, totalFramesOf, type RenderPlan, type VideoRenderDeps } from "./execute";
import type { OwnTrackSource } from "./ownTrack";
import type { VideoRecord } from "./record";
import { acceptingVerify, fakeVideoBytes, libraryVideoFiles, specOf, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// The render job with an OWN track (3f.4), as execute.music.test.ts plays a trending one: the job reads the stored file's VERIFIED BYTES at its start (no
// ffmpeg, no folder, nothing before it), the runner writes them to `track.m4a` and ffmpeg is only ever pointed at that copy; a file that is gone, changed,
// a link, too short or not one audio stream ends the job with the contract's refusal and leaves nothing. ffmpeg is a fake here; the real chain is in
// render.music.ffmpeg.test.ts (the stored file is the same AAC-LC M4A the importer makes).

const world = useWorld();
const BYTES = fakeVideoBytes(4096, 11);
const MEDIA_ID = "media-0000007";
const M4A = Uint8Array.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 2, 0, 1, 2, 3, 4]);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const writingRun = (calls: string[][]) => async (opts: RunFfmpegArgvOptions): Promise<void> => {
  calls.push([...opts.argv]);
  await mkdir(dirname(opts.output), { recursive: true });
  await writeFile(opts.output, BYTES);
};

interface Rig {
  readonly w: World;
  readonly queue: RenderQueue;
  readonly tracker: CommitTracker;
  readonly ffmpeg: string[][];
  readonly records: VideoRecord[];
  readonly verified: VerifyExpected[];
  readonly inspected: string[];
  readonly source: OwnTrackSource;
  readonly states: () => JobState[];
  submit(plan?: RenderPlan): void;
  run(plan?: RenderPlan): Promise<JobState | undefined>;
}

let libraryFile = "";
beforeEach(async () => {
  libraryFile = join(world().renderTmp, "..", "library-media", `${MEDIA_ID}.m4a`);
  await mkdir(dirname(libraryFile), { recursive: true });
});
afterEach(async () => {
  await rm(dirname(libraryFile), { recursive: true, force: true });
});

function rig(options: { bytes?: Uint8Array; durationMs?: number; peak?: number; kinds?: readonly string[]; startMs?: number; withoutOwn?: boolean } = {}): Rig {
  const w = world();
  const bytes = options.bytes ?? M4A;
  const source: OwnTrackSource = { mediaId: MEDIA_ID, path: libraryFile, sha256: sha(bytes), bytes: bytes.length, durationMs: options.durationMs ?? 8_000, name: "my song.mp3" };
  const tracker = new CommitTracker();
  const ffmpeg: string[][] = [];
  const records: VideoRecord[] = [];
  const verified: VerifyExpected[] = [];
  const inspected: string[] = [];
  const deps: VideoRenderDeps = {
    library: w.library,
    tracker,
    renderTmpDir: w.renderTmp,
    caseProbe: { isCaseInsensitive: async () => false },
    now: () => new Date(2026, 9, 4, 10, 0, 0),
    verify: async (path, expected) => (verified.push(expected), acceptingVerify(path)),
    runDeps: { run: writingRun(ffmpeg), measure: async () => options.peak ?? 3.0 },
    inspectStreams: async (path) => (inspected.push(path), options.kinds ?? ["Audio"]),
    onCommitted: (record) => void records.push(record),
  };
  const execute = createRenderExecute(deps);
  const queue = new RenderQueue({ jobs: new JobRegistry(), size: () => 1 });
  const planOf = (): RenderPlan => ({
    jobId: "job-00000001",
    videoId: "video-00000001",
    avatarId: w.avatar.id,
    safeName: "Mia",
    exportRoot: { root: w.exportRoot, rootId: w.rootId },
    spec: { ...specOf(w.avatar.id, [w.photos[0]?.id ?? ""], 4_000), music: { source: "own", mediaId: MEDIA_ID, startMs: options.startMs ?? 1_500 } },
    resolvePhoto: () => ({ path: "/photos/p.jpg", width: 720, height: 1280 }),
    audio: { kind: "silent" },
    ...(options.withoutOwn === true ? {} : { ownTrack: { source, startMs: options.startMs ?? 1_500 } }),
    montageId: null,
    title: null,
    videoKind: "photo",
    music: null,
  });
  return {
    w,
    queue,
    tracker,
    ffmpeg,
    records,
    verified,
    inspected,
    source,
    states: () => queue.states(),
    submit(plan = planOf()) {
      queue.submit({ jobId: plan.jobId, ref: { videoId: plan.videoId, avatarId: plan.avatarId, montageId: plan.montageId }, totalFrames: totalFramesOf(plan.spec.clips), photoIds: [w.photos[0]?.id ?? ""], execute: execute(plan) });
    },
    async run(plan = planOf()) {
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

describe("a render job with an own track that passes", () => {
  test("ends done, and pass 2 reads the job's private copy of the track, attenuated by the true-peak pass (+3.0 dBTP gives -4.5 dB)", async () => {
    await writeFile(libraryFile, M4A);
    const r = rig();
    expect(await r.run()).toMatchObject({ status: "done" });
    const argv = pass2Of(r.ffmpeg);
    expect(argv).toContain(join(r.w.renderTmp, "job-00000001", "track.m4a"));
    expect(afOf(argv)).toContain("atrim=start_sample=72000:end_sample=264000");
    expect(afOf(argv)).toContain("volume=-4.5dB");
  });

  test("ffmpeg is never pointed at the library file: neither the stream check nor any pass reads it", async () => {
    await writeFile(libraryFile, M4A);
    const r = rig();
    await r.run();
    expect(r.ffmpeg.flat()).not.toContain(libraryFile);
    expect(r.inspected).toEqual([join(r.w.renderTmp, "job-00000001", "track.m4a")]);
  });

  test("the private copy is the verified bytes of the library file, and a change to the library file after the read does not reach it", async () => {
    await writeFile(libraryFile, M4A);
    const r = rig();
    const seen: Uint8Array[] = [];
    const plan = r.states();
    expect(plan).toEqual([]);
    const execute = createRenderExecute({
      library: r.w.library,
      tracker: r.tracker,
      renderTmpDir: r.w.renderTmp,
      caseProbe: { isCaseInsensitive: async () => false },
      now: () => new Date(2026, 9, 4, 10, 0, 0),
      verify: async (path) => acceptingVerify(path),
      runDeps: {
        run: async (opts) => {
          if (opts.argv.includes("concat")) {
            // The library file changes while the render runs; the copy pass 2 reads must not.
            await writeFile(libraryFile, new Uint8Array(M4A.length).fill(255));
            seen.push(new Uint8Array(await readFile(join(r.w.renderTmp, "job-00000001", "track.m4a"))));
          }
          await writingRun([])(opts);
        },
        measure: async () => 3.0,
      },
      inspectStreams: async () => ["Audio"],
    });
    const queue = new RenderQueue({ jobs: new JobRegistry(), size: () => 1 });
    queue.submit({
      jobId: "job-00000001",
      ref: { videoId: "video-00000001", avatarId: r.w.avatar.id, montageId: null },
      totalFrames: totalFramesOf(specOf(r.w.avatar.id, [r.w.photos[0]?.id ?? ""], 4_000).clips),
      photoIds: [r.w.photos[0]?.id ?? ""],
      execute: execute({
        jobId: "job-00000001",
        videoId: "video-00000001",
        avatarId: r.w.avatar.id,
        safeName: "Mia",
        exportRoot: { root: r.w.exportRoot, rootId: r.w.rootId },
        spec: { ...specOf(r.w.avatar.id, [r.w.photos[0]?.id ?? ""], 4_000), music: { source: "own", mediaId: MEDIA_ID, startMs: 0 } },
        resolvePhoto: () => ({ path: "/photos/p.jpg", width: 720, height: 1280 }),
        audio: { kind: "silent" },
        ownTrack: { source: r.source, startMs: 0 },
        montageId: null,
        title: null,
        videoKind: "photo",
        music: null,
      }),
    });
    await queue.idle();
    expect(seen).toHaveLength(1);
    expect([...(seen[0] ?? [])]).toEqual([...M4A]);
  });

  test("the record keeps the tile (the file's name, no artist) and the resolved part: start, gain and the stored file's sha256", async () => {
    await writeFile(libraryFile, M4A);
    const r = rig();
    await r.run();
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.music).toEqual({ title: "my song.mp3", artist: null });
    expect(r.records[0]?.audio).toEqual({ trackSha: sha(M4A), startMs: 1_500, gainDb: -4.5 });
    expect(r.records[0]?.spec.music).toEqual({ source: "own", mediaId: MEDIA_ID, startMs: 1_500 });
  });

  test("a quiet track is not touched, and the gain recorded is 0", async () => {
    await writeFile(libraryFile, M4A);
    const r = rig({ peak: -5.7 });
    await r.run();
    expect(afOf(pass2Of(r.ffmpeg))).not.toContain("volume");
    expect(r.records[0]?.audio?.gainDb).toBe(0);
  });

  test("a track exactly as long as startMs plus the montage passes", async () => {
    await writeFile(libraryFile, M4A);
    const r = rig({ durationMs: 5_500 });
    expect(await r.run()).toMatchObject({ status: "done" });
  });

  test("the text a stored track's own bytes carry (a tag the importer should have dropped) is forbidden in the finished video", async () => {
    const tagged = fixtureBytes("taggedM4a");
    await writeFile(libraryFile, tagged);
    const r = rig({ bytes: tagged });
    await r.run();
    expect(r.verified[0]?.forbiddenStrings).toEqual(expect.arrayContaining(["SecretTitle-XYZ-1234", "SecretArtist-XYZ-5678"]));
  });
});

describe("a render job with an own track that does not pass, and nothing is touched", () => {
  const unavailable = { status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] } } as const;

  test("a library file that is gone", async () => {
    const r = rig();
    expect(await r.run()).toMatchObject(unavailable);
    await expectNothingTouched(r);
  });

  test("a library file whose bytes changed but whose size did not", async () => {
    const changed = Uint8Array.from(M4A);
    changed[19] = 99;
    await writeFile(libraryFile, changed);
    const r = rig();
    expect(await r.run()).toMatchObject(unavailable);
    await expectNothingTouched(r);
  });

  test("a library file that grew by one byte", async () => {
    await writeFile(libraryFile, Uint8Array.from([...M4A, 0]));
    const r = rig();
    expect(await r.run()).toMatchObject(unavailable);
    await expectNothingTouched(r);
  });

  test("a library file that is a link, even to a file with the right bytes", async () => {
    const real = join(dirname(libraryFile), "real.m4a");
    await writeFile(real, M4A);
    await symlink(real, libraryFile);
    const r = rig();
    expect(await r.run()).toMatchObject(unavailable);
    await expectNothingTouched(r);
  });

  test("a track too short for startMs plus the montage, at this render, is track-too-short", async () => {
    await writeFile(libraryFile, M4A);
    const r = rig({ durationMs: 5_499 });
    expect(await r.run()).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "track-too-short", path: ["music"] }] } });
    await expectNothingTouched(r);
  });

  test.each([[["Video"]], [["Audio", "Video"]], [[]]])("a copy ffmpeg sees as %j is media-unavailable, with no ffmpeg run and nothing left behind", async (kinds) => {
    await writeFile(libraryFile, M4A);
    const r = rig({ kinds });
    expect(await r.run()).toMatchObject(unavailable);
    expect(r.ffmpeg).toEqual([]);
    expect(r.records).toEqual([]);
    expect(await readdir(r.w.renderTmp)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(r.tracker.liveJobIds().size).toBe(0);
  });

  test("the refusal's text names no path", async () => {
    const r = rig();
    const state = await r.run();
    expect(JSON.stringify(state)).not.toContain(r.w.dir);
    expect(JSON.stringify(state)).not.toContain(libraryFile);
  });

  test("a cancel while the track is being read ends the job cancelled, with nothing touched", async () => {
    await writeFile(libraryFile, M4A);
    const r = rig();
    r.submit();
    r.queue.cancel("job-00000001");
    await r.queue.idle();
    expect(r.states()[0]).toMatchObject({ status: "cancelled" });
    await expectNothingTouched(r);
  });
});

describe("a plan that names an own track in its spec but carries no source for it", () => {
  test("is refused, never rendered without its music (N9's rule): media-unavailable, and nothing is touched", async () => {
    await writeFile(libraryFile, M4A);
    const r = rig({ withoutOwn: true });
    expect(await r.run()).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] } });
    expect(r.inspected).toEqual([]);
    await expectNothingTouched(r);
  });
});
