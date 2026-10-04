import { FfmpegTimeoutError } from "../../node/runFfmpeg";

// The time bound of a render's staging (3f.3b, round 3). Everything that reads the job's files before ffmpeg starts (the own photos' and videos' copies, an own sticker, a
// track's bytes) runs under ONE bound, sized from the SUM of the bytes (`stagingTimeoutMs`) and raced against the work: the job ends the moment the bound passes or the
// owner cancels, whatever a copy is stuck in. An abort is only seen between two chunks, and a `read` on a dead disk never returns, while the queue waits for `execute` to
// settle: without this race a render slot is held for ever. The abandoned work is handed a signal that carries the reason, so it stops and removes what it made
// when its read finally returns; a failure it ends with then is swallowed here, because the job has long ended and an unhandled rejection would take the process down.

/** The clock behind the bound; the real one by default (a test moves time by hand). */
export interface StagingTimers {
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const REAL_TIMERS: StagingTimers = {
  // Not `unref`ed: while a staging is stuck in a read that never returns, THIS timer is what the process is waiting for (an unref'd one let Bun on Windows idle for ever with
  // the job's promise pending: the CI shard hung). It never outlives its job: `release` clears it on every way out of `execute` and of the runner.
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface StagingBound {
  /** Aborted when the bound passes or the owner cancels; the reason is the `FfmpegTimeoutError` or the cancel's own. */
  readonly signal: AbortSignal;
  /** Runs one piece of staging under the bound; rejects when the bound passes or the owner cancels, even while the work is stuck. Not started at all when already over. */
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Stops the clock: the staging is over. Safe to call again. */
  release(): void;
}

/** A bound of `ms` over `cancel` (the job's own signal), shared by every `run` of one job. */
export function stagingBound(ms: number, cancel: AbortSignal, timers: StagingTimers = REAL_TIMERS): StagingBound {
  const over = new AbortController();
  let handle: unknown;
  let armed = false;
  let released = false;
  const signal = AbortSignal.any([cancel, over.signal]);
  return {
    signal,
    async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (released) throw new Error("the staging is over");
      signal.throwIfAborted();
      // The clock starts with the first piece of work: the job has other steps (the export folder's) before its staging, and they are not the disk's slowness.
      if (!armed) {
        armed = true;
        handle = timers.set(() => over.abort(new FfmpegTimeoutError(ms, "")), ms);
      }
      const ended = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      ended.catch(() => undefined);
      const working = work(signal);
      // The race forgets the work once it has lost; its late failure must still be handled. (`Promise.race` itself subscribes to both promises, so today these two
      // `catch`es are belt and braces, and removing one cannot be seen from outside; they keep the guarantee if the race is ever rewritten. The tests pin the guarantee.)
      working.catch(() => undefined);
      return Promise.race([working, ended]);
    },
    release(): void {
      if (released) return;
      released = true;
      if (armed) timers.clear(handle);
    },
  };
}
