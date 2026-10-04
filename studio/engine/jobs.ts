import type { EngineError, FailedCandidateSlot, ImportResult, JobProgress, JobState, MediaFileName, MediaKind, RenderResult } from "../shared/engine";
import type { RunJobEnd } from "./runs/runJob";

// The engine's jobs as `Snapshot.jobs` lists them. In memory only: avatar
// jobs do not survive a restart (their open reserves wait for a reconcile,
// invariant 4); a photo run survives in its library folder instead
// (runs/<runId>/plan.json and journal.jsonl) and a resume is a new job of it.

export type CandidatesJobEnd =
  | { status: "done"; photoIds: string[]; failedSlots: FailedCandidateSlot[] }
  | { status: "failed"; error: EngineError }
  | { status: "cancelled" };

/** How a render job ends; `done` carries what the render made. */
export type RenderJobEnd =
  | { status: "done"; result: RenderResult }
  | { status: "failed"; error: EngineError }
  | { status: "cancelled" };

/** How an import job ends; `done` carries the record that was stored. */
export type ImportJobEnd =
  | { status: "done"; result: ImportResult }
  | { status: "failed"; error: EngineError }
  | { status: "cancelled" };

/** An import's identity: what the bytes are and the file's display name (its base name, never a path). */
export interface ImportJobRef {
  readonly mediaKind: MediaKind;
  readonly name: MediaFileName;
}

/** A render's identity: the video it makes, its avatar and the draft it came from (null for a headless spec). */
export interface RenderJobRef {
  readonly videoId: string;
  readonly avatarId: string;
  readonly montageId: string | null;
}

interface Entry {
  state: JobState;
  controller: AbortController;
}

/** Finished jobs kept for a window that opens later; running jobs are always kept. */
const KEEP_FINISHED = 50;

export class JobRegistry {
  readonly #keepFinished: number;
  /** In start order. */
  readonly #jobs = new Map<string, Entry>();

  constructor(opts: { keepFinished?: number } = {}) {
    this.#keepFinished = opts.keepFinished ?? KEEP_FINISHED;
  }

  /** Registers a running candidates job; its signal fires on `cancel`. */
  startCandidates(jobId: string, avatarId: string, total: number): AbortSignal {
    return this.#start({ kind: "avatar.candidates", jobId, avatarId, status: "running", done: 0, total });
  }

  /** Registers a running job of a photo run; `done` counts the slots its earlier jobs already finished. */
  startRun(jobId: string, run: { runId: string; avatarId: string; total: number; done: number }): AbortSignal {
    return this.#start({ kind: "run", jobId, runId: run.runId, avatarId: run.avatarId, status: "running", done: run.done, total: run.total });
  }

  /**
   * Registers a render job as queued, from the moment its request is accepted;
   * its signal fires on `cancel`. `total` counts frames of the FINAL video
   * (`Σ durationMs × 3 / 100`), and `done` counts the same frames.
   */
  queueRender(jobId: string, ref: RenderJobRef, total: number): AbortSignal {
    return this.#start({ kind: "render", jobId, videoId: ref.videoId, avatarId: ref.avatarId, montageId: ref.montageId, status: "queued", done: 0, total });
  }

  /** Moves a queued render to running; false for any other job or state (a cancelled one stays cancelled). */
  startRender(jobId: string): boolean {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined || entry.state.kind !== "render" || entry.state.status !== "queued") return false;
    entry.state = { ...entry.state, status: "running" };
    return true;
  }

  /**
   * Registers a running own-media import (3f.1b). `total` is the size of the opened file in bytes and `done` counts the bytes copied; the
   * signal fires on `cancel`. The media id is null until the job is done.
   */
  startImport(jobId: string, ref: ImportJobRef, total: number): AbortSignal {
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("an import's size must be a count of bytes");
    return this.#start({ kind: "import", jobId, mediaKind: ref.mediaKind, name: ref.name, mediaId: null, status: "running", done: 0, total });
  }

  /** How many imports are running: what a library switch must wait for (the copy and the record write into the library). */
  activeImports(): number {
    let n = 0;
    for (const { state } of this.#jobs.values()) if (state.kind === "import" && state.status === "running") n++;
    return n;
  }

  /** A job's state as the snapshot lists it, or undefined for an unknown (or long-forgotten) job. */
  stateOf(jobId: string): JobState | undefined {
    return this.#jobs.get(jobId)?.state;
  }

  /** How many render jobs are queued or running: what a library switch must wait for. */
  activeRenders(): number {
    let n = 0;
    for (const { state } of this.#jobs.values()) {
      if (state.kind === "render" && (state.status === "queued" || state.status === "running")) n++;
    }
    return n;
  }

  /**
   * Marks a RUNNING render as saving: its commit has passed the point of no return (a cancel is ignored from here). The
   * mark is in its state (so a snapshot shows it) and in every later progress; the job's end drops it. The progress
   * payload to announce, or null for any other job or state.
   */
  markSaving(jobId: string): JobProgress | null {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined || entry.state.kind !== "render" || entry.state.status !== "running") return null;
    entry.state = { ...entry.state, saving: true };
    const { videoId, avatarId, montageId, done, total } = entry.state;
    return { kind: "render", jobId, videoId, avatarId, montageId, done, total, saving: true };
  }

  /**
   * Records how many slots are done; the `job.progress` payload (with the job's kind, avatar and run), or null for a job that is not running.
   * A render's `done` is clamped: it never goes back and never exceeds `total`.
   */
  progress(jobId: string, reported: number): JobProgress | null {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined || entry.state.status !== "running") return null;
    // A count that is not a number changes nothing (it would poison `done` for good); a fraction is floored.
    const counted = Number.isFinite(reported) ? Math.floor(reported) : entry.state.done;
    const done = entry.state.kind === "render" || entry.state.kind === "import" ? Math.min(entry.state.total, Math.max(entry.state.done, counted)) : counted;
    entry.state = { ...entry.state, done };
    const { total } = entry.state;
    switch (entry.state.kind) {
      case "run":
        return { kind: "run", jobId, runId: entry.state.runId, avatarId: entry.state.avatarId, done, total };
      case "render":
        return { kind: "render", jobId, videoId: entry.state.videoId, avatarId: entry.state.avatarId, montageId: entry.state.montageId, done, total, ...(entry.state.saving === true ? { saving: true } : {}) };
      case "avatar.candidates":
        return { kind: "avatar.candidates", jobId, avatarId: entry.state.avatarId, done, total };
      case "import":
        return { kind: "import", jobId, mediaKind: entry.state.mediaKind, name: entry.state.name, mediaId: null, done, total };
    }
  }

  /** Ends a running candidates job; its final state, or null for any other job. */
  finish(jobId: string, end: CandidatesJobEnd): JobState | null {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined || entry.state.status !== "running" || entry.state.kind !== "avatar.candidates") return null;
    const { kind, avatarId, done, total } = entry.state;
    const common = { kind, jobId, avatarId, done, total };
    switch (end.status) {
      case "done": {
        const candidates = end.photoIds.map((photoId) => ({ avatarId, photoId }));
        const rejectedByAgeCheck = end.failedSlots.filter((f) => f.reason === "age-rejected").length;
        entry.state = { ...common, status: "done", result: { kind, avatarId, candidates, rejectedByAgeCheck, failedSlots: end.failedSlots } };
        break;
      }
      case "failed":
        entry.state = { ...common, status: "failed", error: end.error };
        break;
      case "cancelled":
        entry.state = { ...common, status: "cancelled" };
        break;
    }
    this.#dropOldFinished(jobId);
    return entry.state;
  }

  /** Ends a running job of a photo run; its final state, or null for any other job. */
  finishRun(jobId: string, end: RunJobEnd): JobState | null {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined || entry.state.status !== "running" || entry.state.kind !== "run") return null;
    const { kind, runId, avatarId, done, total } = entry.state;
    const common = { kind, jobId, runId, avatarId, done, total };
    switch (end.status) {
      case "done":
        entry.state = { ...common, status: "done", result: { kind, runId, avatarId, photoIds: end.photoIds, failedSlots: end.failedSlots } };
        break;
      case "failed":
        entry.state = { ...common, status: "failed", error: end.error };
        break;
      case "cancelled":
        entry.state = { ...common, status: "cancelled" };
        break;
    }
    this.#dropOldFinished(jobId);
    return entry.state;
  }

  /** Ends a queued or running render job; its final state, or null for any other job or one that already ended. */
  finishRender(jobId: string, end: RenderJobEnd): JobState | null {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined || entry.state.kind !== "render") return null;
    if (entry.state.status !== "queued" && entry.state.status !== "running") return null;
    const { kind, videoId, avatarId, montageId, done, total } = entry.state;
    const common = { kind, jobId, videoId, avatarId, montageId, total };
    switch (end.status) {
      case "done":
        entry.state = { ...common, status: "done", done: total, result: end.result };
        break;
      case "failed":
        entry.state = { ...common, status: "failed", done, error: end.error };
        break;
      case "cancelled":
        entry.state = { ...common, status: "cancelled", done };
        break;
    }
    this.#dropOldFinished(jobId);
    return entry.state;
  }

  /** Ends a running import job; its final state, or null for any other job or one that already ended. A done import takes its media id from its result. */
  finishImport(jobId: string, end: ImportJobEnd): JobState | null {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined || entry.state.status !== "running" || entry.state.kind !== "import") return null;
    const { kind, mediaKind, name, done, total } = entry.state;
    const common = { kind, jobId, mediaKind, name, total };
    switch (end.status) {
      case "done":
        entry.state = { ...common, mediaId: end.result.mediaId, status: "done", done: total, result: end.result };
        break;
      case "failed":
        entry.state = { ...common, mediaId: null, status: "failed", done, error: end.error };
        break;
      case "cancelled":
        entry.state = { ...common, mediaId: null, status: "cancelled", done };
        break;
    }
    this.#dropOldFinished(jobId);
    return entry.state;
  }

  /** The running job of `runId`, if one is running. */
  runningJobOf(runId: string): string | null {
    for (const entry of this.#jobs.values()) {
      if (entry.state.kind === "run" && entry.state.runId === runId && entry.state.status === "running") return entry.state.jobId;
    }
    return null;
  }

  /**
   * Asks a job to stop; true for a known job (a finished one stays as it ended), false for an unknown one.
   * A running job ends when its owner sees the signal. A queued job has no owner running yet, so it ends
   * as cancelled right here, and only then does its signal fire (a listener sees the final state).
   */
  cancel(jobId: string): boolean {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined) return false;
    if (entry.state.status === "queued") this.finishRender(jobId, { status: "cancelled" });
    if (entry.state.status === "running" || entry.state.status === "cancelled") entry.controller.abort();
    return true;
  }

  states(): JobState[] {
    return [...this.#jobs.values()].map((entry) => entry.state);
  }

  #start(state: JobState): AbortSignal {
    if (this.#jobs.has(state.jobId)) throw new Error(`job ${state.jobId} is already registered`);
    const controller = new AbortController();
    this.#jobs.set(state.jobId, { state, controller });
    return controller.signal;
  }

  /** Keeps the latest finished jobs; `justEnded` is never evicted, so what its owner reads back next is still there. */
  #dropOldFinished(justEnded?: string): void {
    const finished = [...this.#jobs.values()].filter((entry) => entry.state.status !== "running" && entry.state.status !== "queued");
    const evictable = finished.filter((entry) => entry.state.jobId !== justEnded);
    for (const entry of evictable.slice(0, Math.max(0, finished.length - this.#keepFinished))) this.#jobs.delete(entry.state.jobId);
  }
}
