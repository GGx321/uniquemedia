import type { FaceGateImage } from "../face";
import { DecodeResponseSchema } from "./decodeProtocol";

// The own-photo decode gate (Stage 3, 3f.2 fix round 1, H1). The WASM JPEG and PNG decode of a picture the owner picked is SYNCHRONOUS, takes
// hundreds of megabytes for a camera picture, and its `WebAssembly.Memory` only ever grows. In the engine's thread it blocked every command
// (a cancel included) for as long as it ran and held its memory for the rest of the session. So it runs in a `worker_thread`, as the face
// gate's decode does (T7c):
//   - the engine thread only passes bytes in (transferred when it can) and takes pixels back (transferred);
//   - a cancel or a time limit ENDS the worker (`terminate()`): synchronous WASM cannot be interrupted from inside;
//   - an idle worker is ended after `idleRecycleMs`, and one that produced a big picture at once (`bigResultBytes`), so its WASM memory goes
//     back with it; the next decode starts a fresh one;
//   - one decode at a time, in order of asking.

/** The worker (or the engine's stand-in for one) failed, was ended, or ran out of time: the picture itself is not to blame. */
export class DecodeWorkerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DecodeWorkerError";
  }
}

/** The part of a `worker_threads` `Worker` the gate uses. */
export interface DecodeWorkerLike {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  on(event: "message" | "error" | "exit", listener: never): unknown;
  terminate(): Promise<number>;
}

export interface DecodeGateOptions {
  /** Starts one worker thread: the engine's entry supplies `new Worker(<built photoDecodeWorker entry>, { workerData })`; a test supplies a scripted one. */
  spawnWorker(): DecodeWorkerLike;
  /** An idle worker is ended after this long. */
  idleRecycleMs: number;
  /** One decode may take this long before its worker is ended. */
  timeoutMs: number;
  /** A decoded picture of at least this many bytes ends its worker right away. 64 MiB by default (4 megapixels of RGBA is 16 MiB; the cap is 200 MB). */
  bigResultBytes?: number;
}

export interface DecodeGate {
  /** Decodes a JPEG or PNG. The bytes are GIVEN to the worker: when they fill their whole buffer the buffer is transferred and the caller's array is empty afterwards. */
  decode(bytes: Uint8Array, signal: AbortSignal): Promise<FaceGateImage>;
  /** Ends the worker, if there is one. */
  dispose(): Promise<void>;
}

const DEFAULT_BIG_RESULT_BYTES = 64 * 1024 * 1024;

interface Pending {
  readonly id: number;
  readonly resolve: (image: FaceGateImage) => void;
  readonly reject: (error: unknown) => void;
}

export function createDecodeGate(options: DecodeGateOptions): DecodeGate {
  const bigResultBytes = options.bigResultBytes ?? DEFAULT_BIG_RESULT_BYTES;
  let worker: DecodeWorkerLike | null = null;
  let pending: Pending | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 0;
  /** The tail of the queue: a decode starts when the one before it has ended, however it ended. */
  let tail: Promise<unknown> = Promise.resolve();

  function endWorker(): void {
    clearTimeout(idleTimer);
    const ending = worker;
    worker = null;
    // A worker that does not end cleanly is not waited for: it is gone from the gate's point of view, and the next decode gets another.
    void ending?.terminate().catch(() => undefined);
  }

  function start(): DecodeWorkerLike {
    clearTimeout(idleTimer);
    if (worker !== null) return worker;
    const fresh = options.spawnWorker();
    worker = fresh;
    const lost = (reason: string, cause?: unknown): void => {
      // Only the worker that is current: a stale one that was already replaced says nothing about the present.
      if (worker !== fresh) return;
      worker = null;
      const waiting = pending;
      pending = null;
      waiting?.reject(new DecodeWorkerError(reason, cause === undefined ? undefined : { cause }));
    };
    fresh.on("message", ((raw: unknown) => {
      if (worker !== fresh) return;
      const parsed = DecodeResponseSchema.safeParse(raw);
      const waiting = pending;
      if (!parsed.success || waiting === null || parsed.data.id !== waiting.id) {
        // Not what was asked for: the worker is not trusted any further.
        endWorker();
        pending = null;
        waiting?.reject(new DecodeWorkerError("the decode worker answered with something it was not asked for"));
        return;
      }
      pending = null;
      if (parsed.data.type === "failed") {
        waiting.reject(new Error(parsed.data.message));
        return;
      }
      const { width, height, data } = parsed.data;
      if (data.byteLength !== width * height * 4) {
        endWorker();
        waiting.reject(new DecodeWorkerError("the decode worker's pixels do not fit the size it gave"));
        return;
      }
      if (data.byteLength >= bigResultBytes) endWorker();
      waiting.resolve({ format: "rgba", width, height, data: new Uint8Array(data) });
    }) as never);
    fresh.on("error", ((error: Error) => lost("the decode worker failed", error)) as never);
    fresh.on("exit", (() => lost("the decode worker stopped")) as never);
    return fresh;
  }

  function armIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (pending === null) endWorker();
    }, options.idleRecycleMs);
    // An idle worker must never keep the process alive.
    (idleTimer as { unref?: () => void }).unref?.();
  }

  function run(bytes: Uint8Array, signal: AbortSignal): Promise<FaceGateImage> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<FaceGateImage>((resolve, reject) => {
      const id = nextId++;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = (): void =>
        finish(() => {
          // The decode is synchronous inside the worker: the only way to stop it is to end the worker.
          if (pending?.id === id) {
            pending = null;
            endWorker();
          }
          reject(signal.reason);
        });
      signal.addEventListener("abort", onAbort, { once: true });
      let target: DecodeWorkerLike;
      try {
        target = start();
      } catch (error) {
        finish(() => reject(new DecodeWorkerError("the decode worker could not be started", { cause: error })));
        return;
      }
      pending = {
        id,
        resolve: (image) => finish(() => resolve(image)),
        reject: (error) => finish(() => reject(error)),
      };
      timer = setTimeout(() => {
        if (pending?.id !== id) return;
        pending = null;
        endWorker();
        finish(() => reject(new DecodeWorkerError(`the decode did not finish within ${options.timeoutMs} ms; its worker was ended`)));
      }, options.timeoutMs);
      // The buffer goes over whole when the bytes fill it; a view into a larger buffer is copied, never the caller's neighbours.
      const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer;
      const buffer: ArrayBuffer = whole ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer;
      try {
        target.postMessage({ type: "decode", id, bytes: buffer }, [buffer]);
      } catch (error) {
        pending = null;
        endWorker();
        finish(() => reject(new DecodeWorkerError("the decode worker could not be given the picture", { cause: error })));
      }
    }).finally(() => {
      if (worker !== null && pending === null) armIdle();
    });
  }

  return {
    decode(bytes, signal) {
      // Queued: a decode waits for the one before it; an abort while it waits rejects it without touching the worker that is busy.
      const turn = tail.then(() => run(bytes, signal));
      tail = turn.catch(() => undefined);
      return abortableWait(turn, signal);
    },
    async dispose() {
      pending?.reject(new DecodeWorkerError("the decode gate was disposed"));
      pending = null;
      endWorker();
    },
  };
}

/** Rejects with the signal's reason as soon as it fires, even while the decode is still waiting for its turn. */
function abortableWait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return work.then(() => Promise.reject(signal.reason), () => Promise.reject(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
