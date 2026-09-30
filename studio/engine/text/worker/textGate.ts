import type { Worker } from "node:worker_threads";
import { timeoutSignal, untilAborted } from "../../money/timeoutSignal";
import type { CaptionImage, CaptionRequest } from "../caption/types";
import { DEFAULT_RASTER_LIMITS, RasterError, TEXT_RENDER_DEADLINE_MS, type Box, type RasterImage, type RasterRequest } from "../rasterTypes";
import { boundedMessage, TextWorkerRequestSchema, TextWorkerResponseSchema, type TextWorkerRequest, type TextWorkerResponse } from "./protocol";

// The engine side of the text worker, the face gate's design (face/worker/workerGate.ts) for the same reason:
// resvg is synchronous wasm, so neither a deadline nor a cancel can stop it from the thread it runs on. The
// round-1 review measured why that matters here: a «Без фона» caption costs 67-284 ms, a full-frame shadow
// 1.3 s and 20 blurred rects 4.5 s, all of it blocking whatever else shares the thread (main's commands,
// face-worker answers, the money timers; after a long stall Node fires timers before I/O, so a deadline can beat
// an answer that arrived in time).
//
// So the rasteriser lives in ONE worker thread this module owns. The engine sends the SVG and gets back a
// transferred PNG. A call that overruns `renderTimeoutMs`, is cancelled, or leaves the worker's resvg broken (a
// wasm trap) TERMINATES the worker, and the lane is released only once it has really exited, so two computations
// can never overlap; the next call spawns a fresh one. An idle worker is recycled too, because wasm memory never
// shrinks (a full-frame shadow leaves +210 MB for good) and a terminate gives all of it back.
//
// The lane is a plain FIFO: one worker is one computation at a time. A caller cancelled while still queued leaves
// the queue at once and never touches the worker that is busy for someone else.
//
// Failure classification: a `failed` the worker reports keeps the worker alive and rejects with a `RasterError`
// carrying the worker's code, unless the worker marks it `fatal` (resvg is broken), which replaces the worker.
// A crash, an exit, a message outside the protocol, a load failure or a deadline rejects with `WORKER_FAILED` or
// `RENDER_TIMEOUT` and kills the worker. Nothing here ever falls back to another rendering.

/** Below main's own 30 s command deadline (`engineHost.ts`'s REQUEST_TIMEOUT_MS): a load must succeed or fail informatively before main gives up on it. */
export const TEXT_WORKER_LOAD_TIMEOUT_MS = 10_000;

export { TEXT_RENDER_DEADLINE_MS };

/** A terminate is milliseconds; this only bounds a worker that will not die (a wedged runtime), which the gate then refuses to live alongside. */
export const TEXT_WORKER_KILL_TIMEOUT_MS = 5_000;

/** How long an idle worker lives before it is terminated to give its wasm memory back. */
export const TEXT_WORKER_IDLE_RECYCLE_MS = 60_000;

export interface TextGateOptions {
  /** Starts one worker thread. The engine's entry supplies `new Worker(<built textWorker entry>, { workerData })`; tests supply a scripted one. */
  spawnWorker: () => Worker;
  loadTimeoutMs?: number;
  renderTimeoutMs?: number;
  /** Off unless set. */
  idleRecycleMs?: number;
  killTimeoutMs?: number;
}

/** A rendered caption box, with the time the worker itself spent so the round trip's own cost can be told apart. */
export interface GateImage extends RasterImage {
  workerMs: number;
}

/** A captioned layer: the picture, its resolved layout, and the time the worker itself spent. */
export interface GateCaption extends CaptionImage {
  workerMs: number;
}

export interface CaptionCallOptions {
  /** Aborting while the call is QUEUED costs nothing; aborting once it is running terminates the worker (a running resvg call cannot be interrupted). */
  signal?: AbortSignal;
  /** Called once, when the call gets the lane and is about to run: from then on a cancel would kill the worker, so a caller that only wants to drop stale queued work stops cancelling here. Not called for a call cancelled before that. */
  onStart?: () => void;
}

export interface TextGate {
  /** Spawns the worker and waits for it to load; a no-op when one is live. Aborting `signal` terminates a load in progress. */
  start(signal?: AbortSignal): Promise<void>;
  /** Draws the SVG in the worker. The PNG is transferred, not copied. Rejects with a `RasterError`. */
  render(request: RasterRequest, signal?: AbortSignal): Promise<GateImage>;
  /** resvg's own `getBBox()` in the worker, or null when nothing is drawn. */
  measure(request: RasterRequest, signal?: AbortSignal): Promise<Box | null>;
  /**
   * A text layer to a picture, in the worker: the caption rules, the layout, the fixed template and resvg. Rejects with a
   * `RasterError`: `CAPTION_INVALID` (carrying the rule) for a caption that breaks one, `RENDER_TIMEOUT` past the deadline,
   * `RENDER_FAILED` for anything resvg or the template refuses. A request the worker's protocol would refuse is
   * `RENDER_FAILED` here, before anything is sent.
   */
  caption(request: CaptionRequest, options?: CaptionCallOptions): Promise<GateCaption>;
  /** Terminates the worker for good; a call in flight fails, and every later call rejects. */
  dispose(): Promise<void>;
  /** True once a worker could not be terminated: every later call fails with it until the engine restarts. */
  isBroken(): boolean;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: RasterError; fatal: boolean };

interface Live {
  readonly worker: Worker;
  /** Settles when the worker reports `ready` (resolve) or `load-failed`/dies first (reject). */
  readonly loaded: Promise<void>;
  /** Resolves when the worker's `exit` event has fired. */
  readonly gone: Promise<void>;
  dead: boolean;
  killing: Promise<void> | null;
  /** Set only while a request is in flight. */
  onMessage: ((raw: unknown) => void) | null;
  onDeath: ((error: RasterError) => void) | null;
}

interface Waiter {
  grant(): void;
  reject(error: unknown): void;
}

const NEVER_ABORTED = new AbortController().signal;

/** Refuses an SVG over the byte cap before anything is sent: the worker would only refuse it too, and a request that big is never worth the message. */
function checkSize(request: RasterRequest): void {
  if (Buffer.byteLength(request.svg, "utf8") > DEFAULT_RASTER_LIMITS.maxSvgBytes) {
    throw new RasterError("SVG_TOO_LARGE", `the SVG is over ${DEFAULT_RASTER_LIMITS.maxSvgBytes} bytes`);
  }
}

const workerFailed = (message: string, cause?: unknown): RasterError => new RasterError("WORKER_FAILED", message, cause === undefined ? undefined : { cause });

export function createTextGate(options: TextGateOptions): TextGate {
  const loadTimeoutMs = options.loadTimeoutMs ?? TEXT_WORKER_LOAD_TIMEOUT_MS;
  const renderTimeoutMs = options.renderTimeoutMs ?? TEXT_RENDER_DEADLINE_MS;
  let live: Live | null = null;
  let disposed = false;
  let nextRequestId = 0;
  /** Set once a worker would not terminate: every later call fails with it rather than spawn a second worker beside one that may still be running. */
  let broken: RasterError | null = null;
  const pendingKills = new Set<Promise<void>>();

  // ---- the lane -----------------------------------------------------------
  let busy = false;
  const queue: Waiter[] = [];

  function acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next !== undefined) next.grant();
      else busy = false;
    };
    if (!busy) {
      busy = true;
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      const waiter: Waiter = {
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          resolve(release);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  }

  function laneRequestRejected(error: unknown): void {
    console.warn(`studio engine: a background text worker kill gave up its place in the lane (${error instanceof Error ? error.message : "unknown error"})`);
  }

  // ---- idle recycling -----------------------------------------------------
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }

  /** Arms the recycle when the lane is idle and a worker is live. The recycle takes the lane, so a call arriving mid-terminate waits for the worker to be gone before a new one starts. */
  function scheduleIdleRecycle(): void {
    cancelIdleTimer();
    const after = options.idleRecycleMs;
    if (after === undefined || disposed || busy || live === null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (busy || live === null) return;
      acquire(NEVER_ABORTED)
        .then(async (release) => {
          try {
            if (live !== null) await kill(live);
          } finally {
            release();
            scheduleIdleRecycle();
          }
        })
        .catch(laneRequestRejected);
    }, after);
    idleTimer.unref?.();
  }

  // ---- the worker ---------------------------------------------------------
  function spawn(): Live {
    const worker = options.spawnWorker();
    let markLoaded: () => void = () => {};
    let failLoad: (error: RasterError) => void = () => {};
    const loaded = new Promise<void>((resolve, reject) => {
      markLoaded = resolve;
      failLoad = reject;
    });
    loaded.catch(() => {}); // every waiter handles it; this only keeps a load nobody awaits any more from surfacing as unhandled
    let markGone: () => void = () => {};
    const gone = new Promise<void>((resolve) => {
      markGone = resolve;
    });
    const entry: Live = { worker, loaded, gone, dead: false, killing: null, onMessage: null, onDeath: null };
    let ready = false;
    let failure: Error | null = null;

    /** The worker broke the contract: fail whoever is waiting on it, or, when nobody is, kill it under the lane so no second worker can overlap it. */
    const violate = (reason: string): void => {
      const error = workerFailed(reason);
      if (!ready) failLoad(error);
      else if (entry.onDeath !== null) entry.onDeath(error);
      else killUnderLane(entry);
    };

    worker.on("message", (raw: unknown) => {
      if (ready) {
        if (entry.onMessage !== null) entry.onMessage(raw);
        else violate("the text worker sent a message nobody asked for");
        return;
      }
      const parsed = TextWorkerResponseSchema.safeParse(raw);
      if (parsed.success && parsed.data.type === "ready") {
        ready = true;
        markLoaded();
      } else if (parsed.success && parsed.data.type === "load-failed") {
        failLoad(workerFailed(`the text worker could not load: ${parsed.data.message}`));
      } else {
        failLoad(workerFailed("the text worker sent something other than ready while loading"));
      }
    });
    worker.on("messageerror", () => violate("the text worker sent a message that could not be deserialized (messageerror)"));
    worker.on("error", (error: Error) => {
      failure = error;
    });
    worker.on("exit", (code: number) => {
      entry.dead = true;
      if (live === entry) live = null;
      const error = workerFailed(`the text worker died (${failure !== null ? failure.message : `exit code ${code}`})`, failure ?? undefined);
      failLoad(error);
      entry.onDeath?.(error);
      markGone();
    });
    return entry;
  }

  /**
   * Terminates `entry` and returns once it has really exited. Idempotent, and never rejects: a terminate that does
   * not finish within `killTimeoutMs` (a wedged runtime), or that fails outright, is logged and makes the gate
   * BROKEN, so it refuses to spawn a worker beside one that may still be running.
   */
  function kill(entry: Live): Promise<void> {
    if (live === entry) live = null;
    if (entry.killing === null) {
      const killing = (async () => {
        // An already-exited worker is never asked to terminate: Bun's `terminate()` on one never settles.
        if (entry.dead) return;
        const killTimeoutMs = options.killTimeoutMs ?? TEXT_WORKER_KILL_TIMEOUT_MS;
        const bound = timeoutSignal(killTimeoutMs);
        try {
          await untilAborted(entry.worker.terminate().then(() => entry.gone), bound.signal);
        } catch (error) {
          const why = bound.signal.aborted ? `within ${killTimeoutMs} ms` : `(${error instanceof Error ? error.message : "unknown error"})`;
          broken = workerFailed(`the text worker could not be terminated ${why}; text rendering is broken until the engine restarts`);
          console.error(`studio engine: ${broken.message}`);
        } finally {
          bound.clear();
        }
      })();
      entry.killing = killing;
      pendingKills.add(killing);
      void killing.finally(() => pendingKills.delete(killing)).catch(() => {}); // `killing` never rejects
    }
    return entry.killing;
  }

  /** Kills an idle `entry` while holding the lane, so a call arriving meanwhile waits for it to be gone. */
  function killUnderLane(entry: Live): void {
    acquire(NEVER_ABORTED)
      .then(async (release) => {
        try {
          await kill(entry);
        } finally {
          release();
          scheduleIdleRecycle();
        }
      })
      .catch(laneRequestRejected);
  }

  /** The live worker, spawning and loading a fresh one when there is none. The load is bounded and abortable; a failed load leaves no worker behind. */
  async function liveWorker(signal: AbortSignal): Promise<Live> {
    if (broken !== null) throw broken;
    if (live !== null && !live.dead) return live;
    const entry = spawn();
    live = entry;
    const timeout = timeoutSignal(loadTimeoutMs);
    try {
      await untilAborted(untilAborted(entry.loaded, signal), timeout.signal);
      return entry;
    } catch (error) {
      await kill(entry);
      if (timeout.signal.aborted && !signal.aborted) throw workerFailed(`the text worker did not become ready within ${loadTimeoutMs} ms`);
      throw error;
    } finally {
      timeout.clear();
    }
  }

  /**
   * Runs `body` on the live worker, alone (the lane), under the deadline. Abort, the deadline, or any failure that
   * is not the worker's own clean report terminates the worker before this settles; a `fatal` report does too.
   */
  async function inLane<T>(signal: AbortSignal, body: (entry: Live) => Promise<Outcome<T>>, onStart?: () => void): Promise<T> {
    if (disposed) throw workerFailed("the text gate is disposed");
    if (broken !== null) throw broken;
    cancelIdleTimer();
    let release: () => void;
    try {
      release = await acquire(signal);
    } catch (error) {
      scheduleIdleRecycle();
      throw error;
    }
    try {
      signal.throwIfAborted();
      if (disposed) throw workerFailed("the text gate is disposed");
      onStart?.();
      const entry = await liveWorker(signal);
      const deadline = timeoutSignal(renderTimeoutMs);
      let outcome: Outcome<T>;
      try {
        outcome = await untilAborted(untilAborted(body(entry), signal), deadline.signal);
      } catch (error) {
        await kill(entry);
        if (deadline.signal.aborted && error === deadline.signal.reason && !signal.aborted) {
          throw new RasterError("RENDER_TIMEOUT", `the worker did not answer within ${renderTimeoutMs} ms and was terminated`);
        }
        throw error;
      } finally {
        deadline.clear();
      }
      if (!outcome.ok) {
        if (outcome.fatal) await kill(entry);
        throw outcome.error;
      }
      return outcome.value;
    } finally {
      release();
      scheduleIdleRecycle();
    }
  }

  /** Posts one request and waits for the response `pick` recognises as its own; anything else is a protocol violation (the caller kills the worker). */
  function request<T>(entry: Live, message: TextWorkerRequest, transfer: ArrayBuffer[], pick: (response: TextWorkerResponse) => T | undefined): Promise<Outcome<T>> {
    return new Promise<Outcome<T>>((resolve, reject) => {
      if (entry.dead) return reject(workerFailed("the text worker died before the request could be sent"));
      const settle = (): void => {
        entry.onMessage = null;
        entry.onDeath = null;
      };
      entry.onDeath = (error) => {
        settle();
        reject(error);
      };
      entry.onMessage = (raw) => {
        settle();
        const parsed = TextWorkerResponseSchema.safeParse(raw);
        if (!parsed.success) return reject(workerFailed("the text worker answered with something outside the protocol"));
        const response = parsed.data;
        if (response.type === "failed" && response.id === message.id) {
          const options = response.captionIssue === undefined ? undefined : { captionIssue: response.captionIssue };
          return resolve({ ok: false, error: new RasterError(response.code, response.message, options), fatal: response.fatal });
        }
        const value = pick(response);
        if (value === undefined) return reject(workerFailed(`the text worker sent an unexpected ${response.type} response`));
        resolve({ ok: true, value });
      };
      entry.worker.postMessage(message, transfer);
    });
  }

  return {
    isBroken: () => broken !== null,

    async start(signal: AbortSignal = NEVER_ABORTED): Promise<void> {
      await inLane(signal, async () => ({ ok: true, value: undefined }));
    },

    async render(input, signal = NEVER_ABORTED) {
      checkSize(input);
      const id = nextRequestId++;
      const message: TextWorkerRequest = { type: "render", id, svg: input.svg, font: input.font };
      return await inLane(signal, (entry) =>
        request(entry, message, [], (r) => (r.type === "rendered" && r.id === id ? { png: new Uint8Array(r.png), width: r.width, height: r.height, workerMs: r.workerMs } : undefined)),
      );
    },

    async measure(input, signal = NEVER_ABORTED) {
      checkSize(input);
      const id = nextRequestId++;
      const message: TextWorkerRequest = { type: "measure", id, svg: input.svg, font: input.font };
      return await inLane(signal, (entry) => request(entry, message, [], (r) => (r.type === "measured" && r.id === id ? { box: r.box } : undefined))).then((r) => r.box);
    },

    async caption(input, options = {}) {
      const message: TextWorkerRequest = { type: "caption", id: nextRequestId, value: input.value, font: input.font, style: input.style, color: input.color, scale: input.scale };
      // The worker parses what it is sent and DIES on a message outside its protocol, so a bad request never gets there.
      const checked = TextWorkerRequestSchema.safeParse(message);
      if (!checked.success) throw new RasterError("RENDER_FAILED", boundedMessage(`the caption request is invalid: ${checked.error.message}`));
      const id = nextRequestId++;
      return await inLane(
        options.signal ?? NEVER_ABORTED,
        (entry) =>
          request(entry, message, [], (r) =>
            r.type === "captioned" && r.id === id ? { png: new Uint8Array(r.png), width: r.width, height: r.height, layout: r.layout, workerMs: r.workerMs } : undefined,
          ),
        options.onStart,
      );
    },

    async dispose(): Promise<void> {
      disposed = true;
      cancelIdleTimer();
      for (const waiter of queue.splice(0)) waiter.reject(workerFailed("the text gate is disposed"));
      if (live !== null) await kill(live);
      await Promise.all([...pendingKills]);
    },
  };
}
