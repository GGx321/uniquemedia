import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { EngineError, MediaKind } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import type { MediaLookup } from "../media/service";
import { runRenderJob } from "../renderQueue/runner";
import type { VideoServiceDeps } from "./service";
import { specOf, useWorld, type World } from "./testing/kit";
import { serviceRig, writingRun, type ServiceRig } from "./testing/serviceKit";
useNativeGlobals();

// `videos.render` with an own TRACK as its music (3f.4), the way service.ownPhotos.test.ts plays an own photo. The admission looks the track up as an AUDIO media and
// reserves it in the same step that finds it (`MediaService.lookup`'s `onFound`: no await between the two); the hold lasts until `submit`, after which the queue's
// own reservation takes over, and it is let go on every end path. The job reads the track's VERIFIED BYTES, never the library file.

const world = useWorld();
const rigRef: { rig: ServiceRig } = { rig: undefined as unknown as ServiceRig };

const M4A = Uint8Array.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 2, 0, 1, 2, 3, 4]);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const TRACK = "media-0000009";
const PHOTO = "media-0000001";

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
  readonly kind: MediaKind;
  readonly durationMs?: number | null;
  readonly format?: MediaLookup["format"];
}

interface FakeMedia {
  /** Every lookup, in order, with the kind it asked for. */
  readonly lookups: Array<{ mediaId: string; kind: MediaKind }>;
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
    const path = join(dir, `${mediaId}.${entry.kind === "audio" ? "m4a" : "jpg"}`);
    await writeFile(path, entry.bytes);
    files.set(mediaId, path);
  }
  const lookups: FakeMedia["lookups"] = [];
  const reservedInsideLookup: boolean[] = [];
  return {
    lookups,
    files,
    reservedInsideLookup,
    port: {
      lookup: async (mediaId, kind, onFound) => {
        lookups.push({ mediaId, kind });
        const entry = held[mediaId];
        const path = files.get(mediaId);
        if (entry === undefined || path === undefined || entry.kind !== kind) return undefined;
        const summary =
          entry.kind === "audio"
            ? { mediaId, kind: "audio" as const, name: "my song.mp3", bytes: entry.bytes.length, createdAt: "2026-10-04T10:00:00.000Z", width: null, height: null, durationMs: entry.durationMs === undefined ? 9_000 : entry.durationMs, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null }
            : { mediaId, kind: "photo" as const, name: "own.jpg", bytes: entry.bytes.length, createdAt: "2026-10-04T10:00:00.000Z", width: 1080, height: 1920, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null };
        const found: MediaLookup = { summary, path, sha256: sha(entry.bytes), bytes: entry.bytes.length, format: entry.format ?? (entry.kind === "audio" ? "m4a" : "jpeg") };
        onFound?.(found);
        reservedInsideLookup.push(queue().reservesMedia(mediaId));
        return found;
      },
    },
  };
}

const photoClip = (n: number, durationMs: number, mediaId?: string): MontageDraft["clips"][number] => ({
  clipId: `clip-${String(n).padStart(8, "0")}`,
  kind: "photo",
  cell: { photo: { source: "own" as const, mediaId: mediaId ?? PHOTO }, focus: { x: 0.5, y: 0.4 } },
  motion: "static",
  durationMs,
  transitionIn: "cut",
});

/** One scene-photo clip of 4 s (the shortest spec) with the own track as music. `photoIndex` says which of the world's three photos. */
function trackSpec(w: World, startMs = 0, mediaId = TRACK, photoIndex = 0): MontageDraft {
  return { ...specOf(w.avatar.id, [w.photos[photoIndex]?.id ?? ""], 4_000), music: { source: "own", mediaId, startMs } };
}

/** A rig whose ffmpeg is a recorder, and whose stream check of the track's private copy is scripted. */
function recordingRig(w: World, media: FakeMedia | undefined, extra: { gate?: Promise<void>; kinds?: readonly string[]; deps?: Partial<VideoServiceDeps> } = {}) {
  const calls: string[][] = [];
  const inspected: string[] = [];
  const run = async (opts: RunFfmpegArgvOptions): Promise<void> => {
    calls.push([...opts.argv]);
    await writeFile(opts.output, "x").catch(() => undefined);
    await writingRun(opts);
  };
  const renderOverrides = {
    runDeps: { run, measure: async () => -5.7 },
    inspectStreams: async (path: string) => (inspected.push(path), extra.kinds ?? ["Audio"]),
    ...(extra.gate === undefined ? {} : { runJob: (async (input, deps) => (await extra.gate, runRenderJob(input, deps))) as typeof runRenderJob }),
  };
  const rig = serviceRig(w, { deps: { ...(media === undefined ? {} : { media: media.port }), renderOverrides, ...extra.deps } });
  rigRef.rig = rig;
  return { rig, calls, inspected };
}

const heldTrack = (extra: Partial<Held> = {}): Held => ({ bytes: M4A, kind: "audio", ...extra });

describe("videos.render: an own track as the music", () => {
  test("queues the render and ends it done: the own track is no longer refused", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const { rig } = recordingRig(w, media);

    const answer = await rig.service.render({ spec: trackSpec(w) });
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)?.status).toBe("done");
  });

  test("the track is looked up as an AUDIO media, once", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const { rig } = recordingRig(w, media);

    await rig.service.render({ spec: trackSpec(w) });
    await rig.queue.idle();

    expect(media.lookups).toEqual([{ mediaId: TRACK, kind: "audio" }]);
  });

  test("ffmpeg reads the job's private copy of the track, never the library file", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const { rig, calls, inspected } = recordingRig(w, media);

    const answer = await rig.service.render({ spec: trackSpec(w) });
    await rig.queue.idle();

    const copy = join(w.renderTmp, answer.jobId, "track.m4a");
    expect(inspected).toEqual([copy]);
    expect(calls.flat()).toContain(copy);
    expect(calls.flat()).not.toContain(media.files.get(TRACK));
  });

  test("an own track and an own photo in one montage are both looked up and both held", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack(), [PHOTO]: { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 1]), kind: "photo" } });
    const { rig } = recordingRig(w, media, { gate });
    const spec: MontageDraft = { ...specOf(w.avatar.id, [], 2_000), clips: [photoClip(1, 2_000), photoClip(2, 2_000)], music: { source: "own", mediaId: TRACK, startMs: 0 } };

    await rig.service.render({ spec });

    expect(media.lookups).toEqual([
      { mediaId: PHOTO, kind: "photo" },
      { mediaId: TRACK, kind: "audio" },
    ]);
    expect(rig.queue.reservesMedia(PHOTO)).toBe(true);
    expect(rig.queue.reservesMedia(TRACK)).toBe(true);
    release();
    await rig.queue.idle();
    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
    expect(rig.queue.reservesMedia(PHOTO)).toBe(false);
  });

  test("a trending track never asks the media store", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const { rig } = recordingRig(w, media, { deps: { tracks: { stored: () => ({ decodedMs: 9_000 }), openForRender: async () => Promise.reject(new Error("not used")) } } });

    await rig.service.render({ spec: { ...trackSpec(w), music: { source: "trending", trackId: "4199287736976977", startMs: 0 } } });
    await rig.queue.idle();

    expect(media.lookups).toEqual([]);
  });
});

describe("videos.render: the admission reserves the track it looks up", () => {
  test("the track is already reserved when the lookup's own step returns, before the answer travels back", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const { rig } = recordingRig(w, media);

    await rig.service.render({ spec: trackSpec(w) });
    await rig.queue.idle();

    expect(media.reservedInsideLookup).toEqual([true]);
  });

  test("it stays reserved while the render is queued or running, and is let go when it ends", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const { rig } = recordingRig(w, media, { gate });

    await rig.service.render({ spec: trackSpec(w) });
    expect(rig.queue.reservesMedia(TRACK)).toBe(true);
    release();
    await rig.queue.idle();

    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
  });

  test("a track that a QUEUED render names is reserved too, and two renders may use the same track", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const { rig } = recordingRig(w, media, { gate });

    await rig.service.render({ spec: trackSpec(w) });
    await rig.service.render({ spec: trackSpec(w, 500, TRACK, 1) });
    expect(rig.queue.states().map((s) => s.status)).toEqual(["running", "queued"]);
    expect(rig.queue.reservesMedia(TRACK)).toBe(true);
    release();
    await rig.queue.idle();
    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
  });
});

describe("videos.render: an own track that is not there, or not long enough", () => {
  test("a media the library does not hold is MONTAGE_INVALID media-unavailable at music, and nothing is touched", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, {});
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: trackSpec(w, 0, "media-0000404") }));

    expect(error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] });
    expect(rig.queue.states()).toEqual([]);
    expect(rig.queue.reservesMedia("media-0000404")).toBe(false);
    expect(await readdir(w.renderTmp)).toEqual([]);
    expect(rig.checks).toHaveLength(0);
  });

  test("a media the library holds as another kind (a photo) is the same, and is not held", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [PHOTO]: { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 1]), kind: "photo" } });
    const { rig } = recordingRig(w, media);

    expect(await failureOf(rig.service.render({ spec: trackSpec(w, 0, PHOTO) }))).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] });
    expect(rig.queue.reservesMedia(PHOTO)).toBe(false);
  });

  test("a track with no recorded length is not one the render can place: media-unavailable, and not held", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack({ durationMs: null }) });
    const { rig } = recordingRig(w, media);

    expect(await failureOf(rig.service.render({ spec: trackSpec(w) }))).toMatchObject({ issues: [{ code: "media-unavailable", path: ["music"] }] });
    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
  });

  test.each(["mp3", "wav", "flac"] as const)("a track stored as %s is not one the render's chain reads: media-unavailable, and not held", async (format) => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack({ format }) });
    const { rig } = recordingRig(w, media);

    expect(await failureOf(rig.service.render({ spec: trackSpec(w) }))).toMatchObject({ issues: [{ code: "media-unavailable", path: ["music"] }] });
    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
  });

  test("with no media store wired no own track is held", async () => {
    const w = world();
    const { rig } = recordingRig(w, undefined);

    expect(await failureOf(rig.service.render({ spec: trackSpec(w) }))).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] });
  });

  test("a track one millisecond short of startMs plus the montage is track-too-short, and the hold it made is let go", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack({ durationMs: 5_499 }) });
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: trackSpec(w, 1_500) }));

    expect(error.issues).toEqual([{ code: "track-too-short", path: ["music"] }]);
    expect(media.reservedInsideLookup).toEqual([true]);
    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
    expect(await readdir(w.renderTmp)).toEqual([]);
  });

  test("a track exactly as long as startMs plus the montage is accepted", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack({ durationMs: 5_500 }) });
    const { rig } = recordingRig(w, media);

    await rig.service.render({ spec: trackSpec(w, 1_500) });
    await rig.queue.idle();

    expect(rig.queue.states()[0]).toMatchObject({ status: "done" });
  });

  test("an own photo found before a missing track is let go again, and the issues keep the photos before the track", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [PHOTO]: { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 1]), kind: "photo" } });
    const { rig } = recordingRig(w, media);
    const spec: MontageDraft = { ...specOf(w.avatar.id, [], 2_000), clips: [photoClip(1, 2_000, "media-0000404"), photoClip(2, 2_000)], music: { source: "own", mediaId: TRACK, startMs: 0 } };

    const error = await failureOf(rig.service.render({ spec }));

    expect(error.issues).toEqual([
      { code: "media-unavailable", path: ["clips", 0, "cell"] },
      { code: "media-unavailable", path: ["music"] },
    ]);
    expect(rig.queue.reservesMedia(PHOTO)).toBe(false);
  });

  test("a spec with structural issues is refused for those, and the media store is never asked about the track", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: { ...trackSpec(w), clips: [] } }));

    expect(error.issues?.map((i) => i.code)).toEqual(["no-clips"]);
    expect(media.lookups).toEqual([]);
  });
});

describe("videos.render: the track is held from the admission until the queue takes over, and until the render ends", () => {
  test("held while the export folder is being checked (a hung check), held by the queue once the render is submitted, free when it ends", async () => {
    const w = world();
    let openExport: () => void = () => undefined;
    const exportGate = new Promise<void>((resolve) => (openExport = resolve));
    let askedExport: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => (askedExport = resolve));
    let endRender: () => void = () => undefined;
    const renderGate = new Promise<void>((resolve) => (endRender = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    // The export check hangs: the render is admitted (its track found and held) but not yet submitted.
    const checkExport: VideoServiceDeps["checkExport"] = async () => {
      askedExport();
      await exportGate;
      return { ok: true, root: w.exportRoot, rootId: w.rootId };
    };
    const { rig } = recordingRig(w, media, { gate: renderGate, deps: { checkExport } });
    const rendering = rig.service.render({ spec: trackSpec(w) });
    await asked;
    // 1. During the wait nothing but the admission's hold keeps the track: no job exists yet.
    expect(rig.queue.states()).toEqual([]);
    expect(rig.queue.reservesMedia(TRACK)).toBe(true);
    openExport();
    const { jobId } = await rendering;
    // 2. Submitted: the queue's own reservation (the job names it) holds it, and the job is still running.
    expect(rig.jobs.stateOf(jobId)?.status).toBe("running");
    expect(rig.queue.reservesMedia(TRACK)).toBe(true);
    // 3. Ended: free.
    endRender();
    await rig.queue.idle();
    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
  });

  test("a hung export check that finally says no lets the track go", async () => {
    const w = world();
    let openExport: () => void = () => undefined;
    const exportGate = new Promise<void>((resolve) => (openExport = resolve));
    let askedExport: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => (askedExport = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const checkExport: VideoServiceDeps["checkExport"] = async () => {
      askedExport();
      await exportGate;
      return { ok: false, reason: "missing" };
    };
    const { rig } = recordingRig(w, media, { deps: { checkExport } });
    const rendering = failureOf(rig.service.render({ spec: trackSpec(w) }));
    await asked;
    expect(rig.queue.reservesMedia(TRACK)).toBe(true);
    openExport();
    expect((await rendering).code).toBe("EXPORT_UNAVAILABLE");
    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
  });
});

describe("videos.render: a refusal after the admission lets the track go", () => {
  test("an export folder that is not usable", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const rig = serviceRig(w, { deps: { media: media.port, checkExport: async () => ({ ok: false, reason: "missing" }) } });
    rigRef.rig = rig;

    expect((await failureOf(rig.service.render({ spec: trackSpec(w) }))).code).toBe("EXPORT_UNAVAILABLE");

    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
  });

  test("a scene photo that another render holds", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const { rig } = recordingRig(w, media, { gate });
    await rig.service.render({ spec: specOf(w.avatar.id, [w.photos[0]?.id ?? ""], 4_000) });

    expect((await failureOf(rig.service.render({ spec: trackSpec(w) }))).code).toBe("PHOTO_UNAVAILABLE");

    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
    release();
    await rig.queue.idle();
  });

  test("a library that was switched while the render was being prepared", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const other = await w.reopen();
    const rig = serviceRig(w, { deps: { media: media.port, withLibrary: (work) => work(other) } });
    rigRef.rig = rig;

    expect((await failureOf(rig.service.render({ spec: trackSpec(w) }))).code).toBe("IN_FLIGHT");

    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
  });
});

describe("a render's own track that changed after the admission", () => {
  test("a library file whose bytes changed fails the job before ffmpeg, as media-unavailable and with no path, and lets the track go", async () => {
    const w = world();
    const held = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    // `execute` reads the track itself (`openTrack`), BEFORE `runJob`, as soon as the queue starts the job: a gate on `runJob` comes too late to order a write after
    // `render` returns (on a slow runner the job read the old bytes first and ended done). So the bytes change INSIDE the admission, once the lookup has answered
    // with the record (its sha256 is the old bytes') and before it returns: the job cannot start until `render` has queued it, so it always reads the changed file.
    const changed = Uint8Array.from(M4A);
    changed[19] = 99;
    const media: FakeMedia = {
      ...held,
      port: {
        lookup: async (mediaId, kind, onFound) => {
          const found = await held.port.lookup(mediaId, kind, onFound);
          await writeFile(held.files.get(TRACK) ?? "", changed);
          return found;
        },
      },
    };
    const { rig, calls } = recordingRig(w, media);

    const answer = await rig.service.render({ spec: trackSpec(w) });
    await rig.queue.idle();

    const state = rig.jobs.stateOf(answer.jobId);
    expect(state).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] } });
    expect(JSON.stringify(state)).not.toContain(w.dir);
    expect(calls).toHaveLength(0);
    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
    expect(await readdir(w.renderTmp)).toEqual([]);
  });

  test("a copy ffmpeg does not see as one audio stream fails the job as media-unavailable and lets the track go", async () => {
    const w = world();
    const media = await fakeMedia(w, () => rigRef.rig.queue, { [TRACK]: heldTrack() });
    const { rig, calls } = recordingRig(w, media, { kinds: ["Audio", "Video"] });

    const answer = await rig.service.render({ spec: trackSpec(w) });
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] } });
    expect(calls).toHaveLength(0);
    expect(rig.queue.reservesMedia(TRACK)).toBe(false);
  });
});
