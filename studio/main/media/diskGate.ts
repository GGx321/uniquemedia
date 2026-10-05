// A bound on the file work `studio-media://` does in main (Stage 3 whole-slice review L5).
//
// Every `lstat`, `realpath`, `open` and `read` of a served file runs on one of libuv's four worker threads, shared with ALL the file work main does: settings.json,
// the key stores, the app's own assets over `studio-app://`. A library or export folder on a share that stops answering (a NAS, a sleeping disk: the plan allows
// both, `D:\Reels` and `/Volumes/...`) ties a thread up per request until the share gives up, and a grid of photos asks for many at once. With four threads held,
// main's own file work waits behind them and the window freezes.
//
// So the media protocol's file work goes through this gate:
//   - at most `maxConcurrent` operations are in flight, the rest wait (at most `maxQueued` of them: a longer queue is answered `busy` at once);
//   - each request has `deadlineMs` from the moment it asks, waiting included: past it a request that never started is `busy`, one that started is `timeout`;
//   - a request that is aborted while it waits leaves the queue;
//   - a slot is given back when the operation REALLY ends, not when its deadline passed. A syscall cannot be cancelled, so a timed-out operation still holds its
//     thread; the slot stays taken with it, which is what keeps the number of threads this protocol can hold at `maxConcurrent`, however many requests come.
// The caller answers 503 for `busy` and 504 for `timeout`, with no body and no path.

export type DiskGateReason = "busy" | "timeout" | "aborted";

/** Why the gate did not give an operation's result. Never carries a path or the disk's own message. */
export class DiskGateError extends Error {
  readonly reason: DiskGateReason;
  constructor(reason: DiskGateReason) {
    super(reason);
    this.name = "DiskGateError";
    this.reason = reason;
  }
}

export interface DiskGateOptions {
  /** Operations in flight at once. libuv has four threads and main needs some of them: 2 leaves the rest. */
  readonly maxConcurrent: number;
  /** From the request's ask to its answer, queue wait included. */
  readonly deadlineMs: number;
  /** Requests that may wait for a slot; more are `busy` at once. */
  readonly maxQueued: number;
}

export interface DiskGate {
  /** Operations that started and have not ended (a timed-out one counts until it ends). */
  readonly inFlight: number;
  /** Requests waiting for a slot. */
  readonly queued: number;
  /** Runs `operation` when a slot is free; rejects with a `DiskGateError` when the gate gives up on it, or with the operation's own error. */
  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

interface Waiting {
  start(): void;
}

export function createDiskGate(options: DiskGateOptions): DiskGate {
  let inFlight = 0;
  const queue: Waiting[] = [];

  const pump = (): void => {
    while (inFlight < options.maxConcurrent) {
      const next = queue.shift();
      if (next === undefined) return;
      next.start();
    }
  };

  function run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted === true) return Promise.reject(new DiskGateError("aborted"));
    if (inFlight >= options.maxConcurrent && queue.length >= options.maxQueued) return Promise.reject(new DiskGateError("busy"));
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let answered = false;
      const answer = (settle: () => void): void => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      const leaveQueue = (): void => {
        const at = queue.indexOf(waiting);
        if (at >= 0) queue.splice(at, 1);
      };
      const timer = setTimeout(() => {
        if (!started) leaveQueue();
        answer(() => reject(new DiskGateError(started ? "timeout" : "busy")));
      }, options.deadlineMs);
      const onAbort = (): void => {
        // An operation already in flight cannot be taken back, but nobody is waiting for it any more.
        if (!started) leaveQueue();
        answer(() => reject(new DiskGateError("aborted")));
      };
      const waiting: Waiting = {
        start: () => {
          started = true;
          inFlight++;
          let result: Promise<T>;
          try {
            result = operation();
          } catch (error) {
            result = Promise.reject(error);
          }
          // The slot is released when the operation ends, whenever that is.
          const release = (): void => {
            inFlight--;
            pump();
          };
          result.then(
            (value) => {
              release();
              answer(() => resolve(value));
            },
            (error: unknown) => {
              release();
              answer(() => reject(error));
            },
          );
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (inFlight < options.maxConcurrent) waiting.start();
      else queue.push(waiting);
    });
  }

  return {
    get inFlight() {
      return inFlight;
    },
    get queued() {
      return queue.length;
    },
    run,
  };
}
