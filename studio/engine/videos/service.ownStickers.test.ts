import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import type { EngineError, MediaKind } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { MediaLookup } from "../media/service";
import { flatApng, type Rgba } from "../media/stickerFixtures.testkit";
import { runRenderJob } from "../renderQueue/runner";
import type { VideoServiceDeps } from "./service";
import { specOf, useWorld, type World } from "./testing/kit";
import { serviceRig, writingRun, type ServiceRig } from "./testing/serviceKit";
useNativeGlobals();

// `videos.render` with own stickers in its layers (3f.5). The admission looks each own sticker up (as a STICKER) and reserves it in the same step; the
// render reads a VERIFIED COPY in its own job folder, never the library file; and whatever refuses the render lets every reservation go. The same
// shape as the own photos' tests (service.ownPhotos.test.ts): a media delete is refused while the render holds the sticker, and goes through after.

const world = useWorld();
const SPEC_MS = 4_000;
const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const stickerBytes = (first: Rgba = RED, second: Rgba = GREEN): Uint8Array => flatApng([first, second], { width: 12, height: 8 });

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
  /** What kind the library holds it as; `sticker` unless a test says otherwise. */
  readonly kind?: MediaKind;
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
    const path = join(dir, `${mediaId}.png`);
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
        if (entry === undefined || path === undefined || (entry.kind ?? "sticker") !== kind) return undefined;
        const summary = { mediaId, kind: "sticker" as const, name: "own.gif", bytes: entry.bytes.length, createdAt: "2026-10-04T10:00:00.000Z", width: 12, height: 8, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: 2, delayFrames: [1, 1] };
        const found: MediaLookup = { summary, path, sha256: sha(entry.bytes), bytes: entry.bytes.length, format: "apng" };
        onFound?.(found);
        reservedInsideLookup.push(queue().reservesMedia(mediaId));
        return found;
      },
    },
  };
}

const stickerLayer = (n: number, mediaId: string) => ({ layerId: `layer-${String(n).padStart(8, "0")}`, kind: "sticker" as const, startMs: 0, endMs: 1_000, sticker: { source: "own" as const, mediaId }, x: 0.5, y: 0.5, size: 0.3 });
const specWith = (w: World, mediaIds: string[], durationMs = SPEC_MS): MontageDraft => ({ ...specOf(w.avatar.id, [w.photos[0]?.id ?? ""], durationMs), layers: mediaIds.map((mediaId, i) => stickerLayer(i + 1, mediaId)) });

/** The text gate and built-in set an engine with layers has; neither is used by a spec of own stickers alone. */
const LAYERS: NonNullable<VideoServiceDeps["layers"]> = {
  gate: {
    caption: async () => {
      throw new Error("no caption in these specs");
    },
  },
  stickers: { read: () => Promise.reject(new Error("no built-in sticker in these specs")) },
};

/** A rig whose ffmpeg is a recorder: every call's argv, and (at the first call) the job folder's own stickers as they stand then. */
function recordingRig(w: World, held: FakeMedia | undefined, extra: { gate?: Promise<void>; deps?: Partial<VideoServiceDeps> } = {}) {
  const calls: string[][] = [];
  const copies = new Map<string, Uint8Array>();
  const run = async (opts: RunFfmpegArgvOptions): Promise<void> => {
    calls.push([...opts.argv]);
    if (calls.length === 1) {
      const dir = join(w.renderTmp, opts.argv.find((a) => a.startsWith(w.renderTmp))?.slice(w.renderTmp.length + 1).split(/[\\/]/)[0] ?? "");
      for (const name of existsSync(dir) ? await readdir(dir) : []) if (name.startsWith("sticker-")) copies.set(name, new Uint8Array(await readFile(join(dir, name))));
    }
    await writeFile(opts.output, "x").catch(() => undefined);
    await writingRun(opts);
  };
  const renderOverrides = {
    runDeps: { run },
    ...(extra.gate === undefined ? {} : { runJob: (async (input, deps) => (await extra.gate, runRenderJob(input, deps))) as typeof runRenderJob }),
  };
  const rig = serviceRig(w, { deps: { layers: LAYERS, ...(held === undefined ? {} : { media: held.port }), renderOverrides, ...extra.deps } });
  rigRef.rig = rig;
  return { rig, calls, copies };
}

const rigRef: { rig: ServiceRig } = { rig: undefined as unknown as ServiceRig };
const queueOf = () => rigRef.rig.queue;

describe("videos.render: own stickers in the layers", () => {
  test("queues the render and ends it done: an own sticker is no longer refused", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig } = recordingRig(w, media);

    const answer = await rig.service.render({ spec: specWith(w, ["media-0000001"]) });
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)?.status).toBe("done");
  });

  test("ffmpeg reads a private copy in the job's own folder, never the library file", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig, calls } = recordingRig(w, media);

    const answer = await rig.service.render({ spec: specWith(w, ["media-0000001"]) });
    await rig.queue.idle();

    const everything = calls.flat();
    expect(everything).toContain(join(w.renderTmp, answer.jobId, "sticker-00.apng"));
    expect(everything).not.toContain(media.files.get("media-0000001"));
  });

  test("the private copy is the verified bytes of the library file", async () => {
    const w = world();
    const bytes = stickerBytes(GREEN, RED);
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes } });
    const { rig, copies } = recordingRig(w, media);

    await rig.service.render({ spec: specWith(w, ["media-0000001"]) });
    await rig.queue.idle();

    expect(copies.get("sticker-00.apng")).toEqual(bytes);
  });

  test("a media used by two layers is looked up once and each layer gets its own copy", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig, copies } = recordingRig(w, media);

    await rig.service.render({ spec: specWith(w, ["media-0000001", "media-0000001"]) });
    await rig.queue.idle();

    expect(media.lookups).toEqual(["media-0000001"]);
    expect([...copies.keys()].sort()).toEqual(["sticker-00.apng", "sticker-01.apng"]);
  });

  test("a sticker is looked up as a STICKER", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig } = recordingRig(w, media);

    await rig.service.render({ spec: specWith(w, ["media-0000001"]) });
    await rig.queue.idle();

    expect(media.kinds).toEqual(["sticker"]);
  });
});

describe("videos.render: the admission reserves what it looks up", () => {
  test("the sticker is already reserved when the lookup's own step returns, before the answer travels back", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig } = recordingRig(w, media);

    await rig.service.render({ spec: specWith(w, ["media-0000001"]) });
    await rig.queue.idle();

    expect(media.reservedInsideLookup).toEqual([true]);
  });

  test("the sticker stays reserved while the render is queued or running, and is let go when it ends", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig } = recordingRig(w, media, { gate });

    await rig.service.render({ spec: specWith(w, ["media-0000001"]) });
    expect(rig.queue.reservesMedia("media-0000001")).toBe(true);
    release();
    await rig.queue.idle();

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a sticker that a QUEUED render names is reserved too", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() }, "media-0000002": { bytes: stickerBytes(GREEN, RED) } });
    const { rig } = recordingRig(w, media, { gate });

    await rig.service.render({ spec: specWith(w, ["media-0000001"]) });
    const second: MontageDraft = { ...specWith(w, ["media-0000002"]), clips: specOf(w.avatar.id, [w.photos[1]?.id ?? ""], SPEC_MS).clips };
    await rig.service.render({ spec: second });
    expect(rig.queue.states().map((s) => s.status)).toEqual(["running", "queued"]);
    expect(rig.queue.reservesMedia("media-0000002")).toBe(true);
    release();
    await rig.queue.idle();
    expect(rig.queue.reservesMedia("media-0000002")).toBe(false);
  });

  test("an own photo and an own sticker of one render are both reserved, and both let go", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 1, 1, 0xff, 0xd9]);
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() }, "media-0000002": { bytes: jpeg, kind: "photo" } });
    const { rig } = recordingRig(w, media, { gate });
    const spec: MontageDraft = {
      ...specWith(w, ["media-0000001"]),
      clips: [{ clipId: "clip-00000001", kind: "photo", cell: { photo: { source: "own", mediaId: "media-0000002" }, focus: { x: 0.5, y: 0.4 } }, motion: "static", durationMs: SPEC_MS, transitionIn: "cut" }],
    };

    await rig.service.render({ spec });
    expect([rig.queue.reservesMedia("media-0000001"), rig.queue.reservesMedia("media-0000002")]).toEqual([true, true]);
    expect(media.kinds.sort()).toEqual(["photo", "sticker"]);
    release();
    await rig.queue.idle();
    expect([rig.queue.reservesMedia("media-0000001"), rig.queue.reservesMedia("media-0000002")]).toEqual([false, false]);
  });
});

describe("videos.render: an own sticker that is not there", () => {
  test("a media the library does not hold is MONTAGE_INVALID with media-unavailable at its layer's sticker, and nothing is touched", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, {});
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: specWith(w, ["media-0000404"]) }));

    expect(error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["layers", 0, "sticker"] }] });
    expect(rig.queue.states()).toEqual([]);
    expect(rig.queue.reservesMedia("media-0000404")).toBe(false);
    expect(await readdir(w.renderTmp)).toEqual([]);
    expect(rig.checks).toHaveLength(0);
  });

  test("a media the library holds as another kind is the same", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes(), kind: "video" } });
    const { rig } = recordingRig(w, media);

    expect(await failureOf(rig.service.render({ spec: specWith(w, ["media-0000001"]) }))).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["layers", 0, "sticker"] }] });
  });

  test("with no media store wired no own sticker is held", async () => {
    const w = world();
    const { rig } = recordingRig(w, undefined);

    expect(await failureOf(rig.service.render({ spec: specWith(w, ["media-0000001"]) }))).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["layers", 0, "sticker"] }] });
  });

  test("every layer that names a missing media is marked, and a media that IS there is not", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: specWith(w, ["media-0000404", "media-0000001", "media-0000404"]) }));

    expect(error.issues).toEqual([
      { code: "media-unavailable", path: ["layers", 0, "sticker"] },
      { code: "media-unavailable", path: ["layers", 2, "sticker"] },
    ]);
  });

  test("the sticker that WAS found before a missing one is let go again", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig } = recordingRig(w, media);

    await failureOf(rig.service.render({ spec: specWith(w, ["media-0000001", "media-0000404"]) }));

    expect(media.reservedInsideLookup).toEqual([true]);
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a missing own photo and a missing own sticker are both reported, the photo first (clips, then layers)", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, {});
    const { rig } = recordingRig(w, media);
    const spec: MontageDraft = {
      ...specWith(w, ["media-0000404"]),
      clips: [{ clipId: "clip-00000001", kind: "photo", cell: { photo: { source: "own", mediaId: "media-0000405" }, focus: { x: 0.5, y: 0.4 } }, motion: "static", durationMs: SPEC_MS, transitionIn: "cut" }],
    };

    const error = await failureOf(rig.service.render({ spec }));

    expect(error.issues).toEqual([
      { code: "media-unavailable", path: ["clips", 0, "cell"] },
      { code: "media-unavailable", path: ["layers", 0, "sticker"] },
    ]);
  });

  test("a spec with structural issues is refused for those, and the media store is never asked", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig } = recordingRig(w, media);

    const error = await failureOf(rig.service.render({ spec: specWith(w, ["media-0000404"], 1_000) }));

    expect(error.issues?.map((i) => i.code)).toEqual(["duration-too-short"]);
    expect(media.lookups).toEqual([]);
  });
});

describe("videos.render: the sticker is held from the admission until the queue takes over, and until the render ends", () => {
  test("held while the export folder is being checked (a hung checkExport), held by the queue once submitted, free when it ends", async () => {
    const w = world();
    let openExport: () => void = () => undefined;
    const exportGate = new Promise<void>((resolve) => (openExport = resolve));
    let askedExport: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => (askedExport = resolve));
    let endRender: () => void = () => undefined;
    const renderGate = new Promise<void>((resolve) => (endRender = resolve));
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    // The export check hangs: the render is admitted (its sticker found and held) but not yet submitted.
    const checkExport: VideoServiceDeps["checkExport"] = async () => {
      askedExport();
      await exportGate;
      return { ok: true, root: w.exportRoot, rootId: w.rootId };
    };
    const { rig } = recordingRig(w, media, { gate: renderGate, deps: { checkExport } });
    const rendering = rig.service.render({ spec: specWith(w, ["media-0000001"]) });
    await asked;
    // 1. During the wait nothing but the admission's hold keeps the sticker: no job exists yet.
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

  test("a checkExport that never answers does not keep the sticker once the command's own deadline has ended the render", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const checkExport: VideoServiceDeps["checkExport"] = () => new Promise(() => undefined);
    const { rig } = recordingRig(w, media, { deps: { checkExport, commandDeadlineMs: 80, commandMarginMs: 10 } });

    expect((await failureOf(rig.service.render({ spec: specWith(w, ["media-0000001"]) }))).code).toBe("EXPORT_UNAVAILABLE");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });
});

describe("videos.render: a refusal after the admission lets the sticker go", () => {
  test("an export folder that is not usable", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig } = recordingRig(w, media, { deps: { checkExport: async () => ({ ok: false, reason: "missing" }) } });

    expect((await failureOf(rig.service.render({ spec: specWith(w, ["media-0000001"]) }))).code).toBe("EXPORT_UNAVAILABLE");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a scene photo that another render holds", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const { rig } = recordingRig(w, media, { gate });
    await rig.service.render({ spec: specOf(w.avatar.id, [w.photos[0]?.id ?? ""], SPEC_MS) });

    expect((await failureOf(rig.service.render({ spec: specWith(w, ["media-0000001"]) }))).code).toBe("PHOTO_UNAVAILABLE");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
    release();
    await rig.queue.idle();
  });

  test("a library that was switched while the render was being prepared", async () => {
    const w = world();
    const media = await fakeMedia(w, queueOf, { "media-0000001": { bytes: stickerBytes() } });
    const other = await w.reopen();
    const { rig } = recordingRig(w, media, { deps: { withLibrary: (work) => work(other) } });

    expect((await failureOf(rig.service.render({ spec: specWith(w, ["media-0000001"]) }))).code).toBe("IN_FLIGHT");

    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });
});

// The sticker is read when its job STARTS (the layers are resolved first thing), not when it is admitted, so to change the file in between a test
// holds the queue's single slot with another render: this one waits behind it, queued and reserved, and starts when that one ends.
describe("a render's own sticker that changed after the admission", () => {
  /** A render of a scene photo that holds the slot until `release`, then the render under test queued behind it. */
  async function queuedBehindAnother(w: World, mediaIds: string[], held: Record<string, Held>) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const media = await fakeMedia(w, queueOf, held);
    const { rig, calls } = recordingRig(w, media, { gate });
    await rig.service.render({ spec: specOf(w.avatar.id, [w.photos[1]?.id ?? ""], SPEC_MS) });
    const answer = await rig.service.render({ spec: specWith(w, mediaIds) });
    expect(rig.jobs.stateOf(answer.jobId)?.status).toBe("queued");
    expect(rig.queue.reservesMedia(mediaIds[0] ?? "")).toBe(true);
    return { rig, calls, media, answer, release };
  }

  test("a library file whose bytes changed fails the job before ffmpeg, without a path, and lets the sticker go", async () => {
    const w = world();
    const { rig, calls, media, answer, release } = await queuedBehindAnother(w, ["media-0000001"], { "media-0000001": { bytes: stickerBytes() } });

    await writeFile(media.files.get("media-0000001") ?? "", stickerBytes(GREEN, RED));
    release();
    await rig.queue.idle();

    const state = rig.jobs.stateOf(answer.jobId);
    expect(state).toMatchObject({ status: "failed", error: { code: "RENDER_FAILED" } });
    expect(JSON.stringify(state)).not.toContain(w.dir);
    expect(JSON.stringify(state)).not.toContain("media-0000001");
    expect(calls.flat().some((arg) => arg.includes(answer.jobId))).toBe(false);
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a library file that became a link, even to a file with the right bytes, fails the job the same way", async () => {
    const w = world();
    const { rig, calls, media, answer, release } = await queuedBehindAnother(w, ["media-0000001"], { "media-0000001": { bytes: stickerBytes() }, "media-0000002": { bytes: stickerBytes() } });

    const { rm, symlink } = await import("node:fs/promises");
    const original = media.files.get("media-0000001") ?? "";
    await rm(original);
    await symlink(media.files.get("media-0000002") ?? "", original);
    release();
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)).toMatchObject({ status: "failed", error: { code: "RENDER_FAILED" } });
    expect(calls.flat().some((arg) => arg.includes(answer.jobId))).toBe(false);
    expect(rig.queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a library file that is gone fails the job the same way", async () => {
    const w = world();
    const { rig, media, answer, release } = await queuedBehindAnother(w, ["media-0000001"], { "media-0000001": { bytes: stickerBytes() } });

    const { rm } = await import("node:fs/promises");
    await rm(media.files.get("media-0000001") ?? "");
    release();
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)).toMatchObject({ status: "failed", error: { code: "RENDER_FAILED" } });
  });

  test("an untouched file renders: the same queued render ends done once the slot is free", async () => {
    const w = world();
    const { rig, answer, release } = await queuedBehindAnother(w, ["media-0000001"], { "media-0000001": { bytes: stickerBytes() } });

    release();
    await rig.queue.idle();

    expect(rig.jobs.stateOf(answer.jobId)?.status).toBe("done");
  });
});
