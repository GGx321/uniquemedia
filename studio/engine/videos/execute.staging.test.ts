import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import type { MontageDraft } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { JobRegistry } from "../jobs";
import { NODE_OPEN_OPS, type OpenRegularOps } from "../library/openRegular";
import { RenderQueue } from "../renderQueue/queue";
import { CommitTracker, createRenderExecute, totalFramesOf, type RenderPlan, type VideoRenderDeps } from "./execute";
import type { OwnPhotoSource } from "./ownPhotos";
import type { OwnVideoSource } from "./ownVideos";
import { acceptingVerify, exportFiles, fakeVideoBytes, specOf, useWorld, type World } from "./testing/kit";
import { reportVideoClipFrames } from "./testing/serviceKit";
useNativeGlobals();

// ALL of a render's staging is under one time bound (3f.3b, round 3): the own photos' copies, the own videos', an own or built-in sticker's read and a track's bytes. Each is
// tested with a read that never returns: the job ends TIMEOUT within the bound, the slot is free, and once the read finally returns nothing is left. And the bound is sized from the
// SUM of the bytes `execute` names, so a legitimate slow copy of several GB is not cut at the minimum.

const world = useWorld();
const OUT = fakeVideoBytes(4096, 3);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const PHOTO = Uint8Array.from({ length: 2_000 }, (_, i) => (i * 5) & 0xff);
const MEZZANINE = Uint8Array.from({ length: 3_000 }, (_, i) => (i * 7) & 0xff);

let libDir = "";
beforeEach(async () => {
  libDir = join(world().renderTmp, "..", "library-media");
  await mkdir(libDir, { recursive: true });
  await writeFile(join(libDir, "media-0000001.jpg"), PHOTO);
  await writeFile(join(libDir, "media-0000002.mp4"), MEZZANINE);
});
afterEach(async () => {
  await rm(libDir, { recursive: true, force: true });
});

const photoSource = (): OwnPhotoSource => ({ mediaId: "media-0000001", path: join(libDir, "media-0000001.jpg"), sha256: sha(PHOTO), bytes: PHOTO.length, width: 40, height: 30 });
const videoSource = (): OwnVideoSource => ({ mediaId: "media-0000002", path: join(libDir, "media-0000002.mp4"), sha256: sha(MEZZANINE), bytes: MEZZANINE.length, width: 1080, height: 570, durationMs: 6_000 });

/** An op set whose reads of `suffix` files wait for `gate` (the second read on), as a dead disk's would. */
function hangingOps(suffix: string, gate: Promise<void>): OpenRegularOps {
  return {
    lstat: (path) => NODE_OPEN_OPS.lstat(path),
    open: async (path, flags) => {
      const real = await NODE_OPEN_OPS.open(path, flags);
      if (!path.endsWith(suffix)) return real;
      return new Proxy(real, {
        get(target, property) {
          if (property === "read") {
            return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
              await gate;
              return target.read(buffer, offset, length, position);
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
}

interface Options {
  readonly spec: (w: World) => MontageDraft;
  readonly plan?: Partial<RenderPlan>;
  readonly deps?: Partial<VideoRenderDeps>;
  readonly stagingTimeoutMs?: (bytes: number) => number;
  /** Keeps the job folder when the job ends, so a test can see what an abandoned copy does after it. */
  readonly keepJobFolder?: boolean;
}

async function run(options: Options) {
  const w = world();
  const ffmpeg: string[][] = [];
  const asked: number[] = [];
  const deps: VideoRenderDeps = {
    library: w.library,
    tracker: new CommitTracker(),
    renderTmpDir: w.renderTmp,
    caseProbe: { isCaseInsensitive: async () => false },
    now: () => new Date(2026, 9, 4, 10, 0, 0),
    verify: async (path) => acceptingVerify(path),
    runDeps: {
      run: async (opts: RunFfmpegArgvOptions) => {
        ffmpeg.push([...opts.argv]);
        reportVideoClipFrames(opts);
        await mkdir(dirname(opts.output), { recursive: true });
        await writeFile(opts.output, OUT);
      },
      stagingTimeoutMs: (bytes) => (asked.push(bytes), (options.stagingTimeoutMs ?? (() => 60_000))(bytes)),
      ...(options.keepJobFolder === true ? { removeTree: async () => undefined } : {}),
    },
    ownVideoIo: { freeBytes: async () => null },
    ...options.deps,
  };
  const spec = options.spec(w);
  const plan: RenderPlan = {
    jobId: "job-00000001",
    videoId: "video-00000001",
    avatarId: w.avatar.id,
    safeName: "Mia",
    exportRoot: { root: w.exportRoot, rootId: w.rootId },
    spec,
    resolvePhoto: (ref) => (ref.source === "own" ? { path: join(w.renderTmp, "job-00000001", `own-${ref.mediaId}.jpg`), width: 40, height: 30 } : undefined),
    audio: { kind: "silent" },
    montageId: null,
    title: null,
    videoKind: "mix",
    music: null,
    ...options.plan,
  };
  const queue = new RenderQueue({ jobs: new JobRegistry(), size: () => 1 });
  const execute = createRenderExecute(deps);
  queue.submit({ jobId: plan.jobId, ref: { videoId: plan.videoId, avatarId: plan.avatarId, montageId: null }, totalFrames: totalFramesOf(spec.clips), photoIds: [], mediaIds: [], execute: execute(plan) });
  const started = performance.now();
  await queue.idle();
  return { state: queue.states()[0], ffmpeg, asked, ms: performance.now() - started, w };
}

const ownPhotoClip = (n: number, durationMs: number): MontageDraft["clips"][number] => ({ clipId: `clip-0000000${n}`, kind: "photo", cell: { photo: { source: "own", mediaId: "media-0000001" }, focus: { x: 0.5, y: 0.4 } }, motion: "static", durationMs, transitionIn: "cut" });
const videoClip = (n: number, durationMs: number): MontageDraft["clips"][number] => ({ clipId: `clip-0000000${n}`, kind: "video", mediaId: "media-0000002", trimStartMs: 0, focus: null, durationMs, transitionIn: "cut" });
const base = (w: World): MontageDraft => specOf(w.avatar.id, [w.photos[0]?.id ?? ""], 4_000);

describe("every staging read is under the bound", () => {
  test("the abandoned photo copy is TOLD to stop: when its read returns it writes nothing (the job folder is kept here so that a write would show)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const { state, w } = await run({
      spec: (world) => ({ ...base(world), clips: [ownPhotoClip(1, 4_000)] }),
      plan: { ownPhotos: [photoSource()] },
      deps: { ownPhotoOps: hangingOps(".jpg", gate) },
      stagingTimeoutMs: () => 100,
      keepJobFolder: true,
    });
    expect(state).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
    release();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await readdir(join(w.renderTmp, "job-00000001"))).toEqual([]);
  });

  test("a hung own-PHOTO read ends the job TIMEOUT within the bound, frees the slot, and leaves nothing once the read returns", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const { state, ffmpeg, ms, w } = await run({
      spec: (world) => ({ ...base(world), clips: [ownPhotoClip(1, 4_000)] }),
      plan: { ownPhotos: [photoSource()] },
      deps: { ownPhotoOps: hangingOps(".jpg", gate) },
      stagingTimeoutMs: () => 150,
    });

    expect(state).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
    expect(ms).toBeLessThan(10_000);
    expect(ffmpeg).toEqual([]);
    expect(await exportFiles(w)).toEqual([]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readdir(w.renderTmp)).toEqual([]);
  });

  test("a hung TRACK read (the store's openForRender) ends the job TIMEOUT within the bound too", async () => {
    const tracks: NonNullable<VideoRenderDeps["tracks"]> = { openForRender: () => new Promise(() => undefined) };

    const { state, ffmpeg, ms } = await run({
      spec: (w) => ({ ...base(w), music: { source: "trending", trackId: "4199287736976977", startMs: 0 } }),
      plan: { track: { trackId: "4199287736976977", startMs: 0 } },
      deps: { tracks },
      stagingTimeoutMs: () => 150,
    });

    expect(state).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
    expect(ms).toBeLessThan(10_000);
    expect(ffmpeg).toEqual([]);
  });

  test("a hung sticker read (the layers' resolution) ends the job TIMEOUT within the bound too", async () => {
    const layers: NonNullable<VideoRenderDeps["layers"]> = {
      gate: { caption: async () => Promise.reject(new Error("no caption here")) },
      stickers: { read: () => new Promise(() => undefined) },
    };

    const { state, ffmpeg, ms } = await run({
      spec: (w) => ({ ...base(w), layers: [{ layerId: "layer-00000001", kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "builtin", stickerId: "heart-pulse" }, x: 0.5, y: 0.5, size: 0.3 }] }),
      deps: { layers },
      stagingTimeoutMs: () => 150,
    });

    expect(state).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
    expect(ms).toBeLessThan(10_000);
    expect(ffmpeg).toEqual([]);
  });

  test("a hung own-VIDEO read still ends the job TIMEOUT (round 2, now through the shared bound)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const { state, w } = await run({
      spec: (world) => ({ ...base(world), clips: [videoClip(1, 4_000)] }),
      plan: { ownVideos: [videoSource()] },
      deps: { ownVideoIo: { freeBytes: async () => null, open: hangingOps(".mp4", gate) } },
      stagingTimeoutMs: () => 150,
    });

    expect(state).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readdir(w.renderTmp)).toEqual([]);
  });
});

describe("the bound is sized from the SUM of every staged byte (B8)", () => {
  test("a photo and a video: the bound is asked for their bytes together, once, by `execute`", async () => {
    const { state, asked } = await run({
      spec: (w) => ({ ...base(w), clips: [ownPhotoClip(1, 2_000), videoClip(2, 2_000)] }),
      plan: { ownPhotos: [photoSource()], ownVideos: [videoSource()] },
    });

    expect(state).toMatchObject({ status: "done" });
    expect(asked).toEqual([PHOTO.length + MEZZANINE.length]);
  });

  test("an own track's bytes are in the sum too", async () => {
    const { asked } = await run({
      spec: (w) => ({ ...base(w), clips: [ownPhotoClip(1, 4_000)], music: { source: "own", mediaId: "media-0000009", startMs: 0 } }),
      plan: {
        ownPhotos: [photoSource()],
        ownTrack: { source: { mediaId: "media-0000009", path: join(libDir, "nothing.m4a"), sha256: "a".repeat(64), bytes: 777, durationMs: 9_000, name: "song.mp3" }, startMs: 0 },
      },
    });

    expect(asked).toEqual([PHOTO.length + 777]);
  });

  test("a bigger copy gets a bigger bound: the answer follows the bytes handed over, so a slow multi-GB copy is not cut at the minimum", async () => {
    const bounds: number[] = [];
    const policy = (bytes: number): number => (bounds.push(60_000 + bytes), 60_000 + bytes);

    await run({ spec: (w) => ({ ...base(w), clips: [videoClip(1, 4_000)] }), plan: { ownVideos: [videoSource()] }, stagingTimeoutMs: policy });
    await run({ spec: (w) => ({ ...base(w), clips: [ownPhotoClip(1, 2_000), videoClip(2, 2_000)] }), plan: { ownPhotos: [photoSource()], ownVideos: [videoSource()] }, stagingTimeoutMs: policy }).catch(() => undefined);

    expect(bounds[0]).toBe(60_000 + MEZZANINE.length);
    expect(bounds[1]).toBe(60_000 + MEZZANINE.length + PHOTO.length);
  });
});
