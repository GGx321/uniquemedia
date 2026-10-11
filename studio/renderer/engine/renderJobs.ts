import { NO_ANSWER_DETAIL_PREFIX, PORTRAITS_PER_BATCH, type EngineError, type VideoSummary } from "../../shared/engine";
import type { RenderBlock } from "../screens/montage/renderBlock";
import type { EngineReply } from "./client";
import type { JobView } from "./store";

// The render job model (3d.6): pure logic, no screen. The editor's button, the drafts screen's «Рендер 42 %», the
// sidebar's rows and the notices for renders that end out of sight all read a render the same way, from here. The
// store keeps the jobs (snapshot, `job.*`, `video.changed`); nothing below depends on the answer of one command.

const isRender = (job: JobView): boolean => job.kind === "render";
const isActive = (job: JobView): boolean => job.status === "queued" || job.status === "running";

/** `floor(done / total × 100)` of the frames, held to 0..100: «Рендер · 42 %». No total yet reads 0. */
export function percentOf(done: number, total: number): number {
  if (!(total > 0)) return 0;
  // Integer arithmetic: `done / total * 100` floors 29/100 to 28.
  return Math.min(100, Math.max(0, Math.floor((done * 100) / total)));
}

export type RenderPhase = "queued" | "rendering" | "saving" | "done" | "failed" | "cancelled";

/** «Сохранение» is the engine's flag on a running job, nothing derived from the frame count. */
export function renderPhase(job: JobView): RenderPhase {
  if (job.status === "running") return job.saving ? "saving" : "rendering";
  return job.status;
}

/** The newest render of this draft, whatever its state. */
export function latestRenderOf(jobs: readonly JobView[], montageId: string): JobView | null {
  return jobs.filter((job) => isRender(job) && job.montageId === montageId).at(-1) ?? null;
}

/** How many renders are queued or running ahead of `job` (K10: `Snapshot.jobs` and the store keep submission order). */
export function rendersAhead(jobs: readonly JobView[], job: JobView): number {
  const at = jobs.findIndex((j) => j.jobId === job.jobId);
  return at < 0 ? 0 : jobs.slice(0, at).filter((j) => isRender(j) && isActive(j)).length;
}

/**
 * A `video.changed` that lands after its render's `job.failed` wins: the record is there, so the video exists and the job is done.
 * (The normal order is `video.changed`, then `job.done`: a job still running is left to its own end.) The result is what the record
 * says; the frame total comes from the video's length when no event gave one (30 fps, 3 frames per 100 ms).
 */
export function applyVideoChanged(jobs: readonly JobView[], video: VideoSummary): readonly JobView[] {
  const at = jobs.findIndex((job) => isRender(job) && job.videoId === video.videoId && job.status === "failed");
  const failed = jobs[at];
  if (failed === undefined) return jobs;
  const total = failed.total > 0 ? failed.total : Math.round((video.durationMs * 3) / 100);
  const done: JobView = {
    ...failed,
    status: "done",
    saving: false,
    total,
    done: total,
    error: null,
    result: { kind: "render", videoId: video.videoId, avatarId: video.avatarId, bytes: video.bytes, durationMs: video.durationMs, videoKind: video.kind, relPath: video.relPath },
  };
  return jobs.map((job, i) => (i === at ? done : job));
}

/**
 * The renders the sidebar's «Рендер a / b» counts (AM4): those submitted since the queue was last empty. Empty while no render is queued
 * or running. A render that ended while others still run stays (`prev` keeps it); a window that never saw the start takes everything
 * from the oldest active render on, which is exactly what was submitted while the queue was not empty.
 */
export function nextRenderBatch(prev: ReadonlySet<string>, jobs: readonly JobView[]): ReadonlySet<string> {
  const renders = jobs.filter(isRender);
  const firstActive = renders.findIndex(isActive);
  const batch = new Set<string>();
  if (firstActive < 0) return batch;
  renders.forEach((job, i) => {
    if (i >= firstActive || prev.has(job.jobId)) batch.add(job.jobId);
  });
  return batch;
}

export interface SidebarCounts {
  /** «Очередь · N задач»: everything queued or running, renders included. */
  readonly queue: number;
  /** «Генерация»: the photo runs, candidate batches and portrait batches. A job with no total yet counts its slots: 4, or 5 for a portrait batch (S5.3d). */
  readonly generation: { readonly done: number; readonly total: number } | null;
  /** «Сцены» (CS.6, Sidebar.dc.html): the scene sets' writer jobs — compose, «Дописать», ⟳, «по описанию» — scenes written of scenes asked. */
  readonly scenes: { readonly done: number; readonly total: number } | null;
  /** «Рендер a / b»: `ended` of `size`, and the bar's `fraction` (running renders by their frames). Null while none is queued or running. */
  readonly render: { readonly ended: number; readonly size: number; readonly fraction: number } | null;
}

/** A job's slots before its first progress says its total: a portrait batch draws 5; anything else counts a candidates batch's 4, as it always has. */
function slotsBeforeProgress(job: JobView): number {
  return job.kind === "avatar.portraits" ? PORTRAITS_PER_BATCH : 4;
}

export function sidebarCounts(jobs: readonly JobView[], batch: ReadonlySet<string>): SidebarCounts {
  const active = jobs.filter(isActive);
  const photo = active.filter((job) => !isRender(job) && job.kind !== "scenes");
  const scenes = active.filter((job) => job.kind === "scenes");
  const batchJobs = jobs.filter((job) => isRender(job) && batch.has(job.jobId));
  const running = batchJobs.filter(isActive);
  return {
    queue: active.length,
    generation: photo.length === 0 ? null : { done: photo.reduce((sum, j) => sum + j.done, 0), total: photo.reduce((sum, j) => sum + (j.total || slotsBeforeProgress(j)), 0) },
    scenes: scenes.length === 0 ? null : { done: scenes.reduce((sum, j) => sum + j.done, 0), total: scenes.reduce((sum, j) => sum + j.total, 0) },
    render:
      running.length === 0
        ? null
        : {
            ended: batchJobs.length - running.length,
            size: batchJobs.length,
            fraction: (batchJobs.length - running.length + running.reduce((sum, j) => sum + (j.total > 0 ? Math.min(1, j.done / j.total) : 0), 0)) / batchJobs.length,
          },
  };
}

export type SubmitOutcome =
  /** The engine queued it. */
  | { readonly kind: "queued"; readonly jobId: string; readonly videoId: string }
  /** No answer in time: the job may exist. It is looked for by the draft among the jobs the events and snapshot bring (`foundAfterSubmit`). */
  | { readonly kind: "unknown"; readonly error: EngineError }
  /** A refusal: nothing was queued, and asking again is safe. `clips` are the frames the engine named. */
  | { readonly kind: "refused"; readonly error: EngineError; readonly clips: readonly number[] };

/** The frames (0-based, ascending, each once) the issues of `PHOTO_UNAVAILABLE` / `MONTAGE_INVALID` point at; an issue about no frame names none. */
function clipsOf(error: EngineError): number[] {
  const clips = new Set<number>();
  for (const issue of error.issues ?? []) {
    const [root, index] = issue.path;
    if (root === "clips" && typeof index === "number") clips.add(index);
  }
  return [...clips].sort((a, b) => a - b);
}

/**
 * What a `videos.render` answer means. Only an answer that never came leaves the job's fate open (main's 30 s deadline: the job may be
 * queued all the same); every error the engine itself gave was a refusal that queued nothing, the engine's own 25 s budget before
 * `submit` included.
 */
export function classifyAnswer(reply: EngineReply<"videos.render">): SubmitOutcome {
  if (reply.ok) return { kind: "queued", jobId: reply.result.jobId, videoId: reply.result.videoId };
  if (reply.error.code === "INTERNAL" && reply.error.detail?.startsWith(NO_ANSWER_DETAIL_PREFIX) === true) return { kind: "unknown", error: reply.error };
  return { kind: "refused", error: reply.error, clips: clipsOf(reply.error) };
}

/** The render of `montageId` the window did not know before it submitted (`known`): the job a timed-out answer queued. The newest, or null. */
export function foundAfterSubmit(jobs: readonly JobView[], montageId: string, known: ReadonlySet<string>): JobView | null {
  return jobs.filter((job) => isRender(job) && job.montageId === montageId && !known.has(job.jobId)).at(-1) ?? null;
}

/** A «сохранение» phase that lasts this long is told to the owner: the export folder is probably not answering. */
export const SAVING_STALL_MS = 60_000;

export function savingStalled(since: number | null, now: number): boolean {
  return since !== null && now - since >= SAVING_STALL_MS;
}

export type RenderControl =
  | { readonly kind: "blocked"; readonly block: RenderBlock }
  | { readonly kind: "ready" }
  | { readonly kind: "submitting" }
  | { readonly kind: "queued"; readonly after: number; readonly cancelling: boolean }
  | { readonly kind: "running"; readonly percent: number; readonly cancelling: boolean }
  /** Past the point of no return: Cancel is disabled, because a cancel here cannot stop the job. */
  | { readonly kind: "saving" }
  /** Made; `block` is why «Рендер» is disabled next to «Готово» (one photo → one video, Q1). */
  | { readonly kind: "done"; readonly videoId: string | null; readonly block: RenderBlock | null }
  | { readonly kind: "failed"; readonly error: EngineError; readonly block: RenderBlock | null };

export interface RenderControlInput {
  /** The first thing in the way of a render, from `renderBlock`. */
  readonly block: RenderBlock | null;
  /** This draft's newest render. */
  readonly job: JobView | null;
  readonly jobs: readonly JobView[];
  /** A submit is out, or its answer is not matched by a job yet. */
  readonly submitting: boolean;
  /** A render of this draft ended, and the engine's verdict read after that has not answered: the old one cannot be trusted. */
  readonly verdictPending: boolean;
  /** The failed job whose notice the owner closed. */
  readonly dismissed: string | null;
  /** A cancel of this job was sent and the job has not ended yet. */
  readonly cancelling: boolean;
}

/**
 * The editor's render button, from the job and what blocks a render. The job wins over the busy flag: once the events or the snapshot
 * name it (even when the answer to `videos.render` timed out), the button shows what the job is doing.
 */
export function renderControl(input: RenderControlInput): RenderControl {
  const { job, block } = input;
  if (job !== null && isActive(job)) {
    if (job.status === "queued") return { kind: "queued", after: rendersAhead(input.jobs, job), cancelling: input.cancelling };
    if (job.saving) return { kind: "saving" };
    return { kind: "running", percent: percentOf(job.done, job.total), cancelling: input.cancelling };
  }
  if (input.submitting || input.verdictPending) return { kind: "submitting" };
  if (job !== null && job.status === "done" && block !== null) return { kind: "done", videoId: job.result?.kind === "render" ? job.result.videoId : job.videoId, block };
  if (job !== null && job.status === "failed" && input.dismissed !== job.jobId) return { kind: "failed", error: job.error ?? { code: "INTERNAL" }, block };
  return block === null ? { kind: "ready" } : { kind: "blocked", block };
}

/** Cancel works for a queued or running render, until the saving phase and until a cancel is already out. */
export function canCancel(control: RenderControl): boolean {
  return (control.kind === "queued" || control.kind === "running") && !control.cancelling;
}

export interface RenderNotice {
  readonly id: string;
  readonly kind: "done" | "failed" | "saving-stalled";
  readonly jobId: string;
}

export interface RenderNoticeState {
  /** Renders this window saw queued or running and has not seen end. Only their end is news. */
  readonly watching: ReadonlySet<string>;
  /** When each saving render was first seen saving. */
  readonly savingSince: ReadonlyMap<string, number>;
  readonly notices: readonly RenderNotice[];
  /** Notices the owner closed: never raised again (the stall check runs every few seconds). Forgotten with their job. */
  readonly dismissed: ReadonlySet<string>;
}

export const NO_NOTICES: RenderNoticeState = { watching: new Set(), savingSince: new Map(), notices: [], dismissed: new Set() };

/**
 * Notices for renders: done or failed while the draft's editor is not on screen (`viewing` is that editor's draft, if one is: its header
 * says it), and a saving phase that has lasted `SAVING_STALL_MS` (told anywhere: the header only says «Сохранение…»). A render first
 * heard of already ended raises nothing, and a cancel is the owner's own doing. A notice is raised once and stays until dismissed.
 */
export function trackNotices(state: RenderNoticeState, jobs: readonly JobView[], now: number, viewing: string | null): RenderNoticeState {
  const renders = jobs.filter(isRender);
  const listed = new Set(renders.map((job) => job.jobId));
  const watching = new Set([...state.watching].filter((id) => listed.has(id)));
  const savingSince = new Map<string, number>();
  let notices = [...state.notices];
  const dismissed = new Set([...state.dismissed].filter((id) => listed.has(id.slice(0, id.indexOf(":")))));
  const raise = (notice: RenderNotice): void => {
    if (!dismissed.has(notice.id) && !notices.some((n) => n.id === notice.id)) notices.push(notice);
  };
  for (const job of renders) {
    if (isActive(job)) {
      watching.add(job.jobId);
      if (job.saving) {
        const since = state.savingSince.get(job.jobId) ?? now;
        savingSince.set(job.jobId, since);
        if (savingStalled(since, now)) raise({ id: `${job.jobId}:stalled`, kind: "saving-stalled", jobId: job.jobId });
      }
      continue;
    }
    notices = notices.filter((n) => n.id !== `${job.jobId}:stalled`);
    const seen = viewing !== null && viewing === job.montageId;
    // A video that landed after the render's `job.failed` made the job done (`applyVideoChanged`): the failed notice was wrong.
    if (job.status === "done" && notices.some((n) => n.id === `${job.jobId}:failed`)) {
      notices = notices.filter((n) => n.id !== `${job.jobId}:failed`);
      if (!seen) raise({ id: `${job.jobId}:done`, kind: "done", jobId: job.jobId });
      continue;
    }
    if (!watching.delete(job.jobId)) continue;
    if (!seen && job.status === "done") raise({ id: `${job.jobId}:done`, kind: "done", jobId: job.jobId });
    if (!seen && job.status === "failed") raise({ id: `${job.jobId}:failed`, kind: "failed", jobId: job.jobId });
  }
  return { watching, savingSince, notices, dismissed };
}

export function dismissNotice(state: RenderNoticeState, id: string): RenderNoticeState {
  return { ...state, notices: state.notices.filter((n) => n.id !== id), dismissed: new Set(state.dismissed).add(id) };
}
