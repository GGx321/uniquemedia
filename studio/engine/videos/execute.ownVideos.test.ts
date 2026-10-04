import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { JobState } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { JobRegistry } from "../jobs";
import { RenderQueue } from "../renderQueue/queue";
import { CommitTracker, createRenderExecute, totalFramesOf, type RenderPlan, type VideoRenderDeps } from "./execute";
import { ownVideoCopyName, type OwnVideoSource } from "./ownVideos";
import type { VideoRecord } from "./record";
import { reportVideoClipFrames } from "./testing/serviceKit";
import { acceptingVerify, exportFiles, fakeVideoBytes, libraryVideoFiles, specOf, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// The render job with an OWN VIDEO clip (3f.3b): the job STREAMS the stored mezzanine into its own folder, verified against the record as it goes, and ffmpeg is only
// ever pointed at that copy; a mezzanine that is gone, changed, a link or too short for the clip ends the job with the contract's refusal, naming no path, and leaves
// nothing. ffmpeg is a fake here; the real chain is in render.ownVideo.ffmpeg.test.ts and engine.ownVideo.ffmpeg.test.ts.

const world = useWorld();
const OUT = fakeVideoBytes(4096, 11);
const MEDIA_ID = "media-0000007";
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const MEZZANINE = Uint8Array.from({ length: 5_000 }, (_, i) => (i * 7 + (i >> 5)) & 0xff);

const writingRun = (calls: string[][], onFirst?: (opts: RunFfmpegArgvOptions) => Promise<void>) => async (opts: RunFfmpegArgvOptions): Promise<void> => {
  calls.push([...opts.argv]);
  reportVideoClipFrames(opts);
  if (calls.length === 1) await onFirst?.(opts);
  await mkdir(dirname(opts.output), { recursive: true });
  await writeFile(opts.output, OUT);
};

const videoSpec = (w: World, clips: { trimStartMs: number; durationMs: number; mediaId?: string }[]): MontageDraft => ({
  ...specOf(w.avatar.id, [w.photos[0]?.id ?? ""], 4_000),
  clips: clips.map((c, i) => ({ clipId: `clip-${String(i + 1).padStart(8, "0")}`, kind: "video" as const, mediaId: c.mediaId ?? MEDIA_ID, trimStartMs: c.trimStartMs, focus: { x: 0.5, y: 0.5 }, durationMs: c.durationMs, transitionIn: "cut" as const })),
});

interface Rig {
  readonly w: World;
  readonly queue: RenderQueue;
  readonly tracker: CommitTracker;
  readonly ffmpeg: string[][];
  readonly records: VideoRecord[];
  readonly source: OwnVideoSource;
  readonly libraryFile: string;
  readonly states: () => JobState[];
  run(): Promise<JobState | undefined>;
  submit(): void;
}

let libraryFile = "";
beforeEach(async () => {
  libraryFile = join(world().renderTmp, "..", "library-media", `${MEDIA_ID}.mp4`);
  await mkdir(dirname(libraryFile), { recursive: true });
});
afterEach(async () => {
  await rm(dirname(libraryFile), { recursive: true, force: true });
});

function rig(
  options: { clips?: { trimStartMs: number; durationMs: number; mediaId?: string }[]; second?: string; durationMs?: number; withoutOwn?: boolean; io?: VideoRenderDeps["ownVideoIo"]; onFirst?: (opts: RunFfmpegArgvOptions) => Promise<void> } = {},
): Rig {
  const w = world();
  const source: OwnVideoSource = { mediaId: MEDIA_ID, path: libraryFile, sha256: sha(MEZZANINE), bytes: MEZZANINE.length, width: 1080, height: 570, durationMs: options.durationMs ?? 6_000 };
  const secondSource: OwnVideoSource | null =
    options.second === undefined ? null : { ...source, mediaId: options.second, path: join(dirname(libraryFile), `${options.second}.mp4`) };
  const tracker = new CommitTracker();
  const ffmpeg: string[][] = [];
  const records: VideoRecord[] = [];
  const deps: VideoRenderDeps = {
    library: w.library,
    tracker,
    renderTmpDir: w.renderTmp,
    caseProbe: { isCaseInsensitive: async () => false },
    now: () => new Date(2026, 9, 4, 10, 0, 0),
    verify: async (path) => acceptingVerify(path),
    runDeps: { run: writingRun(ffmpeg, options.onFirst) },
    onCommitted: (record) => void records.push(record),
    ...(options.io === undefined ? { ownVideoIo: { freeBytes: async () => null } } : { ownVideoIo: options.io }),
  };
  const execute = createRenderExecute(deps);
  const queue = new RenderQueue({ jobs: new JobRegistry(), size: () => 1 });
  const planOf = (): RenderPlan => ({
    jobId: "job-00000001",
    videoId: "video-00000001",
    avatarId: w.avatar.id,
    safeName: "Mia",
    exportRoot: { root: w.exportRoot, rootId: w.rootId },
    spec: videoSpec(w, options.clips ?? [{ trimStartMs: 1_000, durationMs: 4_000 }]),
    resolvePhoto: () => undefined,
    audio: { kind: "silent" },
    ...(options.withoutOwn === true ? {} : { ownVideos: secondSource === null ? [source] : [source, secondSource] }),
    montageId: null,
    title: null,
    videoKind: "mix",
    music: null,
  });
  const submit = (): void => {
    const plan = planOf();
    queue.submit({ jobId: plan.jobId, ref: { videoId: plan.videoId, avatarId: plan.avatarId, montageId: null }, totalFrames: totalFramesOf(plan.spec.clips), photoIds: [], mediaIds: [MEDIA_ID], execute: execute(plan) });
  };
  return {
    w,
    queue,
    tracker,
    ffmpeg,
    records,
    source,
    libraryFile,
    states: () => queue.states(),
    submit,
    async run() {
      submit();
      await queue.idle();
      return queue.states()[0];
    },
  };
}

/** A refused mezzanine leaves nothing: no ffmpeg, no record, no file in the export folder, no job folder, nothing live. */
async function expectNothingLeft(r: Rig): Promise<void> {
  expect(r.ffmpeg).toEqual([]);
  expect(r.records).toEqual([]);
  expect(await exportFiles(r.w)).toEqual([]);
  expect(await readdir(r.w.renderTmp)).toEqual([]);
  expect(await libraryVideoFiles(r.w)).toEqual([]);
  expect(r.tracker.liveJobIds().size).toBe(0);
}

const copyPath = (w: World): string => join(w.renderTmp, "job-00000001", ownVideoCopyName(MEDIA_ID));

describe("a render job with an own video that passes", () => {
  test("ends done, and the first ffmpeg reads the job's private copy of the mezzanine", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const r = rig();
    expect(await r.run()).toMatchObject({ status: "done" });
    const first = r.ffmpeg[0] ?? [];
    expect(first[first.indexOf("-i") + 1]).toBe(copyPath(r.w));
    expect(first).toContain("-ss");
  });

  test("ffmpeg is never pointed at the library file", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const r = rig();
    await r.run();
    expect(r.ffmpeg.flat()).not.toContain(libraryFile);
  });

  test("the private copy is the verified bytes of the library file, and a change to the library file after the copy does not reach it", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const seen: Uint8Array[] = [];
    const r = rig({
      onFirst: async () => {
        // The library file changes while the render runs; the copy ffmpeg reads must not.
        await writeFile(libraryFile, new Uint8Array(MEZZANINE.length).fill(255));
        seen.push(new Uint8Array(await readFile(copyPath(world()))));
      },
    });
    await r.run();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(MEZZANINE);
  });

  test("the record keeps the spec with the video clip as it was asked for", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const r = rig();
    await r.run();
    expect(r.records[0]?.spec.clips[0]).toMatchObject({ kind: "video", mediaId: MEDIA_ID, trimStartMs: 1_000, durationMs: 4_000 });
    expect(r.records[0]?.kind).toBe("mix");
  });

  test("a clip that ends exactly at the mezzanine's end passes", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const r = rig({ durationMs: 5_000 });
    expect(await r.run()).toMatchObject({ status: "done" });
  });

  test("two clips of the same mezzanine make ONE copy", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const r = rig({ clips: [{ trimStartMs: 0, durationMs: 2_000 }, { trimStartMs: 2_000, durationMs: 2_000 }] });
    expect(await r.run()).toMatchObject({ status: "done" });
    const reads = r.ffmpeg.filter((argv) => argv.includes("-i") && !argv.includes("concat")).map((argv) => argv[argv.indexOf("-i") + 1]);
    expect(reads).toEqual([copyPath(r.w), copyPath(r.w)]);
  });
});

describe("a render job with an own video that does not pass", () => {
  const unavailable = { status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0] }] } } as const;

  test("a library file that is gone is media-unavailable at the clip, and nothing is left", async () => {
    const r = rig();
    expect(await r.run()).toMatchObject(unavailable);
    await expectNothingLeft(r);
  });

  test("a library file whose bytes changed but whose size did not", async () => {
    const changed = Uint8Array.from(MEZZANINE);
    changed[4_999] = (changed[4_999] ?? 0) ^ 1;
    await writeFile(libraryFile, changed);
    const r = rig();
    expect(await r.run()).toMatchObject(unavailable);
    await expectNothingLeft(r);
  });

  test("a library file that grew by one byte, and one that shrank by one", async () => {
    await writeFile(libraryFile, Uint8Array.from([...MEZZANINE, 0]));
    const grown = rig();
    expect(await grown.run()).toMatchObject(unavailable);
    await expectNothingLeft(grown);
  });

  test("a library file that shrank by one byte", async () => {
    await writeFile(libraryFile, MEZZANINE.subarray(0, MEZZANINE.length - 1));
    const r = rig();
    expect(await r.run()).toMatchObject(unavailable);
    await expectNothingLeft(r);
  });

  test("a library file that is a link, even to a file with the right bytes", async () => {
    const real = join(dirname(libraryFile), "real.mp4");
    await writeFile(real, MEZZANINE);
    await symlink(real, libraryFile);
    const r = rig();
    expect(await r.run()).toMatchObject(unavailable);
    await expectNothingLeft(r);
  });

  test("every clip of a missing mezzanine is marked, each at its own place", async () => {
    const r = rig({ clips: [{ trimStartMs: 0, durationMs: 2_000 }, { trimStartMs: 2_000, durationMs: 2_000 }] });
    expect(await r.run()).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0] }, { code: "media-unavailable", path: ["clips", 1] }] } });
    await expectNothingLeft(r);
  });

  test("a mezzanine too short for the clip at THIS render is video-too-short, before the folder, the copy or ffmpeg", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const r = rig({ durationMs: 4_900 });
    expect(await r.run()).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "video-too-short", path: ["clips", 0] }] } });
    await expectNothingLeft(r);
  });

  test("the refusal's text names no path and no media id", async () => {
    const r = rig();
    const state = await r.run();
    expect(JSON.stringify(state)).not.toContain(r.w.dir);
    expect(JSON.stringify(state)).not.toContain(libraryFile);
    expect(JSON.stringify(state)).not.toContain(MEDIA_ID);
  });

  test("a volume with no room for the mezzanine fails the job RENDER_FAILED (not media-unavailable), tells why, and leaves nothing", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const r = rig({ io: { freeBytes: async () => 10 } });
    const state = await r.run();
    expect(state).toMatchObject({ status: "failed", error: { code: "RENDER_FAILED" } });
    expect(state?.error?.detail).toMatch(/free space/);
    await expectNothingLeft(r);
  });

  test("a disk that fills up in the middle of the copy is the same, and the partial copy goes with the job's folder", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const r = rig({
      io: {
        freeBytes: async () => null,
        chunkBytes: 1_024,
        openDest: async (path) => {
          const real = await open(path, "wx");
          let writes = 0;
          return {
            write: async (buffer, offset, length) => {
              if (++writes === 3) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
              return real.write(buffer, offset, length);
            },
            close: () => real.close(),
          };
        },
      },
    });
    expect(await r.run()).toMatchObject({ status: "failed", error: { code: "RENDER_FAILED" } });
    await expectNothingLeft(r);
  });

  test("a cancel while the mezzanine is being copied ends the job cancelled, and nothing is left", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const r = rig({
      io: {
        freeBytes: async () => null,
        chunkBytes: 512,
        openDest: async (path) => {
          const real = await open(path, "wx");
          let writes = 0;
          return {
            write: async (buffer, offset, length) => {
              if (++writes === 2) r.queue.cancel("job-00000001");
              return real.write(buffer, offset, length);
            },
            close: () => real.close(),
          };
        },
      },
    });
    r.submit();
    await r.queue.idle();
    expect(r.states()[0]).toMatchObject({ status: "cancelled" });
    await expectNothingLeft(r);
  });
});

describe("which clip is flagged when a copy fails (M-3)", () => {
  const clipsABA = [
    { trimStartMs: 0, durationMs: 1_000 },
    { trimStartMs: 0, durationMs: 1_000, mediaId: "media-0000008" },
    { trimStartMs: 1_000, durationMs: 1_000 },
  ];

  test("clips [A, B, A] with B's bytes swapped: only B's clip is marked, not A's two, and not all of them", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const second = join(dirname(libraryFile), "media-0000008.mp4");
    await writeFile(second, Uint8Array.from(MEZZANINE).reverse());
    const r = rig({ clips: clipsABA, second: "media-0000008" });
    expect(await r.run()).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 1] }] } });
  });

  test("clips [A, B, A] with A's bytes swapped: both of A's clips are marked, in order, and B's is not", async () => {
    await writeFile(libraryFile, Uint8Array.from(MEZZANINE).reverse());
    await writeFile(join(dirname(libraryFile), "media-0000008.mp4"), MEZZANINE);
    const r = rig({ clips: clipsABA, second: "media-0000008" });
    expect(await r.run()).toMatchObject({ status: "failed", error: { issues: [{ code: "media-unavailable", path: ["clips", 0] }, { code: "media-unavailable", path: ["clips", 2] }] } });
  });
});

describe("a plan that names an own video clip in its spec but carries no source for it", () => {
  test("is refused, never rendered as something else: media-unavailable at the clip, and nothing is touched", async () => {
    await writeFile(libraryFile, MEZZANINE);
    const r = rig({ withoutOwn: true });
    expect(await r.run()).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0] }] } });
    await expectNothingLeft(r);
  });
});
