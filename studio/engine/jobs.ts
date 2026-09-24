import type { EngineError, FailedCandidateSlot, JobState } from "../shared/engine";

// The engine's jobs as `Snapshot.jobs` lists them. In memory only: avatar
// jobs do not survive a restart (their open reserves wait for a reconcile,
// invariant 4); a run's crash-resume is T6's.

export type CandidatesJobEnd =
  | { status: "done"; photoIds: string[]; failedSlots: FailedCandidateSlot[] }
  | { status: "failed"; error: EngineError }
  | { status: "cancelled" };

type CandidatesJobState = Extract<JobState, { kind: "avatar.candidates" }>;

interface Entry {
  state: CandidatesJobState;
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
    if (this.#jobs.has(jobId)) throw new Error(`job ${jobId} is already registered`);
    const controller = new AbortController();
    this.#jobs.set(jobId, { state: { kind: "avatar.candidates", jobId, avatarId, status: "running", done: 0, total }, controller });
    return controller.signal;
  }

  /** Records how many slots are done; the `job.progress` payload, or null for a job that is not running. */
  progress(jobId: string, done: number): { jobId: string; done: number; total: number } | null {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined || entry.state.status !== "running") return null;
    entry.state = { ...entry.state, done };
    return { jobId, done, total: entry.state.total };
  }

  /** Ends a running job; its final state, or null for a job that is not running. */
  finish(jobId: string, end: CandidatesJobEnd): JobState | null {
    const entry = this.#jobs.get(jobId);
    if (entry === undefined || entry.state.status !== "running") return null;
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

  #dropOldFinished(): void {
    const finished = [...this.#jobs.values()].filter((entry) => entry.state.status !== "running");
    for (const entry of finished.slice(0, Math.max(0, finished.length - this.#keepFinished))) this.#jobs.delete(entry.state.jobId);
  }
}
