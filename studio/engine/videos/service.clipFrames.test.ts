import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import type { EngineError, MediaKind, MediaOrigin } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { MediaLookup } from "../media/service";
import type { RenderQueue } from "../renderQueue/queue";
import { videoPaths } from "./record";
import type { VideoServiceDeps } from "./service";
import { specOf, useWorld, type World } from "./testing/kit";
import { serviceRig, withOverrides, writingRun } from "./testing/serviceKit";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.60, Q-F = 1): a photo and every clip made from it are ONE frame, at the service. `videos.render` resolves the frames of a spec from its clip copies' origins once, at admission:
// it refuses a foreign avatar's copy (frame-foreign), a photo together with a clip of it or a clip twice (frame-repeated), and a used, held, rejected or missing frame, each at the clip's own path;
// it reserves the frame by passing its photo into the queue; and the record keeps the snapshot, so a deleted clip or copy never frees a used frame. The caller table of the plan (§5.1.3) is pinned
// here for the service's callers; the used index, the recovery and the drafts have their own files.

const world = useWorld();
const SPEC_MS = 4_000;
const bytesOf = (seed: number): Uint8Array => Uint8Array.from({ length: 3_000 }, (_, i) => (i * 11 + seed * 5 + (i >> 6)) & 0xff);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const photoOf = (w: World, i: number): string => w.photos[i]?.id ?? "";
const FOREIGN_AVATAR = "avatar-other-0001";

/** The copies the library holds in these tests: media id, the clip it is the copy of, and the photo that clip was made from. */
interface CopyDef {
  readonly mediaId: string;
  readonly origin: MediaOrigin;
}
const copy = (mediaId: string, avatarId: string, clipId: string, photoId: string): CopyDef => ({ mediaId, origin: { kind: "clip", avatarId, clipId, photoId } });

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

interface FakeMedia {
  readonly port: NonNullable<VideoServiceDeps["media"]>;
  /** Forgets a copy, as `media.delete` does after the render. */
  remove(mediaId: string): void;
}

function fakeMedia(w: World, copies: readonly CopyDef[]): FakeMedia {
  const dir = join(w.dir, "own-media");
  mkdirSync(dir, { recursive: true });
  const held = new Map<string, { def: CopyDef; bytes: Uint8Array; path: string }>();
  copies.forEach((def, i) => {
    const bytes = bytesOf(i + 1);
    const path = join(dir, `${def.mediaId}.mp4`);
    writeFileSync(path, bytes);
    held.set(def.mediaId, { def, bytes, path });
  });
  return {
    remove: (mediaId) => void held.delete(mediaId),
    port: {
      lookup: async (mediaId, kind: MediaKind, onFound) => {
        const entry = held.get(mediaId);
        if (entry === undefined || kind !== "video") return undefined;
        const summary = { mediaId, kind: "video" as const, name: "Клип 2026-10-14 22-17.mp4", bytes: entry.bytes.length, createdAt: "2026-10-14T20:30:00.000Z", width: 720, height: 1280, durationMs: 6_000, sourceFps: 24, hdrToSdr: false, loopFrames: null, delayFrames: null, origin: entry.def.origin };
        const found: MediaLookup = { summary, path: entry.path, sha256: sha(entry.bytes), bytes: entry.bytes.length, format: "mp4" };
        onFound?.(found);
        return found;
      },
    },
  };
}

const videoClip = (n: number, mediaId: string, durationMs: number): MontageDraft["clips"][number] => ({ clipId: `clip-${String(n).padStart(8, "0")}`, kind: "video", mediaId, trimStartMs: 0, focus: { x: 0.5, y: 0.4 }, durationMs, transitionIn: "cut" });
const sceneClip = (w: World, n: number, photoId: string, durationMs: number): MontageDraft["clips"][number] => specOf(w.avatar.id, [photoId], durationMs).clips.map((c) => ({ ...c, clipId: `clip-${String(n).padStart(8, "0")}` }))[0] as MontageDraft["clips"][number];

type Part = { scene: string } | { copy: string };
/** A spec of scene photo clips and clip copies, in the order given, 4 s in all. */
function specOfParts(w: World, parts: readonly Part[]): MontageDraft {
  const each = SPEC_MS / parts.length;
  return { ...specOf(w.avatar.id, [photoOf(w, 0)], SPEC_MS), clips: parts.map((part, i) => ("scene" in part ? sceneClip(w, i + 1, part.scene, each) : videoClip(i + 1, part.copy, each))) };
}

/** A rig whose scripted ffmpeg can be held until `open()`. */
function rigWith(w: World, copies: readonly CopyDef[], extra: { gate?: boolean; deps?: Partial<VideoServiceDeps>; size?: number } = {}) {
  const media = fakeMedia(w, copies);
  let open: () => void = () => undefined;
  const door = new Promise<void>((resolve) => (open = resolve));
  let started = 0;
  const run = async (opts: RunFfmpegArgvOptions): Promise<void> => {
    started++;
    if (extra.gate === true) await door;
    await writingRun(opts);
  };
  const rig = serviceRig(w, { ...(extra.size === undefined ? {} : { size: extra.size }), deps: { media: media.port, renderOverrides: { runDeps: { run } }, ...extra.deps } });
  return { rig, media, open, started: () => started };
}

const recordOf = (w: World, videoId: string): Record<string, unknown> => JSON.parse(readFileSync(videoPaths(w.libraryRoot, w.avatar.id).record(videoId), "utf8")) as Record<string, unknown>;
const usedIn = (w: World, photoId: string): string[] => w.library.photoStates(w.avatar.id).get(photoId)?.usedIn ?? [];
const stateOf = (w: World, photoId: string) => w.library.photoStates(w.avatar.id).get(photoId);

describe("videos.render with a clip's copy: the frame is reserved, then used", () => {
  test("the clip's photo is reserved on the queue while the render runs, with the scene photo and no other", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig, open } = rigWith(w, [m1], { gate: true });

    const { jobId } = await rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) });

    expect([...rig.queue.reservedPhotos(w.avatar.id)].sort()).toEqual([photoOf(w, 0), photoOf(w, 1)].sort());
    open();
    await rig.queue.idle();
    expect(rig.queue.states().find((s) => s.jobId === jobId)?.status).toBe("done");
  });

  test("the committed record keeps the snapshot clipFrames, and the used index takes the clip's photo", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig } = rigWith(w, [m1]);

    const { videoId } = await rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) });
    await rig.queue.idle();

    expect(recordOf(w, videoId).clipFrames).toEqual([{ mediaId: m1.mediaId, clipId: "clip-0000001", photoId: photoOf(w, 1) }]);
    expect(usedIn(w, photoOf(w, 0))).toEqual([videoId]);
    expect(usedIn(w, photoOf(w, 1))).toEqual([videoId]);
    expect(usedIn(w, photoOf(w, 2))).toEqual([]);
  });

  test("a render with no clip copy writes a record with no clipFrames key", async () => {
    const w = world();
    const { rig } = rigWith(w, []);
    const { videoId } = await rig.service.render({ spec: specOf(w.avatar.id, [photoOf(w, 0)], SPEC_MS) });
    await rig.queue.idle();
    expect("clipFrames" in recordOf(w, videoId)).toBe(false);
  });

  test("a deleted copy and a deleted clip keep the photo used: the record's snapshot is the truth, and so is a reload from disk", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig, media } = rigWith(w, [m1]);
    const { videoId } = await rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) });
    await rig.queue.idle();

    media.remove(m1.mediaId);
    await w.library.reloadVideoRecords(w.avatar.id);

    expect(usedIn(w, photoOf(w, 1))).toEqual([videoId]);
    const error = await failureOf(rig.service.render({ spec: specOf(w.avatar.id, [photoOf(w, 1)], SPEC_MS) }));
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "in-video" });
  });
});

describe("videos.render: what the admission refuses, at the clip's own path", () => {
  test("a copy of another avatar's clip is PHOTO_UNAVAILABLE frame-foreign, and nothing stays held", async () => {
    const w = world();
    const foreign = copy("media-copy-0009", FOREIGN_AVATAR, "clip-0000009", "photo-foreign-1");
    const { rig } = rigWith(w, [foreign]);

    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: foreign.mediaId }]) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", detail: "frame-foreign", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
    expect(rig.queue.reservesMedia(foreign.mediaId)).toBe(false);
    expect(rig.queue.states()).toEqual([]);
  });

  test("a photo together with a clip made from it is PHOTO_UNAVAILABLE frame-repeated, at the clip", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig } = rigWith(w, [m1]);

    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 1) }, { copy: m1.mediaId }]) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", detail: "frame-repeated", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
    expect(rig.queue.reservesMedia(m1.mediaId)).toBe(false);
  });

  test("the same copy twice in one spec is frame-repeated, at the second", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig } = rigWith(w, [m1]);

    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ copy: m1.mediaId }, { scene: photoOf(w, 0) }, { copy: m1.mediaId }]) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", detail: "frame-repeated", issues: [{ code: "photo-unavailable", path: ["clips", 2] }] });
  });

  test("two clips made from one photo are one frame: the second is frame-repeated", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const m3 = copy("media-copy-0003", w.avatar.id, "clip-0000003", photoOf(w, 1));
    const { rig } = rigWith(w, [m1, m3]);

    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ copy: m1.mediaId }, { copy: m3.mediaId }]) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", detail: "frame-repeated", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
  });

  test("a clip whose photo is already in a video is PHOTO_UNAVAILABLE in-video, at the clip", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig } = rigWith(w, [m1]);
    await rig.service.render({ spec: specOf(w.avatar.id, [photoOf(w, 1)], SPEC_MS) });
    await rig.queue.idle();

    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "in-video", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
    expect(rig.queue.reservesMedia(m1.mediaId)).toBe(false);
  });

  test("a clip whose photo was rejected is PHOTO_UNAVAILABLE with no reason (as a rejected scene photo), at the clip", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig } = rigWith(w, [m1]);
    await w.library.setRejected(w.avatar.id, photoOf(w, 1), true);

    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) }));

    expect(error.code).toBe("PHOTO_UNAVAILABLE");
    expect(error.photoReason).toBeUndefined();
    expect(error.detail).toBeUndefined();
    expect(error.issues).toEqual([{ code: "photo-unavailable", path: ["clips", 1] }]);
  });

  test("a clip whose photo is not in the library any more is PHOTO_UNAVAILABLE, at the clip", async () => {
    const w = world();
    const gone = copy("media-copy-0002", w.avatar.id, "clip-0000002", "photo-not-in-library");
    const { rig } = rigWith(w, [gone]);

    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: gone.mediaId }]) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
  });

  test("a copy the library does not hold is still the montage's media-unavailable, before any frame is judged", async () => {
    const w = world();
    const { rig } = rigWith(w, []);
    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: "media-copy-0404" }]) }));
    expect(error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 1] }] });
  });
});

describe("two queued renders of one frame collide at the queue", () => {
  test("a photo held by a render, then a clip of it: held-by-render at the clip's path", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig, open } = rigWith(w, [m1], { gate: true, size: 2 });
    await rig.service.render({ spec: specOf(w.avatar.id, [photoOf(w, 1)], SPEC_MS) });

    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
    expect(rig.queue.reservesMedia(m1.mediaId)).toBe(false);
    open();
    await rig.queue.idle();
  });

  test("a clip held by a render, then the photo itself: held-by-render at the cell", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig, open } = rigWith(w, [m1], { gate: true, size: 2 });
    await rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) });

    const error = await failureOf(rig.service.render({ spec: specOf(w.avatar.id, [photoOf(w, 1)], SPEC_MS) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render" });
    open();
    await rig.queue.idle();
  });

  test("a clip of a photo another render holds through a sibling clip: held-by-render at the clip", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const m3 = copy("media-copy-0003", w.avatar.id, "clip-0000003", photoOf(w, 1));
    const { rig, open } = rigWith(w, [m1, m3], { gate: true, size: 2 });
    await rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) });

    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 2) }, { copy: m3.mediaId }]) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
    open();
    await rig.queue.idle();
  });

  test("the queue's own PHOTOS_RESERVED answer is mapped to the clip's path as well as the scene cells'", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    let submitted: readonly string[] = [];
    const real = serviceRig(w).queue;
    const queue: Pick<RenderQueue, "submit" | "cancel" | "states" | "idle" | "holdMedia"> = {
      submit: (submission) => {
        submitted = submission.photoIds;
        return { ok: false, code: "PHOTOS_RESERVED", photoIds: [photoOf(w, 1)] };
      },
      cancel: (id) => real.cancel(id),
      states: () => real.states(),
      idle: () => real.idle(),
      holdMedia: (mediaId) => real.holdMedia(mediaId),
    };
    const { rig } = rigWith(w, [m1], { deps: { queue } });

    const error = await failureOf(rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
    expect(submitted).toEqual([photoOf(w, 0), photoOf(w, 1)]);
  });
});

describe("the callers that keep the scene photos on purpose (§5.1.3)", () => {
  test("videos.list counts the photos shown: a clip's photo is not one of them", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig } = rigWith(w, [m1]);
    await rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) });
    await rig.queue.idle();

    const listed = await rig.service.listWithMarks(w.avatar.id);

    expect(listed.videos).toHaveLength(1);
    expect(listed.videos[0]?.photoCount).toBe(1);
  });

  test("the render reads the photo files of the scene cells only, never the clip's photo", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const read: string[] = [];
    const library = withOverrides(w.library, {
      readPhotoVerified: (photoId: string) => {
        read.push(photoId);
        return w.library.readPhotoVerified(photoId);
      },
    });
    const { rig } = rigWith(w, [m1], { deps: { openLibrary: () => library, withLibrary: (work) => work(library) } });

    await rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) });
    await rig.queue.idle();

    expect([...new Set(read)]).toEqual([photoOf(w, 0)]);
  });
});

describe("the free-space and staging sums keep the scene photos (plan §5.1.3, scenePhotoBytes)", () => {
  test("the staged bytes are the scene photo's stored size plus the copy's, never the clip's photo's", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const asked: number[] = [];
    const { rig } = rigWith(w, [m1], { deps: { renderOverrides: { runDeps: { stagingTimeoutMs: (bytes: number) => (asked.push(bytes), 60_000) } } } });
    const scene = w.library.getPhoto(photoOf(w, 0))?.bytes ?? 0;
    const clipsPhoto = w.library.getPhoto(photoOf(w, 1))?.bytes ?? 0;
    expect(scene).toBeGreaterThan(0);
    expect(clipsPhoto).toBeGreaterThan(0);

    await rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) });
    await rig.queue.idle();

    expect(asked).toEqual([scene + 3_000]);
  });
});

describe("a commit that fails after its intent: the frames stay held while the intent is settled", () => {
  test("the clip's photo is held with the scene photo", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig } = rigWith(w, [m1], {
      deps: {
        // The disk says nothing about the intent (EIO): the hold stays, as a hold on an intent that may still be adopted must.
        intentLstat: async () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
        renderOverrides: {
          hooks: {
            reached: (step) => {
              if (step === "intent-written") throw new Error("the disk failed after the intent");
            },
          },
        },
      },
    });

    await rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) });
    await rig.queue.idle();

    expect([...w.library.pendingVideoPhotos(w.avatar.id)].sort()).toEqual([photoOf(w, 0), photoOf(w, 1)].sort());
  });
});

describe("videos.delete with rejectPhotos", () => {
  test("rejects the clip's photo too: a photo and its clips are one frame", async () => {
    const w = world();
    const m1 = copy("media-copy-0001", w.avatar.id, "clip-0000001", photoOf(w, 1));
    const { rig } = rigWith(w, [m1]);
    const { videoId } = await rig.service.render({ spec: specOfParts(w, [{ scene: photoOf(w, 0) }, { copy: m1.mediaId }]) });
    await rig.queue.idle();

    const answer = await rig.service.delete(videoId, "video", { rejectPhotos: true });

    expect(answer.rejectedPhotoIds).toEqual([photoOf(w, 0), photoOf(w, 1)]);
    expect(stateOf(w, photoOf(w, 1))?.rejected).toBe(true);
    expect(stateOf(w, photoOf(w, 2))?.rejected).toBe(false);
  });

  test("a clip's photo that is gone from the library is skipped, not an error", async () => {
    const w = world();
    const gone = copy("media-copy-0002", w.avatar.id, "clip-0000002", "photo-not-in-library");
    // Written as a record straight to disk: the render would refuse this frame.
    const { rig } = rigWith(w, [gone]);
    const { videoId } = await rig.service.render({ spec: specOf(w.avatar.id, [photoOf(w, 0)], SPEC_MS) });
    await rig.queue.idle();
    const path = videoPaths(w.libraryRoot, w.avatar.id).record(videoId);
    const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...json, clipFrames: [{ mediaId: gone.mediaId, clipId: "clip-0000002", photoId: "photo-not-in-library" }] }));
    await w.library.reloadVideoRecords(w.avatar.id);

    const answer = await rig.service.delete(videoId, "video", { rejectPhotos: true });

    expect(answer.rejectedPhotoIds).toEqual([photoOf(w, 0)]);
  });
});

