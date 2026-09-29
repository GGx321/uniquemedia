import { describe, expect, test } from "bun:test";
import { JobState, type RenderResult } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The render jobs of JobRegistry (task 3a.6): queued, then running, then done,
// failed or cancelled; `done` and `total` count frames of the FINAL video.

const REF = { videoId: "video-00000001", avatarId: "avatar-00000001", montageId: "draft-00000001" } as const;
const RESULT: RenderResult = { kind: "render", videoId: REF.videoId, avatarId: REF.avatarId, bytes: 1234, durationMs: 4000, videoKind: "photo", relPath: "Mia/2026-09-29_photo_001.mp4" };

function valid(states: unknown[]): void {
  for (const state of states) expect(JobState.safeParse(state).success).toBe(true);
}

describe("JobRegistry, render jobs", () => {
  test("a queued render is listed as queued, nothing done, with its total from the moment it is queued", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);

    expect(jobs.states()).toEqual([{ kind: "render", jobId: "job-00000001", ...REF, status: "queued", done: 0, total: 120 }]);
    valid(jobs.states());
  });

  test("starting a queued render makes it running, and only a queued one", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);

    expect(jobs.startRender("job-00000001")).toBe(true);
    expect(jobs.states()).toMatchObject([{ status: "running", done: 0, total: 120 }]);
    expect(jobs.startRender("job-00000001")).toBe(false);
    expect(jobs.startRender("job-00000404")).toBe(false);
  });

  test("progress of a running render gives the event's payload with the video, avatar and draft", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);
    jobs.startRender("job-00000001");

    expect(jobs.progress("job-00000001", 30)).toEqual({ kind: "render", jobId: "job-00000001", ...REF, done: 30, total: 120 });
  });

  test("a queued render has no progress", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);

    expect(jobs.progress("job-00000001", 30)).toBeNull();
    expect(jobs.states()).toMatchObject([{ status: "queued", done: 0 }]);
  });

  test("done never goes back and never exceeds total", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);
    jobs.startRender("job-00000001");

    jobs.progress("job-00000001", 50);
    expect(jobs.progress("job-00000001", 20)).toMatchObject({ done: 50 });
    expect(jobs.progress("job-00000001", 500)).toMatchObject({ done: 120, total: 120 });
    expect(jobs.progress("job-00000001", -4)).toMatchObject({ done: 120 });
    valid(jobs.states());
  });

  test("a finished render is done with all its frames and carries its result", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);
    jobs.startRender("job-00000001");
    jobs.progress("job-00000001", 90);

    const state = jobs.finishRender("job-00000001", { status: "done", result: RESULT });

    expect(state).toEqual({ kind: "render", jobId: "job-00000001", ...REF, status: "done", done: 120, total: 120, result: RESULT });
    valid(jobs.states());
  });

  test("a failed render carries its error and keeps the frames it reached", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);
    jobs.startRender("job-00000001");
    jobs.progress("job-00000001", 40);

    const state = jobs.finishRender("job-00000001", { status: "failed", error: { code: "RENDER_FAILED", detail: "ffmpeg exited with code 1" } });

    expect(state).toEqual({ kind: "render", jobId: "job-00000001", ...REF, status: "failed", done: 40, total: 120, error: { code: "RENDER_FAILED", detail: "ffmpeg exited with code 1" } });
    valid(jobs.states());
  });

  test("a render can end without ever starting: a queued one that fails is failed at 0", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);

    jobs.finishRender("job-00000001", { status: "failed", error: { code: "EXPORT_UNAVAILABLE" } });

    expect(jobs.states()).toMatchObject([{ status: "failed", done: 0 }]);
  });

  test("a render that ended stays as it ended: a second finish, a start and progress change nothing", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);
    jobs.startRender("job-00000001");
    jobs.finishRender("job-00000001", { status: "done", result: RESULT });

    expect(jobs.finishRender("job-00000001", { status: "cancelled" })).toBeNull();
    expect(jobs.startRender("job-00000001")).toBe(false);
    expect(jobs.progress("job-00000001", 5)).toBeNull();
    expect(jobs.states()).toMatchObject([{ status: "done", done: 120 }]);
  });

  test("a job is finished as a render only if it is one", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", "draft-00000001", 4);

    expect(jobs.finishRender("job-00000001", { status: "cancelled" })).toBeNull();
    expect(jobs.states().map((j) => j.status)).toEqual(["running"]);
  });

  test("a render's id is never registered twice", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);

    expect(() => jobs.queueRender("job-00000001", REF, 120)).toThrow("already registered");
  });
});

describe("JobRegistry, cancelling renders", () => {
  test("cancelling a queued render ends it as cancelled at once and fires its signal", () => {
    const jobs = new JobRegistry();
    const signal = jobs.queueRender("job-00000001", REF, 120);

    expect(jobs.cancel("job-00000001")).toBe(true);

    expect(signal.aborted).toBe(true);
    expect(jobs.states()).toEqual([{ kind: "render", jobId: "job-00000001", ...REF, status: "cancelled", done: 0, total: 120 }]);
    valid(jobs.states());
  });

  test("a cancelled queued render cannot be started", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);
    jobs.cancel("job-00000001");

    expect(jobs.startRender("job-00000001")).toBe(false);
  });

  test("cancelling a running render fires its signal and leaves the ending to its owner", () => {
    const jobs = new JobRegistry();
    const signal = jobs.queueRender("job-00000001", REF, 120);
    jobs.startRender("job-00000001");

    expect(jobs.cancel("job-00000001")).toBe(true);

    expect(signal.aborted).toBe(true);
    expect(jobs.states()).toMatchObject([{ status: "running" }]);
    expect(jobs.finishRender("job-00000001", { status: "cancelled" })).toMatchObject({ status: "cancelled" });
  });

  test("cancelling a render that ended is true and changes nothing", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", REF, 120);
    jobs.startRender("job-00000001");
    jobs.finishRender("job-00000001", { status: "done", result: RESULT });

    expect(jobs.cancel("job-00000001")).toBe(true);
    expect(jobs.states()).toMatchObject([{ status: "done" }]);
  });
});

describe("JobRegistry, renders in flight", () => {
  test("queued and running renders count, finished ones do not", () => {
    const jobs = new JobRegistry();
    expect(jobs.activeRenders()).toBe(0);

    jobs.queueRender("job-00000001", REF, 120);
    jobs.queueRender("job-00000002", { ...REF, videoId: "video-00000002" }, 90);
    expect(jobs.activeRenders()).toBe(2);

    jobs.startRender("job-00000001");
    expect(jobs.activeRenders()).toBe(2);

    jobs.finishRender("job-00000001", { status: "cancelled" });
    expect(jobs.activeRenders()).toBe(1);

    jobs.cancel("job-00000002");
    expect(jobs.activeRenders()).toBe(0);
  });

  test("other jobs do not count as renders", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", "draft-00000001", 4);

    expect(jobs.activeRenders()).toBe(0);
  });

  test("keeps every queued and running render whatever the limit on finished ones", () => {
    const jobs = new JobRegistry({ keepFinished: 1 });
    jobs.queueRender("job-00000001", REF, 120);
    jobs.queueRender("job-00000002", { ...REF, videoId: "video-00000002" }, 120);
    jobs.startRender("job-00000002");
    for (let i = 3; i <= 6; i++) {
      jobs.queueRender(`job-0000000${i}`, { ...REF, videoId: `video-0000000${i}` }, 120);
      jobs.finishRender(`job-0000000${i}`, { status: "cancelled" });
    }

    expect(jobs.states().map((j) => `${j.jobId}:${j.status}`)).toEqual(["job-00000001:queued", "job-00000002:running", "job-00000006:cancelled"]);
  });
});
