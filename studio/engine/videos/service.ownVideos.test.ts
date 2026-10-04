import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import type { EngineError, MediaKind } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { MediaLookup } from "../media/service";
import { runRenderJob } from "../renderQueue/runner";
import type { VideoServiceDeps } from "./service";
import { specOf, useWorld, type World } from "./testing/kit";
import { serviceRig, writingRun, type ServiceRig } from "./testing/serviceKit";
useNativeGlobals();

// `videos.render` with own video clips (3f.3b). The admission looks each own video up (as a VIDEO) and reserves it in the same step; the render STREAMS a verified copy of
// the mezzanine into its own job folder, never the library file; a clip that asks past the mezzanine's end is refused with a clear issue, never rendered shorter; and
// whatever refuses the render lets every reservation go. The same shape as the own stickers' tests: a media delete is refused while the render holds the video, and
// goes through after.

const world = useWorld();
const SPEC_MS = 4_000;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const mezzanine = (seed = 1): Uint8Array => Uint8Array.from({ length: 3_000 }, (_, i) => (i * 11 + seed * 5 + (i >> 6)) & 0xff);
/** The stored mezzanine's length in the library's record: 90 frames, 3 s, unless a test says otherwise. */
const DURATION_MS = 6_000;

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

interface Held {
  readonly bytes: Uint8Array;
  /** What kind the library holds it as; `video` unless a test says otherwise. */
  readonly kind?: MediaKind;
  readonly durationMs?: number;
}

interface FakeMedia {
  /** Each lookup as asked: the id and the kind. */
  readonly lookups: string[];
  readonly kinds: MediaKind[];
  /** The library file of each media. */
  readonly files: Map<string, string>;
  /** Whether the media was already reserved on the queue at the moment `onFound` returned, inside the lookup. */
  readonly reservedInsideLookup: boolean[];
  readonly port: NonNullable<VideoServiceDeps["media"]>;
}

async function fakeMedia(w: World, queue: () => { reservesMedia(mediaId: string): boolean }, held: Record<string, Held>): Promise<FakeMedia> {
  const dir = join(w.dir, "own-media");
  await mkdir(dir, { recursive: true });
  const files = new Map<string, string>();
  for (const [mediaId, entry] of Object.entries(held)) {
    const path = join(dir, `${mediaId}.mp4`);
    await writeFile(path, entry.bytes);
    files.set(mediaId, path);
  }
  const lookups: string[] = [];
  const kinds: MediaKind[] = [];
  const reservedInsideLookup: boolean[] = [];
  return {
    lookups,
    kinds,
    files,
    reservedInsideLookup,
    port: {
      lookup: async (mediaId, kind, onFound) => {
        lookups.push(mediaId);
        if (kind !== undefined) kinds.push(kind);
        const entry = held[mediaId];
        const path = files.get(mediaId);
        if (entry === undefined || path === undefined || (entry.kind ?? "video") !== kind) return undefined;
        const summary = { mediaId, kind: "video" as const, name: "holiday.mov", bytes: entry.bytes.length, createdAt: "2026-10-04T10:00:00.000Z", width: 1080, height: 570, durationMs: entry.durationMs ?? DURATION_MS, sourceFps: 29.97, hdrToSdr: false, loopFrames: null, delayFrames: null };
        const found: MediaLookup = { summary, path, sha256: sha(entry.bytes), bytes: entry.bytes.length, format: "mp4" };
        onFound?.(found);
        reservedInsideLookup.push(queue().reservesMedia(mediaId));
        return found;
      },
    },
  };
}

const videoClip = (n: number, mediaId: string, trimStartMs: number, durationMs: number): MontageDraft["clips"][number] => ({ clipId: `clip-${String(n).padStart(8, "0")}`, kind: "video", mediaId, trimStartMs, focus: { x: 0.5, y: 0.4 }, durationMs, transitionIn: "cut" });
const specWith = (w: World, clips: { mediaId: string; trimStartMs?: number; durationMs?: number }[]): MontageDraft => ({
  ...specOf(w.avatar.id, [w.photos[0]?.id ?? ""], SPEC_MS),
  clips: clips.map((c, i) => videoClip(i + 1, c.mediaId, c.trimStartMs ?? 0, c.durationMs ?? SPEC_MS / clips.length)),
});

/** A rig whose ffmpeg is a recorder: every call's argv, and (at the first call) the job folder's own videos as they stand then. */
function recordingRig(w: World, held: FakeMedia | undefined, extra: { gate?: Promise<void>; deps?: Partial<VideoServiceDeps> } = {}) {
  const calls: string[][] = [];
  const copies = new Map<string, Uint8Array>();
  const run = async (opts: RunFfmpegArgvOptions): Promise<void> => {
    calls.push([...opts.argv]);
    if (calls.length === 1) {
      const dir = join(w.renderTmp, opts.argv.find((a) => a.startsWith(w.renderTmp))?.slice(w.renderTmp.length + 1).split(/[\\/]/)[0] ?? "");
      for (const name of existsSync(dir) ? await readdir(dir) : []) if (name.startsWith("own-")) copies.set(name, new Uint8Array(await readFile(join(dir, name))));
    }
    await writeFile(opts.output, "x").catch(() => undefined);
    await writingRun(opts);
  };
  const renderOverrides = {
    runDeps: { run },
    ...(extra.gate === undefined ? {} : { runJob: (async (input, deps) => (await extra.gate, runRenderJob(input, deps))) as typeof runRenderJob }),
  };
  const rig = serviceRig(w, { deps: { ...(held === undefined ? {} : { media: held.port }), renderOverrides, ...extra.deps } });
  rigRef.rig = rig;
  return { rig, calls, copies };
}

const rigRef: { rig: ServiceRig } = { rig: undefined as unknown as ServiceRig };
const queueOf = () => rigRef.rig.queue;

describe("videos.render: own video clips", () => {
  test("queues the render and ends it done: an own video clip is no longer refused", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig } = recordingRig(w, media);

    const answer = await rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001", trimStartMs: 1_000 }]) });
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)?.status).toBe("done");
  });

  test("ffmpeg reads a private copy in the job's own folder, never the library file", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig, calls } = recordingRig(w, media);

    const answer = await rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) });
    await rig.queue.idle();

    const everything = calls.flat();
    expect(everything).toContain(join(w.renderTmp, answer.jobId, "own-media-0000001.mp4"));
    expect(everything).not.toContain(media.files.get("media-0000001"));
  });

  test("the private copy is the verified bytes of the library file", async () => {
    const w = world();
    const bytes = mezzanine(4);
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes } });
    const { rig, copies } = recordingRig(w, media);

    await rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) });
    await rig.queue.idle();

    expect(copies.get("own-media-0000001.mp4")).toEqual(bytes);
  });

  test("a media used by two clips is looked up once and copied once", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig, copies } = recordingRig(w, media);

    await rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001", trimStartMs: 0 }, { mediaId: "media-0000001", trimStartMs: 2_000 }]) });
    await rig.queue.idle();

    expect(media.lookups).toEqual(["media-0000001"]);
    expect([...copies.keys()]).toEqual(["own-media-0000001.mp4"]);
  });

  test("a video is looked up as a VIDEO", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig } = recordingRig(w, media);

    await rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) });
    await rig.queue.idle();

    expect(media.kinds).toEqual(["video"]);
  });

  test("the clip's focus is kept as it was asked for (a video's focus is the owner's, never judged by the face detector)", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig } = recordingRig(w, media);
    const spec = specWith(w, [{ mediaId: "media-0000001" }]);
    const first = spec.clips[0];
    const focused: MontageDraft = { ...spec, clips: first?.kind === "video" ? [{ ...first, focus: { x: 0.9, y: 0.1 } }] : spec.clips };

    await rig.service.render({ spec: focused });
    await rig.queue.idle();

    const record = rig.queue.states()[0];
    expect(record?.status).toBe("done");
  });
});

describe("videos.render: the admission reserves what it looks up", () => {
  test("the video is already reserved when the lookup's own step returns, before the answer travels back", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig } = recordingRig(w, media);

    await rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) });
    await rig.queue.idle();

    expect(media.reservedInsideLookup).toEqual([true]);
  });

  test("the video stays reserved while the render is queued or running, and is let go when it ends", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig } = recordingRig(w, media, { gate });

    await rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) });
    expect(rig.queue.reservesMedia("media-0000001")).toBe(true);
    release();
    await rig.queue.idle();

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a video that a QUEUED render names is reserved too", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() }, "media-0000002": { bytes: mezzanine(2) } });
    const { rig } = recordingRig(w, media, { gate });

    await rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) });
    await rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000002" }]) });
    expect(rig.queue.states().map((s) => s.status)).toEqual(["running", "queued"]);
    expect(rig.queue.reservesMedia("media-0000002")).toBe(true);
    release();
    await rig.queue.idle();
    expect(rig.queue.reservesMedia("media-0000002")).toBe(false);
  });

  test("a video and an own photo of one render are both reserved, and both let go", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 1, 1, 0xff, 0xd9]);
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() }, "media-0000002": { bytes: jpeg, kind: "photo" } });
    const { rig } = recordingRig(w, media, { gate });
    const spec: MontageDraft = {
      ...specWith(w, [{ mediaId: "media-0000001", durationMs: 2_000 }]),
      clips: [
        videoClip(1, "media-0000001", 0, 2_000),
        { clipId: "clip-00000002", kind: "photo", cell: { photo: { source: "own", mediaId: "media-0000002" }, focus: { x: 0.5, y: 0.4 } }, motion: "static", durationMs: 2_000, transitionIn: "cut" },
      ],
    };

    await rig.service.render({ spec });
    expect([rig.queue.reservesMedia("media-0000001"), rig.queue.reservesMedia("media-0000002")]).toEqual([true, true]);
    expect(media.kinds.sort()).toEqual(["photo", "video"]);
    release();
    await rig.queue.idle();
    expect([rig.queue.reservesMedia("media-0000001"), rig.queue.reservesMedia("media-0000002")]).toEqual([false, false]);
  });
});

describe("videos.render: an own video that is not there, or that the clip outgrows", () => {
  test("a media the library does not hold is MONTAGE_INVALID with media-unavailable at its clip, and nothing is touched", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, {});
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000404" }]) }));

    expect(error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0] }] });
    expect(rig.queue.states()).toEqual([]);
    expect(rig.queue.reservesMedia("media-0000404")).toBe(false);
    expect(await readdir(w.renderTmp)).toEqual([]);
    expect(rig.checks).toHaveLength(0);
  });

  test("a media the library holds as another kind is the same", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine(), kind: "sticker" } });
    const { rig } = recordingRig(w, media);

    expect(await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) }))).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0] }] });
  });

  test("with no media store wired no own video is held", async () => {
    const w = world();
    const { rig } = recordingRig(w, undefined);

    expect(await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) }))).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0] }] });
  });

  test("every clip that names a missing media is marked, and a media that IS there is not", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000404", durationMs: 1_000 }, { mediaId: "media-0000001", durationMs: 2_000 }, { mediaId: "media-0000404", durationMs: 1_000 }]) }));

    expect(error.issues).toEqual([
      { code: "media-unavailable", path: ["clips", 0] },
      { code: "media-unavailable", path: ["clips", 2] },
    ]);
  });

  test("the video that WAS found before a missing one is let go again", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig } = recordingRig(w, media);

    await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001", durationMs: 2_000 }, { mediaId: "media-0000404", durationMs: 2_000 }]) }));

    expect(media.reservedInsideLookup).toEqual([true]);
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a clip that ends exactly at the stored video's end is rendered", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine(), durationMs: 5_000 } });
    const { rig } = recordingRig(w, media);

    const answer = await rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001", trimStartMs: 1_000, durationMs: 4_000 }]) });
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)?.status).toBe("done");
  });

  test("a clip that asks one step past the stored video's end is MONTAGE_INVALID with video-too-short at its clip, never a shorter clip, and the hold is let go", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine(), durationMs: 4_900 } });
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001", trimStartMs: 1_000, durationMs: 4_000 }]) }));

    expect(error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "video-too-short", path: ["clips", 0] }] });
    expect(media.reservedInsideLookup).toEqual([true]);
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
    expect(rig.queue.states()).toEqual([]);
    expect(await readdir(w.renderTmp)).toEqual([]);
  });

  test("a stored video of 89 frames (2967 ms) cannot give a 3 s clip, and one of 90 frames (3000 ms) can", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine(), durationMs: 2_967 }, "media-0000002": { bytes: mezzanine(2), durationMs: 3_000 } });
    const { rig } = recordingRig(w, media);
    const spec = (mediaId: string): MontageDraft => ({ ...specWith(w, [{ mediaId, durationMs: 3_000 }]), clips: [videoClip(1, mediaId, 0, 3_000), videoClip(2, mediaId, 0, 1_000)] });

    expect(await failureOf(rig.service.render({ spec: spec("media-0000001") }))).toMatchObject({ issues: [{ code: "video-too-short", path: ["clips", 0] }] });
    const ok = await rig.service.render({ spec: spec("media-0000002") });
    await rig.queue.idle();
    expect(rig.jobs.stateOf(ok.jobId)?.status).toBe("done");
  });

  test("each clip is judged on its own trim: a second clip that outgrows the video is marked, the first is not", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine(), durationMs: 5_000 } });
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001", trimStartMs: 0, durationMs: 2_000 }, { mediaId: "media-0000001", trimStartMs: 4_000, durationMs: 2_000 }]) }));

    expect(error.issues).toEqual([{ code: "video-too-short", path: ["clips", 1] }]);
  });

  test("a missing own photo, then a missing own video, then a missing own sticker: the issues come in the order the draft's verdict gives them", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, {});
    const { rig } = recordingRig(w, media, { deps: { layers: { gate: { caption: async () => Promise.reject(new Error("none")) }, stickers: { read: () => Promise.reject(new Error("none")) } } } });
    const spec: MontageDraft = {
      ...specWith(w, [{ mediaId: "media-0000404", durationMs: 2_000 }]),
      clips: [
        videoClip(1, "media-0000404", 0, 2_000),
        { clipId: "clip-00000002", kind: "photo", cell: { photo: { source: "own", mediaId: "media-0000405" }, focus: { x: 0.5, y: 0.4 } }, motion: "static", durationMs: 2_000, transitionIn: "cut" },
      ],
      layers: [{ layerId: "layer-00000001", kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "own", mediaId: "media-0000406" }, x: 0.5, y: 0.5, size: 0.3 }],
    };

    const error = await failureOf(rig.service.render({ spec }));

    expect(error.issues).toEqual([
      { code: "media-unavailable", path: ["clips", 1, "cell"] },
      { code: "media-unavailable", path: ["clips", 0] },
      { code: "media-unavailable", path: ["layers", 0, "sticker"] },
    ]);
  });

  test("a spec with structural issues is refused for those, and the media store is never asked", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000404", durationMs: 1_000 }]) }));

    expect(error.issues?.map((i) => i.code)).toEqual(["duration-too-short"]);
    expect(media.lookups).toEqual([]);
  });
});

describe("videos.render: the video is held from the admission until the queue takes over, and until the render ends", () => {
  test("held while the export folder is being checked (a hung checkExport), held by the queue once submitted, free when it ends", async () => {
    const w = world();
    let openExport: () => void = () => undefined;
    const exportGate = new Promise<void>((resolve) => (openExport = resolve));
    let askedExport: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => (askedExport = resolve));
    let endRender: () => void = () => undefined;
    const renderGate = new Promise<void>((resolve) => (endRender = resolve));
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const checkExport: VideoServiceDeps["checkExport"] = async () => {
      askedExport();
      await exportGate;
      return { ok: true, root: w.exportRoot, rootId: w.rootId };
    };
    const { rig } = recordingRig(w, media, { gate: renderGate, deps: { checkExport } });
    const rendering = rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) });
    await asked;
    // 1. During the wait nothing but the admission's hold keeps the video: no job exists yet.
    expect(rig.queue.states()).toEqual([]);
    expect(rig.queue.reservesMedia("media-0000001")).toBe(true);
    openExport();
    const { jobId } = await rendering;
    // 2. Submitted: the queue's own reservation (the job names it) holds it, and the job is still running.
    expect(rig.jobs.stateOf(jobId)?.status).toBe("running");
    expect(rig.queue.reservesMedia("media-0000001")).toBe(true);
    // 3. Ended: free.
    endRender();
    await rig.queue.idle();
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a checkExport that never answers does not keep the video once the command's own deadline has ended the render", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const checkExport: VideoServiceDeps["checkExport"] = () => new Promise(() => undefined);
    const { rig } = recordingRig(w, media, { deps: { checkExport, commandDeadlineMs: 80, commandMarginMs: 10 } });

    expect((await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) }))).code).toBe("EXPORT_UNAVAILABLE");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });
});

describe("videos.render: a refusal after the admission lets the video go", () => {
  test("an export folder that is not usable", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig } = recordingRig(w, media, { deps: { checkExport: async () => ({ ok: false, reason: "missing" }) } });

    expect((await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) }))).code).toBe("EXPORT_UNAVAILABLE");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a scene photo that another render holds", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const { rig } = recordingRig(w, media, { gate });
    await rig.service.render({ spec: specOf(w.avatar.id, [w.photos[0]?.id ?? ""], SPEC_MS) });
    const mixed: MontageDraft = { ...specOf(w.avatar.id, [w.photos[0]?.id ?? ""], 2_000), clips: [...specOf(w.avatar.id, [w.photos[0]?.id ?? ""], 2_000).clips, videoClip(2, "media-0000001", 0, 2_000)] };

    expect((await failureOf(rig.service.render({ spec: mixed }))).code).toBe("PHOTO_UNAVAILABLE");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
    release();
    await rig.queue.idle();
  });

  test("a library that was switched while the render was being prepared", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: mezzanine() } });
    const other = await w.reopen();
    const { rig } = recordingRig(w, media, { deps: { withLibrary: (work) => work(other) } });

    expect((await failureOf(rig.service.render({ spec: specWith(w, [{ mediaId: "media-0000001" }]) }))).code).toBe("IN_FLIGHT");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });
});

// The mezzanine is copied when its job STARTS, not when it is admitted, so to change the file in between a test holds the queue's single slot with another render: this
// one waits behind it, queued and reserved, and starts when that one ends.
describe("a render's own video that changed after the admission", () => {
  async function queuedBehindAnother(w: World, mediaIds: string[], held: Record<string, Held>) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, queueOf, held);
    const { rig, calls } = recordingRig(w, media, { gate });
    await rig.service.render({ spec: specOf(w.avatar.id, [w.photos[1]?.id ?? ""], SPEC_MS) });
    const answer = await rig.service.render({ spec: specWith(w, mediaIds.map((mediaId) => ({ mediaId }))) });
    expect(rig.jobs.stateOf(answer.jobId)?.status).toBe("queued");
    expect(rig.queue.reservesMedia(mediaIds[0] ?? "")).toBe(true);
    return { rig, calls, media, answer, release };
  }

  test("a library file whose bytes changed fails the job before ffmpeg as media-unavailable at its clip, without a path, and lets the video go", async () => {
    const w = world();
    const { rig, calls, media, answer, release } = await queuedBehindAnother(w, ["media-0000001"], { "media-0000001": { bytes: mezzanine() } });

    await writeFile(media.files.get("media-0000001") ?? "", mezzanine(9));
    release();
    await rig.queue.idle();

    const state = rig.jobs.stateOf(answer.jobId);
    expect(state).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0] }] } });
    expect(JSON.stringify(state)).not.toContain(w.dir);
    expect(JSON.stringify(state)).not.toContain("media-0000001");
    expect(calls.flat().some((arg) => arg.includes(answer.jobId))).toBe(false);
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a library file that became a link, even to a file with the right bytes, fails the job the same way", async () => {
    const w = world();
    const { rig, calls, media, answer, release } = await queuedBehindAnother(w, ["media-0000001"], { "media-0000001": { bytes: mezzanine() }, "media-0000002": { bytes: mezzanine() } });

    const original = media.files.get("media-0000001") ?? "";
    await rm(original);
    await symlink(media.files.get("media-0000002") ?? "", original);
    release();
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID" } });
    expect(calls.flat().some((arg) => arg.includes(answer.jobId))).toBe(false);
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a library file that is gone fails the job the same way", async () => {
    const w = world();
    const { rig, media, answer, release } = await queuedBehindAnother(w, ["media-0000001"], { "media-0000001": { bytes: mezzanine() } });

    await rm(media.files.get("media-0000001") ?? "");
    release();
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0] }] } });
  });

  test("an untouched file renders: the same queued render ends done once the slot is free", async () => {
    const w = world();
    const { rig, answer, release } = await queuedBehindAnother(w, ["media-0000001"], { "media-0000001": { bytes: mezzanine() } });

    release();
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)?.status).toBe("done");
  });
});
