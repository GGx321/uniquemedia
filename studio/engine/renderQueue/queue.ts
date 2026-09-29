import type { EngineError, JobProgress, JobState, RenderResult } from "../../shared/engine";
import { FfmpegError, FfmpegTimeoutError } from "../../node/runFfmpeg";
import type { JobRegistry, RenderJobEnd, RenderJobRef } from "../jobs";

// The render queue (task 3a.6): a pool of N over the engine's JobRegistry.
// Jobs are queued, then run first in, first out as slots free; a queued or a
// running job can be cancelled; and every queued or running spec RESERVES its
// scene photos (invariant 24), which the library asks for afresh through
// `reservedPhotos` (its injected provider, 3a.2).
//
// The queue does not know what a job does: `execute` is the job's work, and it
// returns the finished video's `RenderResult`. Here that is the runner
// (`runner.ts`); 3a.8b's `execute` adds verify, claim, intent and commit.

/** Carries a ready-made EngineError out of a job (e.g. EXPORT_UNAVAILABLE at commit), so the job fails with it unchanged. */
export class RenderFailure extends Error {
  readonly engineError: EngineError;

  constructor(engineError: EngineError) {
    super(engineError.detail ?? engineError.code);
    this.name = "RenderFailure";
    this.engineError = engineError;
  }
}

export interface RenderContext {
  /** Fires on `cancel`. The job stops its work (kills its ffmpeg) and rejects; the queue then ends it as cancelled. */
  readonly signal: AbortSignal;
  /**
   * Frames of the FINAL video done so far. The registry keeps it monotonic and
   * at most `totalFrames`; the returned payload is what was sent as the event,
   * or null when the job is not running any more.
   */
  progress(done: number): JobProgress | null;
}

export interface RenderSubmission {
  readonly jobId: string;
  readonly ref: RenderJobRef;
  /** `Σ durationMs × 3 / 100`, known from the moment the job is queued. */
  readonly totalFrames: number;
  /** The scene photos the spec names. They stay reserved until the job ends (see `beforeRelease`). */
  readonly photoIds: readonly string[];
  readonly execute: (context: RenderContext) => Promise<RenderResult>;
}

export type SubmitResult =
  /** Queued (or already started). */
  | { ok: true }
  /** Refused, nothing registered or reserved: these photos are held by another queued or running spec. */
  | { ok: false; photoIds: string[] };

export interface ReleaseInfo {
  readonly jobId: string;
  readonly ref: RenderJobRef;
  readonly photoIds: readonly string[];
  readonly result: RenderResult;
}

export type RenderQueueEvent =
  | { type: "started"; state: JobState }
  | { type: "progress"; progress: JobProgress }
  /** `cause` is the raw error of a failed job (its stderr tail included), for the log. */
  | { type: "ended"; state: JobState; cause?: unknown };

export interface RenderQueueDeps {
  readonly jobs: JobRegistry;
  /** How many jobs run at once; asked at every start, so a settings change applies to the next job. Below 1 counts as 1. */
  readonly size: () => number;
  readonly onEvent?: (event: RenderQueueEvent) => void;
  /** Where the error of a throwing `onEvent` goes (the log); `console.error` when absent. */
  readonly onListenerError?: (error: unknown) => void;
  /**
   * THE RELEASE POINT. Called for a job that finished, after its `execute`
   * resolved and before the job is marked done and before its photos are
   * released. Task 3a.8b's commit puts its record into the used index here
   * (`Library.addVideoRecordToIndex`), so there is never a moment when the
   * photos are neither reserved nor used. A throw fails the job; the photos
   * are released either way. Not called for a failed or cancelled job (no
   * record, nothing to index): those just release.
   */
  readonly beforeRelease?: (info: ReleaseInfo) => void | Promise<void>;
}

const DETAIL_TAIL = 300;
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Maps whatever a job threw to the contract's error set. */
export function renderErrorFrom(error: unknown): EngineError {
  if (error instanceof RenderFailure) return error.engineError;
  if (error instanceof FfmpegTimeoutError) return { code: "TIMEOUT", detail: `the render ran past its time limit of ${Math.round(error.timeoutMs / 1000)} s` };
  if (error instanceof FfmpegError) {
    const tail = oneLine(error.stderrTail).slice(-DETAIL_TAIL);
    return { code: "RENDER_FAILED", detail: tail === "" ? error.message : `${error.message}: ${tail}` };
  }
  return { code: "INTERNAL", detail: (error instanceof Error ? oneLine(error.message) : "unknown error").slice(0, 300) };
}

interface Held {
  readonly submission: RenderSubmission;
  readonly photos: ReadonlySet<string>;
  readonly signal: AbortSignal;
}

export class RenderQueue {
  readonly #deps: RenderQueueDeps;
  /** Every queued and running job, by id; a job leaves it, and gives its photos back, in one step. */
  readonly #held = new Map<string, Held>();
  /** Ids waiting for a slot, first in, first out. */
  #waiting: string[] = [];
  #running = 0;
  #idleWaiters: Array<() => void> = [];

  constructor(deps: RenderQueueDeps) {
    this.#deps = deps;
  }

  /**
   * Queues a job and reserves its photos in one step: the check and the
   * reservation cannot be separated by another submit. Starts it at once when a
   * slot is free. Throws for a job id the registry already has.
   */
  submit(submission: RenderSubmission): SubmitResult {
    const photos = new Set(submission.photoIds);
    const taken = this.#heldBy(submission.ref.avatarId);
    const conflicts = [...photos].filter((id) => taken.has(id));
    if (conflicts.length > 0) return { ok: false, photoIds: conflicts };

    const signal = this.#deps.jobs.queueRender(submission.jobId, submission.ref, submission.totalFrames);
    this.#held.set(submission.jobId, { submission, photos, signal });
    this.#waiting.push(submission.jobId);
    signal.addEventListener("abort", () => this.#onAbort(submission.jobId), { once: true });
    this.#pump();
    return { ok: true };
  }

  /**
   * Cancels a queued job (it ends at once, and never runs) or a running one
   * (its signal fires; it ends once its work has stopped). True for a known job
   * (a finished one stays as it ended), false for an unknown one.
   */
  cancel(jobId: string): boolean {
    return this.#deps.jobs.cancel(jobId);
  }

  /** The scene photos of `avatarId` that queued and running specs hold: the library's reserved-set provider. A fresh copy each time. */
  reservedPhotos(avatarId: string): ReadonlySet<string> {
    return this.#heldBy(avatarId);
  }

  /** The render jobs as the snapshot lists them: queued, running, and the latest finished. */
  states(): JobState[] {
    return this.#deps.jobs.states().filter((state) => state.kind === "render");
  }

  /** How many jobs are queued or running: what a library switch must wait for. */
  active(): number {
    return this.#deps.jobs.activeRenders();
  }

  /** Resolves once no job is queued or running. */
  idle(): Promise<void> {
    if (this.#held.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #heldBy(avatarId: string): Set<string> {
    const out = new Set<string>();
    for (const held of this.#held.values()) {
      if (held.submission.ref.avatarId !== avatarId) continue;
      for (const id of held.photos) out.add(id);
    }
    return out;
  }

  #emit(event: RenderQueueEvent): void {
    try {
      this.#deps.onEvent?.(event);
    } catch (error) {
      // A broken listener (a closed window) must not stop the queue; it is reported, not hidden.
      (this.#deps.onListenerError ?? ((e: unknown) => console.error("studio render queue: an event listener threw", e)))(error);
    }
  }

  /** A queued job the registry has just cancelled: out of the line, photos back. A running job's abort is its own `execute`'s business. */
  #onAbort(jobId: string): void {
    if (!this.#waiting.includes(jobId)) return;
    this.#waiting = this.#waiting.filter((id) => id !== jobId);
    this.#held.delete(jobId);
    const state = this.#deps.jobs.stateOf(jobId);
    if (state !== undefined) this.#emit({ type: "ended", state });
    this.#notifyIdle();
  }

  #pump(): void {
    const size = Math.max(1, Math.floor(this.#deps.size()));
    while (this.#running < size) {
      const jobId = this.#waiting.shift();
      if (jobId === undefined) return;
      if (!this.#deps.jobs.startRender(jobId)) {
        this.#held.delete(jobId);
        continue;
      }
      this.#running++;
      const state = this.#deps.jobs.stateOf(jobId);
      if (state !== undefined) this.#emit({ type: "started", state });
      void this.#run(jobId);
    }
  }

  /** Runs one job to its end. Never rejects: every way out is an ending. */
  async #run(jobId: string): Promise<void> {
    const held = this.#held.get(jobId);
    if (held === undefined) return;
    const { submission, signal } = held;
    let end: RenderJobEnd;
    let cause: unknown;

    try {
      const result = await submission.execute({
        signal,
        progress: (done) => {
          const progress = this.#deps.jobs.progress(jobId, done);
          if (progress !== null) this.#emit({ type: "progress", progress });
          return progress;
        },
      });
      end = { status: "done", result };
    } catch (error) {
      // A cancel decides how a job that stopped with an error ended, whatever error the kill produced.
      if (signal.aborted) end = { status: "cancelled" };
      else end = { status: "failed", error: renderErrorFrom(error) };
      cause = error;
    }

    // A job whose work finished is done even if a cancel arrived meanwhile: the file exists.
    if (end.status === "done" && this.#deps.beforeRelease !== undefined) {
      try {
        await this.#deps.beforeRelease({ jobId, ref: submission.ref, photoIds: [...held.photos], result: end.result });
      } catch (error) {
        end = { status: "failed", error: renderErrorFrom(error) };
        cause = error;
      }
    }

    const state = this.#deps.jobs.finishRender(jobId, end);
    this.#held.delete(jobId);
    this.#running--;
    if (state !== null) this.#emit(cause === undefined ? { type: "ended", state } : { type: "ended", state, cause });
    this.#pump();
    this.#notifyIdle();
  }

  #notifyIdle(): void {
    if (this.#held.size > 0) return;
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
}
