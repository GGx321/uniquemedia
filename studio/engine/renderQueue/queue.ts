import type { EngineError, JobProgress, JobState, RenderResult } from "../../shared/engine";
import { FfmpegError, FfmpegTimeoutError } from "../../node/runFfmpeg";
import type { JobRegistry, RenderJobEnd, RenderJobRef } from "../jobs";
import { RenderGraphError } from "../render";
import { homedir } from "node:os";
import { maskHome } from "./scrubber";

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

/**
 * The most render jobs that may be unfinished (queued and running together).
 *
 * 20 because a render is a 4-15 s montage with a time limit of `max(90 s, 30 x
 * its length)`, so 20 in a row is already hours of work behind one export
 * folder, and each queued spec also holds its scene photos out of every other
 * render (invariant 24). Nobody queues that many on purpose; a runaway loop or
 * a stuck double-click handler does. Beyond it a request is refused up front
 * rather than piled up without end (memory, reserved photos, orphaned work).
 */
export const MAX_UNFINISHED_RENDERS = 20;

export type SubmitResult =
  /** Queued (or already started). */
  | { ok: true }
  /** Refused, nothing registered or reserved: these photos are held by another queued or running spec. */
  | { ok: false; code: "PHOTOS_RESERVED"; photoIds: string[] }
  /** Refused, nothing registered or reserved: `limit` render jobs are already queued or running. The command layer maps `code`. */
  | { ok: false; code: "QUEUE_FULL"; limit: number };

export interface ReleaseInfo {
  readonly jobId: string;
  readonly ref: RenderJobRef;
  readonly photoIds: readonly string[];
  readonly result: RenderResult;
}

export type RenderQueueEvent =
  | { type: "started"; state: JobState }
  | { type: "progress"; progress: JobProgress }
  /**
   * `cause` is the error the job threw, for the log. The runner's errors carry the RAW one (paths and all) in their
   * own `.cause`: log it, never send it to the renderer. `state.error` is what may be sent.
   */
  | { type: "ended"; state: JobState; cause?: unknown };

export interface RenderQueueDeps {
  readonly jobs: JobRegistry;
  /** How many jobs run at once; asked at every start, so a settings change applies to the next job. Below 1 counts as 1. */
  readonly size: () => number;
  /** The user's home folder, masked as `~` in every failed job's `detail`; `os.homedir()` (read once, at construction) when absent. Tests give a fake one. */
  readonly home?: string;
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

/**
 * Maps whatever a job threw to the contract's error set, which is small and
 * stable on purpose:
 * - a `RenderFailure` keeps its own error (EXPORT_UNAVAILABLE, RENDER_VERIFY_FAILED, ...);
 * - a timeout is TIMEOUT;
 * - a graph the builder refused (`RenderGraphError`) and an ffmpeg that failed are RENDER_FAILED,
 *   the builder's code or the exit code and the end of stderr in `detail`. A refusal is the spec's
 *   fault or a wiring defect, and the same spec is refused the same way: nothing retries it;
 * - anything else is INTERNAL.
 */
export function renderErrorFrom(error: unknown, home: string): EngineError {
  const mapped = renderErrorUnmasked(error);
  // The last net: whatever text becomes a `detail` loses the user's home folder here, even when no job scrubber ever saw it.
  return mapped.detail === undefined ? mapped : { ...mapped, detail: maskHome(mapped.detail, home) };
}

function renderErrorUnmasked(error: unknown): EngineError {
  if (error instanceof RenderFailure) return error.engineError;
  if (error instanceof RenderGraphError) return { code: "RENDER_FAILED", detail: `the render graph was refused (${error.code}): ${oneLine(error.message)}`.slice(0, 300) };
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
  readonly #home: string;
  /** Every queued and running job, by id; a job leaves it, and gives its photos back, in one step. */
  readonly #held = new Map<string, Held>();
  /** Jobs waiting for a slot, first in, first out. They carry their own `Held`, so starting one needs no lookup that could miss. */
  #waiting: Held[] = [];
  #running = 0;
  #idleWaiters: Array<() => void> = [];

  constructor(deps: RenderQueueDeps) {
    this.#deps = deps;
    // Once, here: a homedir() that threw inside a job's catch would strand the job as running with its slot and photos held.
    this.#home = deps.home ?? homedir();
  }

  /**
   * Queues a job and reserves its photos in one step: the check and the
   * reservation cannot be separated by another submit. Starts it at once when a
   * slot is free. Refuses (`QUEUE_FULL`) beyond `MAX_UNFINISHED_RENDERS` jobs
   * queued or running. Throws for a job id the registry already has.
   */
  submit(submission: RenderSubmission): SubmitResult {
    // The documented throw comes first: a duplicate id is a caller's defect whether or not the queue is full.
    if (this.#deps.jobs.stateOf(submission.jobId) !== undefined) throw new Error(`job ${submission.jobId} is already registered`);
    if (this.#held.size >= MAX_UNFINISHED_RENDERS) return { ok: false, code: "QUEUE_FULL", limit: MAX_UNFINISHED_RENDERS };
    const photos = new Set(submission.photoIds);
    const taken = this.#heldBy(submission.ref.avatarId);
    const conflicts = [...photos].filter((id) => taken.has(id));
    if (conflicts.length > 0) return { ok: false, code: "PHOTOS_RESERVED", photoIds: conflicts };

    const signal = this.#deps.jobs.queueRender(submission.jobId, submission.ref, submission.totalFrames);
    const held: Held = { submission, photos, signal };
    this.#held.set(submission.jobId, held);
    this.#waiting.push(held);
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
    // Only a render: another kind of job (a paid candidates job) is not this queue's to stop.
    if (this.#deps.jobs.stateOf(jobId)?.kind !== "render") return false;
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
      // And a broken reporter must not either: the last resort is the console.
      try {
        (this.#deps.onListenerError ?? ((e: unknown) => console.error("studio render queue: an event listener threw", e)))(error);
      } catch (reporterError) {
        console.error("studio render queue: an event listener threw, and so did its error reporter", error, reporterError);
      }
    }
  }

  /** Re-checks the pool's size and starts waiting jobs that now fit (a settings change raised it). */
  poke(): void {
    this.#pump();
  }

  /** A queued job the registry has just cancelled: out of the line, photos back. A running job's abort is its own `execute`'s business. */
  #onAbort(jobId: string): void {
    if (!this.#waiting.some((held) => held.submission.jobId === jobId)) return;
    this.#waiting = this.#waiting.filter((held) => held.submission.jobId !== jobId);
    this.#held.delete(jobId);
    const state = this.#deps.jobs.stateOf(jobId);
    if (state !== undefined) this.#emit({ type: "ended", state });
    this.#notifyIdle();
  }

  #pump(): void {
    const size = Math.max(1, Math.floor(this.#deps.size()));
    while (this.#running < size) {
      const held = this.#waiting.shift();
      if (held === undefined) return;
      const jobId = held.submission.jobId;
      if (!this.#deps.jobs.startRender(jobId)) {
        // Ended behind the queue's back: drop it, give its photos back.
        this.#held.delete(jobId);
        this.#notifyIdle();
        continue;
      }
      this.#running++;
      const state = this.#deps.jobs.stateOf(jobId);
      if (state !== undefined) this.#emit({ type: "started", state });
      void this.#run(held);
    }
  }

  /** Runs one job to its end. Never rejects: every way out is an ending. */
  async #run(held: Held): Promise<void> {
    const { submission, signal } = held;
    const jobId = submission.jobId;
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
      else end = { status: "failed", error: renderErrorFrom(error, this.#home) };
      cause = error;
    }

    // A job whose work finished is done even if a cancel arrived meanwhile: the file exists.
    if (end.status === "done" && this.#deps.beforeRelease !== undefined) {
      try {
        await this.#deps.beforeRelease({ jobId, ref: submission.ref, photoIds: [...held.photos], result: end.result });
      } catch (error) {
        end = { status: "failed", error: renderErrorFrom(error, this.#home) };
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
