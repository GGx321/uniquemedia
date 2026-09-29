import type { EngineError, FailedCandidateSlot, JobProgress, JobState } from "../shared/engine";
import type { RunJobEnd } from "./runs/runJob";

// The engine's jobs as `Snapshot.jobs` lists them. In memory only: avatar
// jobs do not survive a restart (their open reserves wait for a reconcile,
// invariant 4); a photo run survives in its library folder instead
// (runs/<runId>/plan.json and journal.jsonl) and a resume is a new job of it.

export type CandidatesJobEnd =
  | { status: "done"; photoIds: string[]; failedSlots: FailedCandidateSlot[] }
  | { status: "failed"; error: EngineError }
  | { status: "cancelled" };

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

  /** Records how many slots are done; the `job.progress` payload (with the job's kind, avatar and run), or null for a job that is not running. */
  progress(jobId: string, done: number): JobProgress | null {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined || entry.state.status !== "running") return null;
    entry.state = { ...entry.state, done };
    const { total } = entry.state;
    switch (entry.state.kind) {
      case "run":
        return { kind: "run", jobId, runId: entry.state.runId, avatarId: entry.state.avatarId, done, total };
      case "render":
        // Nothing registers a render job before task 3a.6 (the render queue); its identity is already part of the contract.
        return { kind: "render", jobId, videoId: entry.state.videoId, avatarId: entry.state.avatarId, montageId: entry.state.montageId, done, total };
      case "avatar.candidates":
        return { kind: "avatar.candidates", jobId, avatarId: entry.state.avatarId, done, total };
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
    this.#dropOldFinished();
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
    this.#dropOldFinished();
    return entry.state;
  }

  /** The running job of `runId`, if one is running. */
  runningJobOf(runId: string): string | null {
    for (const entry of this.#jobs.values()) {
      if (entry.state.kind === "run" && entry.state.runId === runId && entry.state.status === "running") return entry.state.jobId;
    }
    return null;
  }

  /** Asks a running job to stop; true for a known job (a finished one stays as it ended), false for an unknown one. */
  cancel(jobId: string): boolean {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined) return false;
    if (entry.state.status === "running") entry.controller.abort();
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

  #dropOldFinished(): void {
    const finished = [...this.#jobs.values()].filter((entry) => entry.state.status !== "running");
    for (const entry of finished.slice(0, Math.max(0, finished.length - this.#keepFinished))) this.#jobs.delete(entry.state.jobId);
  }
}
