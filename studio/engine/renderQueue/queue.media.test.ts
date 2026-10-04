import { describe, expect, test } from "bun:test";
import type { RenderResult } from "../../shared/engine";
import { JobRegistry } from "../jobs";
import { RenderQueue, type RenderContext, type RenderSubmission } from "./queue";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The reserved OWN media (3f.2; the 3f.1b review M-3): the media ids a queued OR a running render names are held by the queue until the job
// ends, and `media.delete` asks it (`EngineDeps.reservedMedia`). Unlike a scene photo, an own media may be named by many renders at once: it is
// held against its DELETION, not against another render.

const AVATAR = "avatar-00000001";

function resultOf(n: number): RenderResult {
  return { kind: "render", videoId: `video-0000000${n}`, avatarId: AVATAR, bytes: 1000, durationMs: 4000, videoKind: "photo", relPath: "Mia/2026-09-29_photo_001.mp4" };
}

interface Manual extends RenderSubmission {
  finish(result: RenderResult): void;
  fail(error: unknown): void;
  readonly context: () => RenderContext;
}

function spec(n: number, photoIds: readonly string[], mediaIds: readonly string[]): Manual {
  let resolve: (r: RenderResult) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  let ctx: RenderContext | undefined;
  const promise = new Promise<RenderResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    jobId: `job-0000000${n}`,
    ref: { videoId: `video-0000000${n}`, avatarId: AVATAR, montageId: null },
    totalFrames: 120,
    photoIds,
    mediaIds,
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

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const newQueue = (size = 1): RenderQueue => new RenderQueue({ jobs: new JobRegistry(), size: () => size });

describe("RenderQueue: the reserved own media", () => {
  test("holds the media of a RUNNING render", () => {
    const queue = newQueue();
    queue.submit(spec(1, [], ["media-0000001"]));
    expect(queue.reservesMedia("media-0000001")).toBe(true);
  });

  test("holds the media of a QUEUED render, behind a running one", () => {
    const queue = newQueue();
    queue.submit(spec(1, [], []));
    queue.submit(spec(2, [], ["media-0000002"]));
    expect(queue.states().map((s) => s.status)).toEqual(["running", "queued"]);
    expect(queue.reservesMedia("media-0000002")).toBe(true);
  });

  test("holds only the media the renders name", () => {
    const queue = newQueue();
    queue.submit(spec(1, [], ["media-0000001"]));
    expect(queue.reservesMedia("media-0000002")).toBe(false);
    expect(queue.reservesMedia("")).toBe(false);
  });

  test("a render with no own media holds none", () => {
    const queue = newQueue();
    queue.submit(spec(1, ["p1"], []));
    expect(queue.reservesMedia("p1")).toBe(false);
  });

  test("lets two renders name the same media: it is held against its deletion, not against another render", () => {
    const queue = newQueue();
    expect(queue.submit(spec(1, [], ["media-0000001"]))).toEqual({ ok: true });
    expect(queue.submit(spec(2, [], ["media-0000001"]))).toEqual({ ok: true });
    expect(queue.reservesMedia("media-0000001")).toBe(true);
  });

  test("keeps the media held until the LAST render that names it ends", async () => {
    const queue = newQueue(2);
    const a = spec(1, [], ["media-0000001"]);
    const b = spec(2, [], ["media-0000001"]);
    queue.submit(a);
    queue.submit(b);
    a.finish(resultOf(1));
    await tick();
    expect(queue.reservesMedia("media-0000001")).toBe(true);
    b.finish(resultOf(2));
    await tick();
    expect(queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("lets the media go when the render finishes", async () => {
    const queue = newQueue();
    const a = spec(1, [], ["media-0000001"]);
    queue.submit(a);
    a.finish(resultOf(1));
    await queue.idle();
    expect(queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("lets the media go when the render fails", async () => {
    const queue = newQueue();
    const a = spec(1, [], ["media-0000001"]);
    queue.submit(a);
    a.fail(new Error("ffmpeg failed"));
    await queue.idle();
    expect(queue.states()[0]?.status).toBe("failed");
    expect(queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("lets the media go when a QUEUED render is cancelled, at once", () => {
    const queue = newQueue();
    queue.submit(spec(1, [], []));
    queue.submit(spec(2, [], ["media-0000002"]));
    expect(queue.cancel("job-00000002")).toBe(true);
    expect(queue.reservesMedia("media-0000002")).toBe(false);
  });

  test("keeps the media held while a cancelled RUNNING render is still stopping, and lets it go once it has", async () => {
    const queue = newQueue();
    const a = spec(1, [], ["media-0000001"]);
    queue.submit(a);
    queue.cancel("job-00000001");
    expect(queue.reservesMedia("media-0000001")).toBe(true);
    a.fail(a.context().signal.reason);
    await queue.idle();
    expect(queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("a refused submit holds nothing of its media", () => {
    const queue = newQueue();
    queue.submit(spec(1, ["p1"], ["media-0000001"]));
    const refused = queue.submit(spec(2, ["p1"], ["media-0000009"]));
    expect(refused).toMatchObject({ ok: false, code: "PHOTOS_RESERVED" });
    expect(queue.reservesMedia("media-0000009")).toBe(false);
  });

  test("a submit refused because the queue is full holds nothing of its media", () => {
    const queue = newQueue();
    for (let n = 1; n <= 20; n++) queue.submit({ ...spec(n, [], []), jobId: `job-${String(n).padStart(8, "0")}`, ref: { videoId: `video-${String(n).padStart(8, "0")}`, avatarId: AVATAR, montageId: null } });
    const refused = queue.submit({ ...spec(21, [], ["media-0000009"]), jobId: "job-00000021", ref: { videoId: "video-00000021", avatarId: AVATAR, montageId: null } });
    expect(refused).toMatchObject({ ok: false, code: "QUEUE_FULL" });
    expect(queue.reservesMedia("media-0000009")).toBe(false);
  });
});

describe("RenderQueue: the admission's hold on an own media", () => {
  test("a hold keeps the media reserved before any render names it, and its release lets it go", () => {
    const queue = newQueue();
    const release = queue.holdMedia("media-0000001");
    expect(queue.reservesMedia("media-0000001")).toBe(true);
    release();
    expect(queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("releasing twice releases nothing of another hold of the same media", () => {
    const queue = newQueue();
    const first = queue.holdMedia("media-0000001");
    queue.holdMedia("media-0000001");
    first();
    first();
    expect(queue.reservesMedia("media-0000001")).toBe(true);
  });

  test("a hold and a render of the same media are independent: the media stays held until both let go", async () => {
    const queue = newQueue();
    const release = queue.holdMedia("media-0000001");
    const a = spec(1, [], ["media-0000001"]);
    queue.submit(a);
    release();
    expect(queue.reservesMedia("media-0000001")).toBe(true);
    a.finish(resultOf(1));
    await queue.idle();
    expect(queue.reservesMedia("media-0000001")).toBe(false);
  });

  test("holds only the media it was given", () => {
    const queue = newQueue();
    queue.holdMedia("media-0000001");
    expect(queue.reservesMedia("media-0000002")).toBe(false);
  });
});
