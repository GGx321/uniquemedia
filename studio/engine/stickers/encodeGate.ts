import { Worker } from "node:worker_threads";
import { EncodeRequestSchema, EncodeResponseSchema, type EncodeRequest } from "./encodeProtocol";
import { EncodeTooLargeError } from "./encodeJob";

// The own-sticker encode gate (3f.5). Re-encoding an owner's animation with Studio's own APNG writer (a hand-written deflate: the bytes must be
// the same on every platform) takes tens of seconds for a long one, and it is synchronous, so it must not run on the engine's event loop. It runs
// in a `worker_thread`, ONE PER JOB: the thread is started for the job and ended when the job is over, however it ended. A cancel or the time
// limit ENDS the thread (`terminate()`: nothing synchronous can be interrupted from inside), and nothing is written after that, because the
// worker only ever answers with bytes; the importer writes them, and only after the signal was looked at.

/** The worker (or the engine's stand-in for one) failed, was ended, ran out of time, or the job could not be encoded: the owner's file is not to blame. */
export class EncodeWorkerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EncodeWorkerError";
  }
}

/** The part of a `worker_threads` `Worker` the gate uses. */
export interface EncodeWorkerLike {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  on(event: "message" | "error" | "exit", listener: never): unknown;
  terminate(): Promise<number>;
}

export interface StickerEncodeJob {
  readonly rawPath: string;
  readonly width: number;
  readonly height: number;
  readonly slots: readonly number[];
  readonly maxBytes: number;
}

export interface StickerEncodeGateOptions {
  /** Starts one worker thread: the engine's entry supplies `new Worker(<built stickerEncodeWorker entry>)`; a test supplies a scripted one. */
  spawnWorker(): EncodeWorkerLike;
  /** One job may take this long before its worker is ended. */
  timeoutMs: number;
}

export interface StickerEncodeGate {
  /** Encodes the frames the job names. Rejects with `EncodeTooLargeError`, `EncodeWorkerError`, or the signal's reason. */
  encode(job: StickerEncodeJob, signal: AbortSignal): Promise<Uint8Array>;
}

let nextId = 0;

export function createStickerEncodeGate(options: StickerEncodeGateOptions): StickerEncodeGate {
  return {
    encode(job, signal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      const id = nextId++;
      const request = EncodeRequestSchema.safeParse({ type: "encode", id, ...job });
      if (!request.success) return Promise.reject(new EncodeWorkerError("the encode job breaks the protocol's rules"));
      return run(request.data, job.maxBytes, signal, options);
    },
  };
}

function run(request: EncodeRequest, maxBytes: number, signal: AbortSignal, options: StickerEncodeGateOptions): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    let worker: EncodeWorkerLike;
    try {
      worker = options.spawnWorker();
    } catch (error) {
      reject(new EncodeWorkerError("the encode worker could not be started", { cause: error }));
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // The thread's work is over, one way or another: it is ended now, never left to idle.
      void worker.terminate().then(() => undefined, () => undefined);
      action();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(() => reject(new EncodeWorkerError(`the encode did not finish within ${options.timeoutMs} ms; its worker was ended`))), options.timeoutMs);

    worker.on("message", ((raw: unknown) => {
      if (settled) return;
      const parsed = EncodeResponseSchema.safeParse(raw);
      if (!parsed.success || parsed.data.id !== request.id) {
        finish(() => reject(new EncodeWorkerError("the encode worker answered with something it was not asked for")));
        return;
      }
      const answer = parsed.data;
      if (answer.type === "failed") {
        // The worker's own text stays here: it may name a path.
        finish(() => reject(answer.reason === "too-large" ? new EncodeTooLargeError(maxBytes) : new EncodeWorkerError("the encode worker could not encode the sticker")));
        return;
      }
      // The limit is the gate's own too, whatever the worker says.
      if (answer.apng.byteLength > maxBytes) {
        finish(() => reject(new EncodeTooLargeError(maxBytes)));
        return;
      }
      finish(() => resolve(new Uint8Array(answer.apng)));
    }) as never);
    worker.on("error", ((error: Error) => finish(() => reject(new EncodeWorkerError("the encode worker failed", { cause: error })))) as never);
    worker.on("exit", (() => finish(() => reject(new EncodeWorkerError("the encode worker stopped")))) as never);
    try {
      worker.postMessage(request);
    } catch (error) {
      finish(() => reject(new EncodeWorkerError("the encode worker could not be given the job", { cause: error })));
    }
  });
}

/** The real `spawnWorker`: starts the built worker entry (`engine/stickerEncodeWorker.js`); `workerUrl` is a `file://` URL the CALLER resolves from its own `import.meta.url`, so it works inside `app.asar`. */
export function createStickerEncodeSpawner(workerUrl: URL | string): () => Worker {
  return () => new Worker(workerUrl);
}
