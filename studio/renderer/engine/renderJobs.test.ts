import { describe, expect, test } from "bun:test";
import { NO_ANSWER_DETAIL_PREFIX, RENDER_NOT_QUEUED_DETAIL, renderQueueFullDetail, type EngineError, type VideoSummary } from "../../shared/engine";
import type { RenderBlock } from "../screens/montage/renderBlock";
import type { EngineReply } from "./client";
import {
  applyVideoChanged,
  canCancel,
  classifyAnswer,
  dismissNotice,
  foundAfterSubmit,
  latestRenderOf,
  nextRenderBatch,
  NO_NOTICES,
  percentOf,
  renderControl,
  renderPhase,
  rendersAhead,
  SAVING_STALL_MS,
  savingStalled,
  sidebarCounts,
  trackNotices,
  type RenderControlInput,
  type RenderNoticeState,
} from "./renderJobs";
import type { JobView } from "./store";

// 3d.6: the render job model is pure logic. These tests are the contract of the editor's button, the drafts screen's
// «Рендер 42 %», the sidebar's «Рендер a / b» and the notices: none of them needs a screen.

const MONTAGE = "montage-0000001";

function render(id: number, patch: Partial<JobView> = {}): JobView {
  const n = String(id).padStart(8, "0");
  return { jobId: `job-${n}`, kind: "render", avatarId: "avatar-mia-0001", runId: null, montageId: MONTAGE, videoId: `video-${n}`, status: "running", saving: false, done: 0, total: 240, result: null, error: null, ...patch };
}

function run(id: number, patch: Partial<JobView> = {}): JobView {
  const n = String(id).padStart(8, "0");
  return { jobId: `job-${n}`, kind: "run", avatarId: "avatar-mia-0001", runId: `run-${n}`, montageId: null, videoId: null, status: "running", saving: false, done: 0, total: 20, result: null, error: null, ...patch };
}

function candidates(id: number, patch: Partial<JobView> = {}): JobView {
  const n = String(id).padStart(8, "0");
  return { jobId: `job-${n}`, kind: "avatar.candidates", avatarId: "avatar-mia-0001", runId: null, montageId: null, videoId: null, status: "running", saving: false, done: 0, total: 0, result: null, error: null, ...patch };
}

function video(id: number, patch: Partial<VideoSummary> = {}): VideoSummary {
  return {
    videoId: `video-${String(id).padStart(8, "0")}`,
    avatarId: "avatar-mia-0001",
    kind: "photo",
    durationMs: 8_000,
    bytes: 3_100_000,
    createdAt: "2026-10-03T10:00:00.000Z",
    relPath: "Mia/2026-10-03_photo_001.mp4",
    fileState: "present",
    montageId: MONTAGE,
    photoCount: 1,
    music: null,
    hasPoster: false,
    ...patch,
  };
}

const ids = (jobs: readonly JobView[]): string[] => jobs.map((j) => j.jobId);

describe("percentOf: floor(done / total × 100) of frames", () => {
  test("the boundaries: zero, full, and no total at all", () => {
    expect(percentOf(0, 240)).toBe(0);
    expect(percentOf(240, 240)).toBe(100);
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(5, 0)).toBe(0);
  });

  test("floors, never rounds up: 99.9 % is still 99", () => {
    expect(percentOf(119, 120)).toBe(99);
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(66);
    expect(percentOf(239, 240)).toBe(99);
  });

  test("never leaves 0..100, whatever a stray event says", () => {
    expect(percentOf(300, 240)).toBe(100);
    expect(percentOf(-4, 240)).toBe(0);
  });
});

describe("renderPhase", () => {
  test("a running job is saving exactly when the engine said so", () => {
    expect(renderPhase(render(1, { status: "queued" }))).toBe("queued");
    expect(renderPhase(render(1))).toBe("rendering");
    expect(renderPhase(render(1, { saving: true }))).toBe("saving");
    expect(renderPhase(render(1, { status: "done" }))).toBe("done");
    expect(renderPhase(render(1, { status: "failed" }))).toBe("failed");
    expect(renderPhase(render(1, { status: "cancelled" }))).toBe("cancelled");
  });

  test("saving on a job that is not running means nothing", () => {
    expect(renderPhase(render(1, { status: "done", saving: true }))).toBe("done");
    expect(renderPhase(render(1, { status: "failed", saving: true }))).toBe("failed");
  });
});

describe("finding a draft's render", () => {
  test("the newest render of THIS draft, among other kinds and other drafts", () => {
    const jobs = [render(1), render(2, { montageId: "montage-0000002" }), run(3), render(4, { status: "done" }), render(5, { montageId: "montage-0000002" })];
    expect(latestRenderOf(jobs, MONTAGE)?.jobId).toBe("job-00000004");
    expect(latestRenderOf(jobs, "montage-0000009")).toBeNull();
    expect(latestRenderOf([], MONTAGE)).toBeNull();
  });

  test("a timed-out `videos.render` answer: the job it queued is found by the draft among the jobs it did not know before", () => {
    const known = new Set(["job-00000001"]);
    const jobs = [render(1, { status: "done" }), render(2, { status: "queued" })];
    expect(foundAfterSubmit(jobs, MONTAGE, known)?.jobId).toBe("job-00000002");
    // Nothing new yet: the job is not (yet) there, and nothing is invented.
    expect(foundAfterSubmit([render(1, { status: "done" })], MONTAGE, known)).toBeNull();
    // Another draft's new job is not ours.
    expect(foundAfterSubmit([render(1), render(3, { montageId: "montage-0000002" })], MONTAGE, known)).toBeNull();
    // A job of another kind is not ours either.
    expect(foundAfterSubmit([run(4)], MONTAGE, new Set())).toBeNull();
  });

  test("the newest of several new jobs", () => {
    expect(foundAfterSubmit([render(2), render(3)], MONTAGE, new Set())?.jobId).toBe("job-00000003");
  });
});

describe("the queue position (K10: jobs are in submission order)", () => {
  test("a render waits behind the renders submitted before it that are still queued or running", () => {
    const jobs = [render(1, { status: "done" }), render(2), render(3, { status: "queued" }), run(4), render(5, { status: "queued" })];
    expect(rendersAhead(jobs, jobs[1]!)).toBe(0);
    expect(rendersAhead(jobs, jobs[2]!)).toBe(1);
    expect(rendersAhead(jobs, jobs[4]!)).toBe(2);
  });

  test("a job that is not in the list has nothing ahead of it", () => {
    expect(rendersAhead([render(1)], render(9, { status: "queued" }))).toBe(0);
  });
});

describe("`video.changed` after `job.failed` wins", () => {
  test("a failed render whose video landed is done, with the result its record gives", () => {
    const failed = render(1, { status: "failed", done: 200, error: { code: "INTERNAL", detail: "x" } });
    const next = applyVideoChanged([failed], video(1));
    expect(next[0]).toMatchObject({
      status: "done",
      saving: false,
      error: null,
      done: 240,
      total: 240,
      result: { kind: "render", videoId: "video-00000001", avatarId: "avatar-mia-0001", bytes: 3_100_000, durationMs: 8_000, videoKind: "photo", relPath: "Mia/2026-10-03_photo_001.mp4" },
    });
  });

  test("a job with no frame total yet takes it from the video's length (30 fps: 3 frames per 100 ms)", () => {
    const failed = render(1, { status: "failed", total: 0, error: { code: "INTERNAL" } });
    expect(applyVideoChanged([failed], video(1, { durationMs: 8_000 }))[0]).toMatchObject({ total: 240, done: 240 });
  });

  test("a job that is still running, queued, done or cancelled is not touched: the normal order is video.changed, then job.done", () => {
    const jobs = [render(1), render(2, { status: "queued" }), render(3, { status: "done" }), render(4, { status: "cancelled" })];
    for (const [i, job] of jobs.entries()) {
      const next = applyVideoChanged(jobs, video(i + 1));
      expect(next[i]).toBe(job);
    }
  });

  test("a video no job made changes nothing, and the list is the same list", () => {
    const jobs = [render(1, { status: "failed", error: { code: "INTERNAL" } })];
    expect(applyVideoChanged(jobs, video(7))).toBe(jobs);
  });

  test("the button then reads done, not failed", () => {
    const failed = render(1, { status: "failed", error: { code: "INTERNAL" } });
    const [job] = applyVideoChanged([failed], video(1));
    expect(renderControl(input({ job: job ?? null, jobs: job ? [job] : [], block: usedBlock }))).toMatchObject({ kind: "done", videoId: "video-00000001" });
  });
});

describe("the render batch of the sidebar (AM4: b = submitted since the queue was last empty, a = ended)", () => {
  test("with nothing queued or running there is no batch, whatever ended before", () => {
    expect(nextRenderBatch(new Set(["job-00000001"]), [render(1, { status: "done" })]).size).toBe(0);
    expect(nextRenderBatch(new Set(), []).size).toBe(0);
  });

  test("a fresh window starts the batch at the oldest active render and takes everything submitted after it", () => {
    const jobs = [render(1, { status: "done" }), render(2), render(3, { status: "done" }), render(4, { status: "queued" })];
    expect(ids([...nextRenderBatch(new Set(), jobs)].map((id) => jobs.find((j) => j.jobId === id)!))).toEqual(["job-00000002", "job-00000003", "job-00000004"]);
  });

  test("a render that ended while others still run stays in the batch: the count never loses it", () => {
    const first = nextRenderBatch(new Set(), [render(1), render(2, { status: "queued" })]);
    const second = nextRenderBatch(first, [render(1, { status: "done" }), render(2)]);
    expect([...second].sort()).toEqual(["job-00000001", "job-00000002"]);
    const third = nextRenderBatch(second, [render(1, { status: "done" }), render(2), render(3, { status: "queued" })]);
    expect([...third].sort()).toEqual(["job-00000001", "job-00000002", "job-00000003"]);
  });

  test("when the last one ends the batch is over, and the next submit starts a new one of its own", () => {
    const running = nextRenderBatch(new Set(), [render(1)]);
    expect(nextRenderBatch(running, [render(1, { status: "done" })]).size).toBe(0);
    expect([...nextRenderBatch(new Set(), [render(1, { status: "done" }), render(2, { status: "queued" })])]).toEqual(["job-00000002"]);
  });

  test("photo runs are not renders", () => {
    expect(nextRenderBatch(new Set(), [run(1), candidates(2)]).size).toBe(0);
  });

  test("a job the store no longer lists leaves the batch", () => {
    expect([...nextRenderBatch(new Set(["job-00000001", "job-00000002"]), [render(2)])]).toEqual(["job-00000002"]);
  });
});

describe("the sidebar's rows", () => {
  test("a render is not «Генерация»: its frames never reach the photo runs' count (the 3d.2 review's «0 / 240»)", () => {
    const jobs = [render(1, { done: 0, total: 240 })];
    const counts = sidebarCounts(jobs, new Set(["job-00000001"]));
    expect(counts.generation).toBeNull();
    expect(counts.render).toMatchObject({ ended: 0, size: 1 });
    expect(counts.queue).toBe(1);
  });

  test("photo runs and candidate batches keep their own row, with the 4-slot fallback for a job with no total yet", () => {
    const jobs = [run(1, { done: 3, total: 20 }), candidates(2, { done: 0, total: 0 }), run(3, { status: "done", done: 20 })];
    const counts = sidebarCounts(jobs, new Set());
    expect(counts.generation).toEqual({ done: 3, total: 24 });
    expect(counts.render).toBeNull();
    expect(counts.queue).toBe(2);
  });

  test("«Очередь · N задач» counts the queued and running renders with the photo runs", () => {
    const jobs = [run(1), render(2, { status: "queued" }), render(3), render(4, { status: "done" })];
    expect(sidebarCounts(jobs, new Set(["job-00000002", "job-00000003", "job-00000004"])).queue).toBe(3);
  });

  test("«Рендер a / b»: a = ended, b = the batch, and the bar counts the running ones by their frames", () => {
    const jobs = [render(1, { status: "done", done: 240 }), render(2, { status: "failed" }), render(3, { done: 120 }), render(4, { status: "queued" }), render(5, { status: "queued" })];
    const batch = new Set(jobs.map((j) => j.jobId));
    const counts = sidebarCounts(jobs, batch);
    expect(counts.render?.ended).toBe(2);
    expect(counts.render?.size).toBe(5);
    expect(counts.render?.fraction).toBeCloseTo(2.5 / 5);
  });

  test("a cancelled render is ended too", () => {
    const jobs = [render(1, { status: "cancelled" }), render(2)];
    expect(sidebarCounts(jobs, new Set(["job-00000001", "job-00000002"])).render).toMatchObject({ ended: 1, size: 2 });
  });

  test("a job with no total yet adds no progress, and nothing divides by zero", () => {
    const jobs = [render(1, { done: 0, total: 0 })];
    expect(sidebarCounts(jobs, new Set(["job-00000001"])).render?.fraction).toBe(0);
  });

  test("a batch with nothing queued or running shows no row", () => {
    const jobs = [render(1, { status: "done", done: 240 })];
    expect(sidebarCounts(jobs, new Set(["job-00000001"])).render).toBeNull();
  });

  test("nothing at all: an empty queue", () => {
    expect(sidebarCounts([], new Set())).toEqual({ queue: 0, generation: null, render: null });
  });
});

describe("what a `videos.render` answer means", () => {
  const ok = { ok: true, result: { jobId: "job-00000009", videoId: "video-00000009" } } as const;
  const fail = (error: EngineError): EngineReply<"videos.render"> => ({ ok: false, error });

  test("an ok answer is the queued job", () => {
    expect(classifyAnswer(ok)).toEqual({ kind: "queued", jobId: "job-00000009", videoId: "video-00000009" });
  });

  test("no answer in time (main's deadline) is NOT a refusal: the job may exist and is looked for by the draft", () => {
    expect(classifyAnswer({ ok: false, error: { code: "INTERNAL", detail: `${NO_ANSWER_DETAIL_PREFIX}30 s` } })).toEqual({ kind: "unknown" });
  });

  test("the engine's own out-of-time before `submit` queued nothing: a refusal, safe to retry", () => {
    const outcome = classifyAnswer({ ok: false, error: { code: "INTERNAL", detail: RENDER_NOT_QUEUED_DETAIL } });
    expect(outcome).toMatchObject({ kind: "refused", clips: [] });
  });

  test("every refusal is a refusal: RENDER_QUEUE_FULL, LIBRARY_TOO_NEW, EXPORT_UNAVAILABLE, NOT_FOUND, IN_FLIGHT", () => {
    for (const error of [
      { code: "RENDER_QUEUE_FULL", detail: renderQueueFullDetail(20) },
      { code: "LIBRARY_TOO_NEW" },
      { code: "EXPORT_UNAVAILABLE", exportReason: "missing" },
      { code: "NOT_FOUND" },
      { code: "IN_FLIGHT" },
    ] as const) {
      expect(classifyAnswer({ ok: false, error })).toEqual({ kind: "refused", error, clips: [] });
    }
  });

  test("PHOTO_UNAVAILABLE names the frames to highlight by its issues, each once, in order; an issue about no frame names none", () => {
    const error: EngineError = {
      code: "PHOTO_UNAVAILABLE",
      detail: "a stale index: do not show this",
      issues: [
        { code: "photo-unavailable", path: ["clips", 2, "cell"] },
        { code: "photo-unavailable", path: ["clips", 0, "cells", 1] },
        { code: "photo-unavailable", path: ["clips", 2, "cells", 0] },
        { code: "photo-unavailable", path: ["photo"] },
      ],
    };
    const outcome = classifyAnswer({ ok: false, error });
    expect(outcome).toMatchObject({ kind: "refused", clips: [0, 2] });
  });

  test("MONTAGE_INVALID highlights the frames its issues name", () => {
    const outcome = classifyAnswer(fail({ code: "MONTAGE_INVALID", issues: [{ code: "cell-empty", path: ["clips", 1, "cell"] }, { code: "no-clips", path: ["clips"] }] }));
    expect(outcome).toMatchObject({ kind: "refused", clips: [1] });
  });
});

describe("the saving phase that never ends", () => {
  test("a notice is due once the phase has lasted the limit, never before, and never for a render that is not saving", () => {
    expect(SAVING_STALL_MS).toBeGreaterThanOrEqual(30_000);
    expect(savingStalled(null, 10 ** 9)).toBe(false);
    expect(savingStalled(1_000, 1_000 + SAVING_STALL_MS - 1)).toBe(false);
    expect(savingStalled(1_000, 1_000 + SAVING_STALL_MS)).toBe(true);
  });
});

const usedBlock: RenderBlock = { text: "Фото уже в видео из этого черновика — замените их или удалите то видео", settings: false, clips: [0] };
const pathBlock: RenderBlock = { text: "Добавьте хотя бы один кадр", settings: false };

function input(patch: Partial<RenderControlInput> = {}): RenderControlInput {
  return { block: null, job: null, jobs: [], submitting: false, verdictPending: false, dismissed: null, cancelling: false, ...patch };
}

describe("the render button's state", () => {
  test("ready, or blocked with the first reason", () => {
    expect(renderControl(input())).toEqual({ kind: "ready" });
    expect(renderControl(input({ block: pathBlock }))).toEqual({ kind: "blocked", block: pathBlock });
  });

  test("no double submit: while a submit is out, or the verdict after a render's end is not read yet, the button is busy and not clickable", () => {
    expect(renderControl(input({ submitting: true }))).toEqual({ kind: "submitting" });
    expect(renderControl(input({ submitting: true, block: pathBlock }))).toEqual({ kind: "submitting" });
    expect(renderControl(input({ verdictPending: true }))).toEqual({ kind: "submitting" });
  });

  test("a queued render says how many are ahead of it", () => {
    const jobs = [render(1), render(2, { status: "queued" })];
    expect(renderControl(input({ job: jobs[1]!, jobs, block: usedBlock }))).toEqual({ kind: "queued", after: 1, cancelling: false });
    expect(renderControl(input({ job: jobs[1]!, jobs, cancelling: true }))).toEqual({ kind: "queued", after: 1, cancelling: true });
  });

  test("a running render shows its floor percent; the boundaries 0 %, 100 % and no total", () => {
    const at = (done: number, total: number): RenderControl => renderControl(input({ job: render(1, { done, total }), jobs: [render(1)] }));
    expect(at(0, 240)).toMatchObject({ kind: "running", percent: 0 });
    expect(at(119, 120)).toMatchObject({ kind: "running", percent: 99 });
    expect(at(240, 240)).toMatchObject({ kind: "running", percent: 100 });
    expect(at(0, 0)).toMatchObject({ kind: "running", percent: 0 });
  });

  test("a timed-out answer does not matter once the job is known from events or the snapshot: the job wins over the busy flag", () => {
    const job = render(2, { done: 60 });
    expect(renderControl(input({ job, jobs: [job], submitting: true }))).toMatchObject({ kind: "running", percent: 25 });
  });

  test("`saving: true` is its own state and disables Cancel; before it, Cancel works, and a cancel already asked disables it", () => {
    const saving = renderControl(input({ job: render(1, { saving: true, done: 239 }), jobs: [render(1)] }));
    expect(saving).toEqual({ kind: "saving" });
    expect(canCancel(saving)).toBe(false);
    const running = renderControl(input({ job: render(1), jobs: [render(1)] }));
    expect(canCancel(running)).toBe(true);
    expect(canCancel(renderControl(input({ job: render(1), jobs: [render(1)], cancelling: true })))).toBe(false);
    const queued = renderControl(input({ job: render(1, { status: "queued" }), jobs: [render(1)] }));
    expect(canCancel(queued)).toBe(true);
    expect(canCancel({ kind: "ready" })).toBe(false);
    expect(canCancel({ kind: "submitting" })).toBe(false);
  });

  test("one photo → one video: after «Готово», «Рендер» stays blocked with the reason, and «Открыть в папке» has the video", () => {
    const done = render(1, { status: "done", done: 240, result: { kind: "render", videoId: "video-00000001", avatarId: "avatar-mia-0001", bytes: 1, durationMs: 8_000, videoKind: "photo", relPath: "Mia/2026-10-03_photo_001.mp4" } });
    expect(renderControl(input({ job: done, jobs: [done], block: usedBlock }))).toEqual({ kind: "done", videoId: "video-00000001", block: usedBlock });
  });

  test("a done render whose photos were replaced since leaves nothing to say: ready again", () => {
    const done = render(1, { status: "done", done: 240 });
    expect(renderControl(input({ job: done, jobs: [done] }))).toEqual({ kind: "ready" });
  });

  test("a failed render shows its error and offers a retry; a dismissed failure is forgotten", () => {
    const error: EngineError = { code: "RENDER_FAILED" };
    const failed = render(1, { status: "failed", error });
    expect(renderControl(input({ job: failed, jobs: [failed] }))).toEqual({ kind: "failed", error, block: null });
    expect(renderControl(input({ job: failed, jobs: [failed], block: pathBlock }))).toEqual({ kind: "failed", error, block: pathBlock });
    expect(renderControl(input({ job: failed, jobs: [failed], dismissed: failed.jobId }))).toEqual({ kind: "ready" });
    expect(renderControl(input({ job: failed, jobs: [failed], dismissed: failed.jobId, block: pathBlock }))).toEqual({ kind: "blocked", block: pathBlock });
  });

  test("a failed job with no error on record still reads failed, with the engine's general error", () => {
    const failed = render(1, { status: "failed" });
    expect(renderControl(input({ job: failed, jobs: [failed] }))).toMatchObject({ kind: "failed", error: { code: "INTERNAL" } });
  });

  test("a cancelled render is ready again (or blocked, by what blocks)", () => {
    const cancelled = render(1, { status: "cancelled" });
    expect(renderControl(input({ job: cancelled, jobs: [cancelled] }))).toEqual({ kind: "ready" });
    expect(renderControl(input({ job: cancelled, jobs: [cancelled], block: pathBlock }))).toEqual({ kind: "blocked", block: pathBlock });
  });
});

type RenderControl = ReturnType<typeof renderControl>;

describe("notices for renders that end out of sight", () => {
  const t0 = 1_000_000;
  const step = (state: RenderNoticeState, jobs: readonly JobView[], now = t0, viewing: string | null = null): RenderNoticeState => trackNotices(state, jobs, now, viewing);

  test("a render this window saw running that ends done or failed raises a notice; one first heard of already ended raises none", () => {
    let state = step(NO_NOTICES, [render(1), render(2, { status: "done" }), render(3, { status: "failed", error: { code: "RENDER_FAILED" } })]);
    expect(state.notices).toEqual([]);
    state = step(state, [render(1, { status: "done" }), render(2, { status: "done" }), render(3, { status: "failed", error: { code: "RENDER_FAILED" } })]);
    expect(state.notices).toEqual([{ id: "job-00000001:done", kind: "done", jobId: "job-00000001" }]);
    const failing = step(NO_NOTICES, [render(5, { status: "queued" })]);
    expect(step(failing, [render(5, { status: "failed", error: { code: "RENDER_FAILED" } })]).notices).toEqual([{ id: "job-00000005:failed", kind: "failed", jobId: "job-00000005" }]);
  });

  test("a notice is raised once, and stays until it is dismissed", () => {
    const watching = step(NO_NOTICES, [render(1)]);
    const ended = [render(1, { status: "done" })];
    const once = step(watching, ended);
    const again = step(once, ended);
    expect(again.notices).toHaveLength(1);
    expect(dismissNotice(again, "job-00000001:done").notices).toEqual([]);
    expect(step(dismissNotice(again, "job-00000001:done"), ended).notices).toEqual([]);
  });

  test("with that draft's editor on screen the header says it, so no notice", () => {
    const watching = step(NO_NOTICES, [render(1)], t0, MONTAGE);
    expect(step(watching, [render(1, { status: "done" })], t0, MONTAGE).notices).toEqual([]);
  });

  test("another draft's editor does not hide it", () => {
    const watching = step(NO_NOTICES, [render(1)]);
    expect(step(watching, [render(1, { status: "done" })], t0, "montage-0000002").notices).toHaveLength(1);
  });

  test("a cancel is the owner's own doing: no notice", () => {
    const watching = step(NO_NOTICES, [render(1)]);
    expect(step(watching, [render(1, { status: "cancelled" })]).notices).toEqual([]);
  });

  test("a photo run is not a render: no notice", () => {
    const watching = step(NO_NOTICES, [run(1)]);
    expect(step(watching, [run(1, { status: "done" })]).notices).toEqual([]);
  });

  test("a saving phase that has lasted the limit raises a notice once, and ending it takes the notice away", () => {
    const saving = (): JobView => render(1, { saving: true, done: 239 });
    let state = step(NO_NOTICES, [saving()], t0);
    expect(state.notices).toEqual([]);
    state = step(state, [saving()], t0 + SAVING_STALL_MS - 1);
    expect(state.notices).toEqual([]);
    state = step(state, [saving()], t0 + SAVING_STALL_MS);
    expect(state.notices).toEqual([{ id: "job-00000001:stalled", kind: "saving-stalled", jobId: "job-00000001" }]);
    state = step(state, [saving()], t0 + SAVING_STALL_MS * 2);
    expect(state.notices).toHaveLength(1);
    state = step(state, [render(1, { status: "done" })], t0 + SAVING_STALL_MS * 2 + 1);
    expect(state.notices.map((n) => n.kind)).toEqual(["done"]);
  });

  test("the stall is told wherever the owner is, even in that draft's editor: it is not the header's «Готово»", () => {
    let state = step(NO_NOTICES, [render(1, { saving: true })], t0, MONTAGE);
    state = step(state, [render(1, { saving: true })], t0 + SAVING_STALL_MS, MONTAGE);
    expect(state.notices.map((n) => n.kind)).toEqual(["saving-stalled"]);
  });
});
