import { describe, expect, test } from "bun:test";
import type { JobState, RenderResult } from "../../shared/engine";
import { FfmpegError, FfmpegTimeoutError } from "../../node/runFfmpeg";
import { JobRegistry } from "../jobs";
import { RenderGraphError } from "../render";
import { RenderFailure, RenderQueue, type RenderContext, type RenderQueueDeps, type RenderQueueEvent, type RenderSubmission } from "./queue";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The render queue: a pool of N over the job registry, FIFO, cancel for queued
// and running jobs, and the reserved photos of every queued and running spec.

const AVATAR = "avatar-00000001";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function resultOf(n: number, avatarId = AVATAR): RenderResult {
  return { kind: "render", videoId: `video-0000000${n}`, avatarId, bytes: 1000, durationMs: 4000, videoKind: "photo", relPath: "Mia/2026-09-29_photo_001.mp4" };
}

/** A job the test finishes by hand. */
class Gate {
  readonly started = deferred<RenderContext>();
  readonly finish = deferred<RenderResult>();
  execute = (ctx: RenderContext): Promise<RenderResult> => {
    this.started.resolve(ctx);
    return this.finish.promise;
  };
}

function submission(n: number, extra: Partial<RenderSubmission> & { photoIds?: readonly string[]; avatarId?: string } = {}): RenderSubmission & { gate: Gate } {
  const gate = new Gate();
  const avatarId = extra.avatarId ?? AVATAR;
  return {
    jobId: `job-0000000${n}`,
    ref: { videoId: `video-0000000${n}`, avatarId, montageId: null },
    totalFrames: 120,
    photoIds: extra.photoIds ?? [`photo-0000000${n}`],
    execute: extra.execute ?? gate.execute,
    gate,
    ...(extra.jobId === undefined ? {} : { jobId: extra.jobId }),
  };
}

function setup(over: Pick<RenderQueueDeps, "beforeRelease"> & { size?: number } = {}): { queue: RenderQueue; jobs: JobRegistry; events: RenderQueueEvent[] } {
  const jobs = new JobRegistry();
  const events: RenderQueueEvent[] = [];
  const queue = new RenderQueue({ jobs, size: () => over.size ?? 1, onEvent: (e) => events.push(e), ...(over.beforeRelease === undefined ? {} : { beforeRelease: over.beforeRelease }) });
  return { queue, jobs, events };
}

const statuses = (jobs: JobRegistry): string[] => jobs.states().map((s) => `${s.jobId}:${s.status}`);

describe("RenderQueue: the pool", () => {
  test("starts a submitted job at once when a slot is free", async () => {
    const { queue, jobs } = setup();
    const a = submission(1);

    expect(queue.submit(a)).toEqual({ ok: true });

    expect(statuses(jobs)).toEqual(["job-00000001:running"]);
    await a.gate.started.promise;
  });

  test("holds a job as queued while the pool is full, and lists it in the snapshot", () => {
    const { queue, jobs } = setup();
    queue.submit(submission(1));
    queue.submit(submission(2));

    expect(statuses(jobs)).toEqual(["job-00000001:running", "job-00000002:queued"]);
    expect(jobs.states()[1]).toMatchObject({ kind: "render", status: "queued", done: 0, total: 120 });
  });

  test("runs at most as many jobs at once as the pool's size, and starts the queued ones first in, first out", async () => {
    const { queue, jobs } = setup({ size: 2 });
    const [a, b, c, d] = [submission(1), submission(2), submission(3), submission(4)];
    for (const s of [a, b, c, d]) queue.submit(s);

    expect(statuses(jobs)).toEqual(["job-00000001:running", "job-00000002:running", "job-00000003:queued", "job-00000004:queued"]);

    b.gate.finish.resolve(resultOf(2));
    await tick();
    expect(statuses(jobs)).toEqual(["job-00000001:running", "job-00000002:done", "job-00000003:running", "job-00000004:queued"]);

    a.gate.finish.resolve(resultOf(1));
    await tick();
    expect(statuses(jobs)).toEqual(["job-00000001:done", "job-00000002:done", "job-00000003:running", "job-00000004:running"]);
  });

  test("reads the pool's size afresh, so a bigger pool takes the next job when one ends", async () => {
    let size = 1;
    const jobs = new JobRegistry();
    const queue = new RenderQueue({ jobs, size: () => size });
    const [a, b, c] = [submission(1), submission(2), submission(3)];
    for (const s of [a, b, c]) queue.submit(s);
    size = 2;

    a.gate.finish.resolve(resultOf(1));
    await tick();

    expect(statuses(jobs)).toEqual(["job-00000001:done", "job-00000002:running", "job-00000003:running"]);
  });

  test("never runs with a pool below one, however small the size it is told", async () => {
    const { queue, jobs } = setup({ size: 0 });
    queue.submit(submission(1));

    expect(statuses(jobs)).toEqual(["job-00000001:running"]);
  });

  test("refuses a job id it already knows, and leaves that job alone", () => {
    const { queue, jobs } = setup();
    queue.submit(submission(1));

    expect(() => queue.submit(submission(2, { jobId: "job-00000001" }))).toThrow("already registered");
    expect(statuses(jobs)).toEqual(["job-00000001:running"]);
    expect(queue.reservedPhotos(AVATAR)).toEqual(new Set(["photo-00000001"]));
  });

  test("idle resolves once every queued and running job has ended", async () => {
    const { queue } = setup();
    const [a, b] = [submission(1), submission(2)];
    queue.submit(a);
    queue.submit(b);
    let idle = false;
    void queue.idle().then(() => (idle = true));

    a.gate.finish.resolve(resultOf(1));
    await tick();
    expect(idle).toBe(false);

    b.gate.finish.resolve(resultOf(2));
    await tick();
    expect(idle).toBe(true);
  });

  test("idle resolves at once when nothing is queued", async () => {
    const { queue } = setup();

    await expect(queue.idle()).resolves.toBeUndefined();
  });
});

describe("RenderQueue: a job's life", () => {
  test("a finished job is done with every frame and carries its result, and the events say so in order", async () => {
    const { queue, jobs, events } = setup();
    const a = submission(1);
    queue.submit(a);
    const ctx = await a.gate.started.promise;
    ctx.progress(50);

    a.gate.finish.resolve(resultOf(1));
    await queue.idle();

    expect(jobs.states()).toEqual([{ kind: "render", jobId: "job-00000001", videoId: "video-00000001", avatarId: AVATAR, montageId: null, status: "done", done: 120, total: 120, result: resultOf(1) }]);
    expect(events.map((e) => e.type)).toEqual(["started", "progress", "ended"]);
    expect(events[1]).toMatchObject({ progress: { kind: "render", jobId: "job-00000001", done: 50, total: 120 } });
    expect(events[2]).toMatchObject({ state: { status: "done" } });
  });

  test("progress goes through the registry: clamped, and never backwards", async () => {
    const { queue } = setup();
    const a = submission(1);
    queue.submit(a);
    const ctx = await a.gate.started.promise;

    expect(ctx.progress(70)?.done).toBe(70);
    expect(ctx.progress(30)?.done).toBe(70);
    expect(ctx.progress(9999)?.done).toBe(120);
  });

  test("progress of a job that already ended reports nothing", async () => {
    const { queue } = setup();
    const a = submission(1);
    queue.submit(a);
    const ctx = await a.gate.started.promise;
    a.gate.finish.resolve(resultOf(1));
    await queue.idle();

    expect(ctx.progress(10)).toBeNull();
  });

  test("a job that fails ends failed, keeps its cause for the log, and the next job still runs", async () => {
    const { queue, jobs, events } = setup();
    const [a, b] = [submission(1), submission(2)];
    queue.submit(a);
    queue.submit(b);
    const cause = new FfmpegError("ffmpeg exited with code 1", 1, "Error: Cannot open input");

    a.gate.finish.reject(cause);
    await tick();

    expect(jobs.states()[0]).toMatchObject({ status: "failed", error: { code: "RENDER_FAILED" } });
    expect(events.find((e) => e.type === "ended")).toMatchObject({ cause });
    expect(jobs.states()[1]).toMatchObject({ status: "running" });
  });

  test("puts the ffmpeg exit code and only the end of its stderr into the error's detail", async () => {
    const { queue, jobs } = setup();
    const a = submission(1);
    queue.submit(a);

    a.gate.finish.reject(new FfmpegError("ffmpeg exited with code 234", 234, `${"noise ".repeat(400)}Error: Invalid argument`));
    await queue.idle();

    const error = jobs.states()[0]?.error;
    expect(error?.code).toBe("RENDER_FAILED");
    expect(error?.detail?.length).toBeLessThanOrEqual(500);
    expect(error?.detail).toContain("code 234");
    expect(error?.detail).toContain("Invalid argument");
  });

  test("a timeout ends the job as TIMEOUT", async () => {
    const { queue, jobs } = setup();
    const a = submission(1);
    queue.submit(a);

    a.gate.finish.reject(new FfmpegTimeoutError(90_000, "still encoding"));
    await queue.idle();

    expect(jobs.states()[0]).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
  });

  test("an error that carries its own EngineError keeps it", async () => {
    const { queue, jobs } = setup();
    const a = submission(1);
    queue.submit(a);

    a.gate.finish.reject(new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "missing" }));
    await queue.idle();

    expect(jobs.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });
  });

  test.each(["PHOTO_UNRESOLVED", "BAD_OVERLAY", "UNSAFE_GRAPH", "VIDEO_CLIP_UNSUPPORTED", "CELL_EMPTY"] as const)(
    "a graph the builder refused (%s) ends the job as RENDER_FAILED and names the builder's code",
    async (code) => {
      const { queue, jobs, events } = setup();
      const a = submission(1);
      queue.submit(a);
      const cause = new RenderGraphError(code, "the photo scene:photo-1 was not resolved");

      a.gate.finish.reject(cause);
      await queue.idle();

      const error = jobs.states()[0]?.error;
      expect(jobs.states()[0]).toMatchObject({ status: "failed", error: { code: "RENDER_FAILED" } });
      expect(error?.detail).toContain(code);
      expect(events.find((e) => e.type === "ended")).toMatchObject({ cause });
    },
  );

  test("any other error is INTERNAL", async () => {
    const { queue, jobs } = setup();
    const a = submission(1);
    queue.submit(a);

    a.gate.finish.reject(new TypeError("undefined is not a function"));
    await queue.idle();

    expect(jobs.states()[0]).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
  });

  test("a job whose execute throws before it returns a promise fails like any other, and the queue goes on", async () => {
    const { queue, jobs } = setup();
    const bad = submission(1, {
      execute: () => {
        throw new Error("boom");
      },
    });
    const b = submission(2);
    queue.submit(bad);
    queue.submit(b);
    await tick();

    expect(statuses(jobs)).toEqual(["job-00000001:failed", "job-00000002:running"]);
  });

  test("a listener that throws does not stop the queue, and its error is reported", async () => {
    const jobs = new JobRegistry();
    const reported: unknown[] = [];
    const queue = new RenderQueue({
      jobs,
      size: () => 1,
      onEvent: () => {
        throw new Error("window closed");
      },
      onListenerError: (error) => reported.push(error),
    });
    const [a, b] = [submission(1), submission(2)];
    queue.submit(a);
    queue.submit(b);

    a.gate.finish.resolve(resultOf(1));
    await tick();

    expect(statuses(jobs)).toEqual(["job-00000001:done", "job-00000002:running"]);
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0]).toMatchObject({ message: "window closed" });
  });
});

describe("RenderQueue: cancel", () => {
  test("a queued job is cancelled at once, never runs, and the running one is not disturbed", async () => {
    const { queue, jobs, events } = setup();
    const [a, b] = [submission(1), submission(2)];
    queue.submit(a);
    let ran = false;
    queue.submit({ ...b, execute: () => ((ran = true), b.gate.finish.promise) });

    expect(queue.cancel("job-00000002")).toBe(true);

    expect(statuses(jobs)).toEqual(["job-00000001:running", "job-00000002:cancelled"]);
    expect(events.filter((e) => e.type === "ended").map((e) => e.state.jobId)).toEqual(["job-00000002"]);
    a.gate.finish.resolve(resultOf(1));
    await queue.idle();
    expect(ran).toBe(false);
  });

  test("cancelling the head of the line lets the next queued job start when its turn comes", async () => {
    const { queue, jobs } = setup();
    const [a, b, c] = [submission(1), submission(2), submission(3)];
    for (const s of [a, b, c]) queue.submit(s);
    queue.cancel("job-00000002");

    a.gate.finish.resolve(resultOf(1));
    await tick();

    expect(statuses(jobs)).toEqual(["job-00000001:done", "job-00000002:cancelled", "job-00000003:running"]);
  });

  test("a running job gets its signal aborted and ends cancelled when its work stops", async () => {
    const { queue, jobs } = setup();
    const a = submission(1);
    queue.submit(a);
    const ctx = await a.gate.started.promise;

    expect(queue.cancel("job-00000001")).toBe(true);

    expect(ctx.signal.aborted).toBe(true);
    expect(jobs.states()[0]).toMatchObject({ status: "running" }); // its owner ends it once ffmpeg is gone
    a.gate.finish.reject(ctx.signal.reason);
    await queue.idle();
    expect(jobs.states()[0]).toMatchObject({ status: "cancelled" });
  });

  test("a running job that stops with some other error after a cancel is still cancelled", async () => {
    const { queue, jobs } = setup();
    const a = submission(1);
    queue.submit(a);
    await a.gate.started.promise;
    queue.cancel("job-00000001");

    a.gate.finish.reject(new FfmpegError("ffmpeg exited with signal SIGKILL", null, ""));
    await queue.idle();

    expect(jobs.states()[0]).toMatchObject({ status: "cancelled" });
  });

  test("the next job starts only once a cancelled running job has really stopped", async () => {
    const { queue, jobs } = setup();
    const [a, b] = [submission(1), submission(2)];
    queue.submit(a);
    queue.submit(b);
    const ctx = await a.gate.started.promise;

    queue.cancel("job-00000001");
    await tick();
    expect(statuses(jobs)).toEqual(["job-00000001:running", "job-00000002:queued"]);

    a.gate.finish.reject(ctx.signal.reason);
    await tick();
    expect(statuses(jobs)).toEqual(["job-00000001:cancelled", "job-00000002:running"]);
  });

  test("a cancel that races the job's completion leaves it done, once", async () => {
    const { queue, jobs, events } = setup();
    const a = submission(1);
    queue.submit(a);
    await a.gate.started.promise;

    a.gate.finish.resolve(resultOf(1));
    expect(queue.cancel("job-00000001")).toBe(true); // before the queue has seen the result
    await queue.idle();

    expect(jobs.states()[0]).toMatchObject({ status: "done", result: resultOf(1) });
    expect(events.filter((e) => e.type === "ended")).toHaveLength(1);
    expect(queue.reservedPhotos(AVATAR).size).toBe(0);
  });

  test("a cancel that arrives after the job ended is true and changes nothing", async () => {
    const { queue, jobs, events } = setup();
    const a = submission(1);
    queue.submit(a);
    a.gate.finish.resolve(resultOf(1));
    await queue.idle();
    const before = events.length;

    expect(queue.cancel("job-00000001")).toBe(true);

    expect(jobs.states()[0]).toMatchObject({ status: "done" });
    expect(events).toHaveLength(before);
  });

  test("cancelling an unknown job is false", () => {
    const { queue } = setup();

    expect(queue.cancel("job-00000404")).toBe(false);
  });

  test("cancelling the same queued job twice ends it once", () => {
    const { queue, events } = setup();
    queue.submit(submission(1));
    queue.submit(submission(2));

    queue.cancel("job-00000002");
    queue.cancel("job-00000002");

    expect(events.filter((e) => e.type === "ended")).toHaveLength(1);
  });
});

describe("RenderQueue: renders in flight", () => {
  test("counts queued and running jobs, not finished ones", async () => {
    const { queue } = setup();
    const [a, b] = [submission(1), submission(2)];
    queue.submit(a);
    queue.submit(b);
    expect(queue.active()).toBe(2);

    queue.cancel("job-00000002");
    expect(queue.active()).toBe(1);

    a.gate.finish.resolve(resultOf(1));
    await queue.idle();
    expect(queue.active()).toBe(0);
  });
});
