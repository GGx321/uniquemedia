import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import type { MediaLookup } from "../media/service";
import { runRenderJob } from "../renderQueue/runner";
import { ownPhotoCopyName } from "./ownPhotos";
import type { VideoServiceDeps } from "./service";
import { specOf, useWorld, type World } from "./testing/kit";
import { fillingFocus, serviceRig, writingRun, type ServiceRig } from "./testing/serviceKit";
useNativeGlobals();

// `videos.render` with own photos in its cells (3f.2). The admission looks each own photo up and reserves it in the same step; the render
// reads a VERIFIED COPY in its own job folder, never the library file; and whatever refuses the render lets every reservation go.

const world = useWorld();

const JPEG = (marker: number): Uint8Array => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, marker, marker, marker, 0xff, 0xd9]);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

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
  readonly width: number;
  readonly height: number;
  /** What kind the library holds it as; `photo` unless a test says otherwise. */
  readonly kind?: "photo" | "video";
}

interface FakeMedia {
  readonly lookups: string[];
  /** The library file of each media. */
  readonly files: Map<string, string>;
  /** Whether the media was already reserved on the queue at the moment `onFound` returned, inside the lookup. */
  readonly reservedInsideLookup: boolean[];
  readonly port: { lookup(mediaId: string, kind: "photo", onFound?: (found: MediaLookup) => void): Promise<MediaLookup | undefined> };
}

async function fakeMedia(w: World, queue: () => { reservesMedia(mediaId: string): boolean }, held: Record<string, Held>): Promise<FakeMedia> {
  const dir = join(w.dir, "own-media");
  await mkdir(dir, { recursive: true });
  const files = new Map<string, string>();
  for (const [mediaId, entry] of Object.entries(held)) {
    const path = join(dir, `${mediaId}.jpg`);
    await writeFile(path, entry.bytes);
    files.set(mediaId, path);
  }
  const lookups: string[] = [];
  const reservedInsideLookup: boolean[] = [];
  return {
    lookups,
    files,
    reservedInsideLookup,
    port: {
      lookup: async (mediaId, kind, onFound) => {
        lookups.push(mediaId);
        const entry = held[mediaId];
        const path = files.get(mediaId);
        if (entry === undefined || path === undefined || (entry.kind ?? "photo") !== kind) return undefined;
        const summary = { mediaId, kind: "photo" as const, name: "own.jpg", bytes: entry.bytes.length, createdAt: "2026-10-04T10:00:00.000Z", width: entry.width, height: entry.height, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null };
        const found: MediaLookup = { summary, path, sha256: sha(entry.bytes), bytes: entry.bytes.length, format: "jpeg" };
        onFound?.(found);
        reservedInsideLookup.push(queue().reservesMedia(mediaId));
        return found;
      },
    },
  };
}

const ownCell = (mediaId: string) => ({ photo: { source: "own" as const, mediaId }, focus: { x: 0.5, y: 0.4 } });
const photoClip = (n: number, mediaId: string, durationMs = 4_000): MontageDraft["clips"][number] => ({ clipId: `clip-${String(n).padStart(8, "0")}`, kind: "photo", cell: ownCell(mediaId), motion: "static", durationMs, transitionIn: "cut" });
const ownSpec = (w: World, mediaIds: string[], durationMs = 4_000): MontageDraft => ({ ...specOf(w.avatar.id, [], durationMs), clips: mediaIds.map((mediaId, i) => photoClip(i + 1, mediaId, durationMs)) });

/** A rig whose ffmpeg is a recorder: every call's argv, and (at the first call) the private copies as they stand then. */
function recordingRig(w: World, held: FakeMedia | undefined, extra: { gate?: Promise<void>; size?: number; deps?: Partial<VideoServiceDeps> } = {}) {
  const calls: string[][] = [];
  const copies = new Map<string, Uint8Array>();
  const holder: { rig?: ServiceRig } = {};
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
  const rig = serviceRig(w, { ...(extra.size === undefined ? {} : { size: extra.size }), deps: { ...(held === undefined ? {} : { media: held.port }), renderOverrides, ...extra.deps } });
  holder.rig = rig;
  return { rig, calls, copies };
}

describe("videos.render: own photos in the cells", () => {
  test("queues the render and ends it done: the own photo is no longer refused", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig } = recordingRig(w, media);
    rigRef.rig = rig;

    const answer = await rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)?.status).toBe("done");
  });

  test("ffmpeg reads a private copy in the job's own folder, never the library file", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig, calls } = recordingRig(w, media);
    rigRef.rig = rig;

    const answer = await rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    await rig.queue.idle();

    const inputs = calls[0]?.flatMap((arg, i) => (calls[0]?.[i - 1] === "-i" ? [arg] : [])) ?? [];
    expect(inputs).toEqual([join(w.renderTmp, answer.jobId, ownPhotoCopyName("media-0000001"))]);
    expect(inputs).not.toContain(media.files.get("media-0000001"));
  });

  test("the private copy is the verified bytes of the library file", async () => {
    const w = world();
    const bytes = JPEG(7);
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes, width: 1080, height: 1920 } });
    const { rig, copies } = recordingRig(w, media);
    rigRef.rig = rig;

    await rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    await rig.queue.idle();

    expect(copies.get(ownPhotoCopyName("media-0000001"))).toEqual(bytes);
  });

  test("one copy per media, however many cells use it", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig, copies } = recordingRig(w, media);
    rigRef.rig = rig;

    await rig.service.render({ spec: ownSpec(w, ["media-0000001", "media-0000001"], 2_000) });
    await rig.queue.idle();

    expect([...copies.keys()]).toEqual([ownPhotoCopyName("media-0000001")]);
    expect(media.lookups).toEqual(["media-0000001"]);
  });

  test("the focus resolver is given the cells with their own photos in them", async () => {
    const w = world();
    const seen: MontageDraft[] = [];
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const rig = serviceRig(w, { deps: { media: media.port, focus: () => fillingFocus(seen) } });
    rigRef.rig = rig;

    await rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    await rig.queue.idle();

    expect(seen[0]?.clips[0]).toMatchObject({ cell: { photo: { source: "own", mediaId: "media-0000001" } } });
  });
});

const rigRef: { rig: ServiceRig } = { rig: undefined as unknown as ServiceRig };

describe("videos.render: the admission reserves what it looks up", () => {
  test("the media is already reserved when the lookup's own step returns, before the answer travels back", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig } = recordingRig(w, media);
    rigRef.rig = rig;

    await rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    await rig.queue.idle();

    expect(media.reservedInsideLookup).toEqual([true]);
  });

  test("the media stays reserved while the render is queued or running, and is let go when it ends", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig } = recordingRig(w, media, { gate });
    rigRef.rig = rig;

    await rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    expect(rig.queue.reservesMedia("media-0000001")).toBe(true);
    release();
    await rig.queue.idle();

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a media that a QUEUED render names is reserved too", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, {
      "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 },
      "media-0000002": { bytes: JPEG(2), width: 1080, height: 1920 },
    });
    const { rig } = recordingRig(w, media, { gate });
    rigRef.rig = rig;

    await rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    await rig.service.render({ spec: ownSpec(w, ["media-0000002"]) });
    expect(rig.queue.states().map((s) => s.status)).toEqual(["running", "queued"]);
    expect(rig.queue.reservesMedia("media-0000002")).toBe(true);
    release();
    await rig.queue.idle();
    expect(rig.queue.reservesMedia("media-0000002")).toBe(false);
  });

  test("two renders may use the same media", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig } = recordingRig(w, media, { gate });
    rigRef.rig = rig;

    await rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    await rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    expect(rig.queue.states()).toHaveLength(2);
    release();
    await rig.queue.idle();
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });
});

describe("videos.render: an own photo that is not there", () => {
  test("a media the library does not hold is MONTAGE_INVALID with media-unavailable at its cell, and nothing is touched", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, {});
    const { rig } = recordingRig(w, media);
    rigRef.rig = rig;

    const error = await failureOf(rig.service.render({ spec: ownSpec(w, ["media-0000404"]) }));

    expect(error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0, "cell"] }] });
    expect(rig.queue.states()).toEqual([]);
    expect(rig.queue.reservesMedia("media-0000404")).toBe(false);
    expect(await readdir(w.renderTmp)).toEqual([]);
    expect(rig.checks).toHaveLength(0);
  });

  test("a media the library holds as another kind is the same", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 10, height: 10, kind: "video" } });
    const { rig } = recordingRig(w, media);
    rigRef.rig = rig;

    expect(await failureOf(rig.service.render({ spec: ownSpec(w, ["media-0000001"]) }))).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0, "cell"] }] });
  });

  test("with no media store wired no own photo is held", async () => {
    const w = world();
    const { rig } = recordingRig(w, undefined);

    expect(await failureOf(rig.service.render({ spec: ownSpec(w, ["media-0000001"]) }))).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0, "cell"] }] });
  });

  test("every cell that names a missing media is marked, and a media that IS there is not", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig } = recordingRig(w, media);
    rigRef.rig = rig;

    const error = await failureOf(rig.service.render({ spec: ownSpec(w, ["media-0000404", "media-0000001", "media-0000404"], 2_000) }));

    expect(error.issues).toEqual([
      { code: "media-unavailable", path: ["clips", 0, "cell"] },
      { code: "media-unavailable", path: ["clips", 2, "cell"] },
    ]);
  });

  test("the media that WAS found before a missing one is let go again", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig } = recordingRig(w, media);
    rigRef.rig = rig;

    await failureOf(rig.service.render({ spec: ownSpec(w, ["media-0000001", "media-0000404"], 2_000) }));

    expect(media.reservedInsideLookup).toEqual([true]);
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a spec with structural issues is refused for those, and the media store is never asked", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig } = recordingRig(w, media);
    rigRef.rig = rig;

    const error = await failureOf(rig.service.render({ spec: ownSpec(w, ["media-0000404"], 1_000) }));

    expect(error.issues?.map((i) => i.code)).toEqual(["duration-too-short"]);
    expect(media.lookups).toEqual([]);
  });
});

describe("videos.render: the media is held from the admission until the queue takes over, and until the render ends (review M2)", () => {
  test("held while the export folder is being checked, held by the queue once the render is submitted, free when it ends", async () => {
    const w = world();
    let openExport: () => void = () => undefined;
    const exportGate = new Promise<void>((resolve) => (openExport = resolve));
    let askedExport: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => (askedExport = resolve));
    let endRender: () => void = () => undefined;
    const renderGate = new Promise<void>((resolve) => (endRender = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    // The export check hangs: the render is admitted (its media found and held) but not yet submitted.
    const checkExport: VideoServiceDeps["checkExport"] = async () => {
      askedExport();
      await exportGate;
      return { ok: true, root: w.exportRoot, rootId: w.rootId };
    };
    const { rig } = recordingRig(w, media, { gate: renderGate, deps: { checkExport } });
    rigRef.rig = rig;
    const rendering = rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    await asked;
    // 1. During the wait nothing but the admission's hold keeps the media: no job exists yet.
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
});

describe("videos.render: a refusal after the admission lets the media go", () => {
  test("an export folder that is not usable", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const rig = serviceRig(w, { deps: { media: media.port, checkExport: async () => ({ ok: false, reason: "missing" }) } });
    rigRef.rig = rig;

    expect((await failureOf(rig.service.render({ spec: ownSpec(w, ["media-0000001"]) }))).code).toBe("EXPORT_UNAVAILABLE");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a scene photo that another render holds", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig } = recordingRig(w, media, { gate });
    rigRef.rig = rig;
    const scenePhoto = w.photos[0]?.id ?? "";
    await rig.service.render({ spec: specOf(w.avatar.id, [scenePhoto], 4_000) });
    const mixed: MontageDraft = { ...ownSpec(w, ["media-0000001"], 2_000), clips: [...ownSpec(w, ["media-0000001"], 2_000).clips, ...specOf(w.avatar.id, [scenePhoto], 2_000).clips.map((c) => ({ ...c, clipId: "clip-90000001" }))] };

    expect((await failureOf(rig.service.render({ spec: mixed }))).code).toBe("PHOTO_UNAVAILABLE");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
    release();
    await rig.queue.idle();
  });

  test("a library that was switched while the render was being prepared", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const other = await w.reopen();
    const rig = serviceRig(w, { deps: { media: media.port, withLibrary: (work) => work(other) } });
    rigRef.rig = rig;

    expect((await failureOf(rig.service.render({ spec: ownSpec(w, ["media-0000001"]) }))).code).toBe("IN_FLIGHT");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });
});

describe("a render's own photo that changed after the admission", () => {
  test("a library file whose bytes changed fails the job before ffmpeg, without a path, and lets the media go", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { "media-0000001": { bytes: JPEG(1), width: 1080, height: 1920 } });
    const { rig, calls } = recordingRig(w, media, { gate });
    rigRef.rig = rig;

    const answer = await rig.service.render({ spec: ownSpec(w, ["media-0000001"]) });
    await writeFile(media.files.get("media-0000001") ?? "", JPEG(2));
    release();
    await rig.queue.idle();

    const state = rig.jobs.stateOf(answer.jobId);
    expect(state).toMatchObject({ status: "failed", error: { code: "RENDER_FAILED" } });
    expect(JSON.stringify(state)).not.toContain(w.dir);
    expect(calls).toHaveLength(0);
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
    expect(await readdir(w.renderTmp)).toEqual([]);
  });
});
