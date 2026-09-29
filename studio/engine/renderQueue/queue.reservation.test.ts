import { describe, expect, test } from "bun:test";
import type { RenderResult } from "../../shared/engine";
import { JobRegistry } from "../jobs";
import { openLibrary } from "../library";
import { PNG_1X1, SAMPLE_AVATAR, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { RenderQueue, type RenderContext, type RenderSubmission } from "./queue";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The reserved set (invariant 24, backlog 4): photos named by a queued OR a
// running render spec are held by the queue until the job ends and, for a
// finished one, until its record is in the used index.

const AVATAR = "avatar-00000001";
const OTHER_AVATAR = "avatar-00000002";
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function resultOf(n: number, avatarId = AVATAR): RenderResult {
  return { kind: "render", videoId: `video-0000000${n}`, avatarId, bytes: 1000, durationMs: 4000, videoKind: "photo", relPath: "Mia/2026-09-29_photo_001.mp4" };
}

interface Manual extends RenderSubmission {
  finish(result: RenderResult): void;
  fail(error: unknown): void;
  readonly context: () => RenderContext;
}

function spec(n: number, photoIds: readonly string[], avatarId = AVATAR): Manual {
  let resolve: (r: RenderResult) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  let ctx: RenderContext | undefined;
  const promise = new Promise<RenderResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    jobId: `job-0000000${n}`,
    ref: { videoId: `video-0000000${n}`, avatarId, montageId: null },
    totalFrames: 120,
    photoIds,
    execute: (c) => {
      ctx = c;
      return promise;
    },
    finish: resolve,
    fail: reject,
    context: () => {
      if (ctx === undefined) throw new Error("not started");
      return ctx;
    },
  };
}

function newQueue(beforeRelease?: ConstructorParameters<typeof RenderQueue>[0]["beforeRelease"]): RenderQueue {
  return new RenderQueue({ jobs: new JobRegistry(), size: () => 1, ...(beforeRelease === undefined ? {} : { beforeRelease }) });
}

describe("RenderQueue: the reserved set", () => {
  test("holds the photos of queued and running specs, by avatar", () => {
    const queue = newQueue();
    queue.submit(spec(1, ["p1", "p2"])); // running
    queue.submit(spec(2, ["p3"])); // queued
    queue.submit(spec(3, ["p9"], OTHER_AVATAR));

    expect(queue.reservedPhotos(AVATAR)).toEqual(new Set(["p1", "p2", "p3"]));
    expect(queue.reservedPhotos(OTHER_AVATAR)).toEqual(new Set(["p9"]));
    expect(queue.reservedPhotos("avatar-00000404").size).toBe(0);
  });

  test("refuses a second spec that names a photo a queued spec already holds, and holds nothing of it", () => {
    const queue = newQueue();
    queue.submit(spec(1, ["p1"])); // running
    queue.submit(spec(2, ["p2", "p3"])); // queued

    const refused = queue.submit(spec(3, ["p3", "p4", "p1"]));

    expect(refused).toEqual({ ok: false, code: "PHOTOS_RESERVED", photoIds: ["p3", "p1"] });
    expect(queue.reservedPhotos(AVATAR)).toEqual(new Set(["p1", "p2", "p3"]));
    expect(queue.active()).toBe(2);
  });

  test("lets the same photo id be used by another avatar's spec", () => {
    const queue = newQueue();
    queue.submit(spec(1, ["p1"]));

    expect(queue.submit(spec(2, ["p1"], OTHER_AVATAR))).toEqual({ ok: true });
  });

  test("a spec that names a photo twice holds it once and is not refused for it", () => {
    const queue = newQueue();

    expect(queue.submit(spec(1, ["p1", "p1"]))).toEqual({ ok: true });
    expect(queue.reservedPhotos(AVATAR)).toEqual(new Set(["p1"]));
  });

  test("gives the photos back when a queued spec is cancelled", () => {
    const queue = newQueue();
    queue.submit(spec(1, ["p1"]));
    queue.submit(spec(2, ["p2"]));

    queue.cancel("job-00000002");

    expect(queue.reservedPhotos(AVATAR)).toEqual(new Set(["p1"]));
    expect(queue.submit(spec(3, ["p2"]))).toEqual({ ok: true });
  });

  test("gives the photos back when a running spec is cancelled, once its work has stopped, and not before", async () => {
    const queue = newQueue();
    const a = spec(1, ["p1"]);
    queue.submit(a);

    queue.cancel("job-00000001");
    expect(queue.reservedPhotos(AVATAR)).toEqual(new Set(["p1"])); // ffmpeg may still be writing

    a.fail(a.context().signal.reason);
    await queue.idle();
    expect(queue.reservedPhotos(AVATAR).size).toBe(0);
  });

  test("gives the photos back when a spec fails", async () => {
    const queue = newQueue();
    const a = spec(1, ["p1"]);
    queue.submit(a);

    a.fail(new Error("ffmpeg exited"));
    await queue.idle();

    expect(queue.reservedPhotos(AVATAR).size).toBe(0);
  });

  test("gives the photos back when a spec finishes", async () => {
    const queue = newQueue();
    const a = spec(1, ["p1"]);
    queue.submit(a);

    a.finish(resultOf(1));
    await queue.idle();

    expect(queue.reservedPhotos(AVATAR).size).toBe(0);
  });

  test("asked afresh: the set it returns is a copy that later changes do not touch", () => {
    const queue = newQueue();
    queue.submit(spec(1, ["p1"]));
    const before = queue.reservedPhotos(AVATAR);

    queue.submit(spec(2, ["p2"]));

    expect(before).toEqual(new Set(["p1"]));
  });
});

describe("RenderQueue: the release point (moved by 3a.8b)", () => {
  test("keeps the photos reserved, and the job unfinished, until beforeRelease has finished", async () => {
    let release: () => void = () => {};
    const seen: Array<{ reserved: string[]; status: string }> = [];
    const jobs = new JobRegistry();
    const queue: RenderQueue = new RenderQueue({
      jobs,
      size: () => 1,
      beforeRelease: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const a = spec(1, ["p1"]);
    queue.submit(a);
    a.finish(resultOf(1));
    await tick();

    seen.push({ reserved: [...queue.reservedPhotos(AVATAR)], status: jobs.states()[0]?.status ?? "" });
    release();
    await queue.idle();
    seen.push({ reserved: [...queue.reservedPhotos(AVATAR)], status: jobs.states()[0]?.status ?? "" });

    expect(seen).toEqual([
      { reserved: ["p1"], status: "running" },
      { reserved: [], status: "done" },
    ]);
  });

  test("hands beforeRelease the job, its photos and its result", async () => {
    const calls: unknown[] = [];
    const queue = newQueue((info) => {
      calls.push(info);
    });
    const a = spec(1, ["p1", "p2"]);
    queue.submit(a);

    a.finish(resultOf(1));
    await queue.idle();

    expect(calls).toEqual([{ jobId: "job-00000001", ref: a.ref, photoIds: ["p1", "p2"], result: resultOf(1) }]);
  });

  test("a beforeRelease that throws fails the job, and the photos are still released", async () => {
    const jobs = new JobRegistry();
    const queue = new RenderQueue({
      jobs,
      size: () => 1,
      beforeRelease: () => Promise.reject(new Error("the index refused the record")),
    });
    const a = spec(1, ["p1"]);
    queue.submit(a);

    a.finish(resultOf(1));
    await queue.idle();

    expect(jobs.states()[0]).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(queue.reservedPhotos(AVATAR).size).toBe(0);
  });

  test("beforeRelease is not called for a failed or a cancelled job: no record, nothing to index", async () => {
    let calls = 0;
    const queue = newQueue(() => {
      calls++;
    });
    const [a, b] = [spec(1, ["p1"]), spec(2, ["p2"])];
    queue.submit(a);
    queue.submit(b);

    queue.cancel("job-00000002");
    a.fail(new Error("boom"));
    await queue.idle();

    expect(calls).toBe(0);
  });
});

describe("RenderQueue as the library's reserved-photos provider (invariant 24, backlog 4)", () => {
  const root = useTempDir("studio-queue-");

  async function libraryWithPhotos(queueRef: { current: RenderQueue | undefined }) {
    const { library } = await openLibrary(root(), {
      now: steppingClock(),
      newId: sequentialIds(),
      reservedPhotos: (avatarId) => queueRef.current?.reservedPhotos(avatarId) ?? new Set<string>(),
    });
    const avatar = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Mia" });
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    const photos = [];
    for (const category of ["home", "travel", "fitness", "food"]) {
      photos.push(await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category } })));
    }
    return { library, avatar, photos };
  }

  const freeIds = (library: Awaited<ReturnType<typeof libraryWithPhotos>>["library"], avatarId: string): string[] => library.eligibleUnusedPhotos(avatarId).map((p) => p.id);

  test("two queued specs cannot take the same photo: the second spec's pick never offers it, and a direct submit is refused", async () => {
    const ref: { current: RenderQueue | undefined } = { current: undefined };
    const { library, avatar, photos } = await libraryWithPhotos(ref);
    const queue = newQueue();
    ref.current = queue;
    const [p1, p2, p3, p4] = photos.map((p) => p.id);
    if (p1 === undefined || p2 === undefined || p3 === undefined || p4 === undefined) throw new Error("fixture");

    queue.submit(spec(1, [p1, p2], avatar.id)); // running: holds the pool
    queue.submit(spec(2, [p3], avatar.id)); // queued

    expect(freeIds(library, avatar.id)).toEqual([p4]);
    expect(library.photoStates(avatar.id).get(p3)).toMatchObject({ reserved: true, eligible: true });
    expect(queue.submit(spec(3, [p3, p4], avatar.id))).toEqual({ ok: false, code: "PHOTOS_RESERVED", photoIds: [p3] });
    expect(queue.submit(spec(4, [p4], avatar.id))).toEqual({ ok: true });
    expect(freeIds(library, avatar.id)).toEqual([]);
  });

  test("a cancelled job releases its photos: they are offered again", async () => {
    const ref: { current: RenderQueue | undefined } = { current: undefined };
    const { library, avatar, photos } = await libraryWithPhotos(ref);
    const queue = newQueue();
    ref.current = queue;
    const ids = photos.map((p) => p.id);
    queue.submit(spec(1, [ids[0] ?? ""], avatar.id));
    queue.submit(spec(2, [ids[1] ?? ""], avatar.id));
    expect(freeIds(library, avatar.id)).toEqual([ids[2] ?? "", ids[3] ?? ""]);

    queue.cancel("job-00000002");

    expect(freeIds(library, avatar.id)).toEqual([ids[1] ?? "", ids[2] ?? "", ids[3] ?? ""]);
  });

  test("a finished job holds its photos until its record is in the index, so they are never neither reserved nor used", async () => {
    const ref: { current: RenderQueue | undefined } = { current: undefined };
    const { library, avatar, photos } = await libraryWithPhotos(ref);
    const id = photos[0]?.id ?? "";
    const states: Array<{ reserved: boolean; used: boolean; free: boolean }> = [];
    const probe = (): void => {
      const s = library.photoStates(avatar.id).get(id);
      states.push({ reserved: s?.reserved ?? false, used: (s?.usedIn.length ?? 0) > 0, free: freeIds(library, avatar.id).includes(id) });
    };
    const queue = newQueue(async (info) => {
      probe(); // the hook runs with the photo still reserved
      library.addVideoRecordToIndex(info.ref.avatarId, { videoId: info.ref.videoId, photoIds: [...info.photoIds] });
      probe(); // and the record is in the index before the reservation ends
    });
    ref.current = queue;
    const a = spec(1, [id], avatar.id);
    queue.submit(a);
    probe();

    a.finish(resultOf(1, avatar.id));
    await queue.idle();
    probe();

    expect(states).toEqual([
      { reserved: true, used: false, free: false }, // running
      { reserved: true, used: false, free: false }, // in the hook, before the record
      { reserved: true, used: true, free: false }, // record indexed, still reserved
      { reserved: false, used: true, free: false }, // released: used, never free
    ]);
  });

  test("a failed job releases its photos and they are free again", async () => {
    const ref: { current: RenderQueue | undefined } = { current: undefined };
    const { library, avatar, photos } = await libraryWithPhotos(ref);
    const queue = newQueue();
    ref.current = queue;
    const id = photos[0]?.id ?? "";
    const a = spec(1, [id], avatar.id);
    queue.submit(a);
    expect(freeIds(library, avatar.id)).not.toContain(id);

    a.fail(new Error("ffmpeg exited"));
    await queue.idle();

    expect(freeIds(library, avatar.id)).toContain(id);
  });
});
