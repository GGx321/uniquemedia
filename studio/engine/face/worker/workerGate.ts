import type { Worker } from "node:worker_threads";
import { timeoutSignal, untilAborted } from "../../money/timeoutSignal";
import type { FacePose } from "../config";
import type { FaceBox } from "../largestFace";
import { NoFaceInReferenceError } from "../noFaceError";
import type { FaceVerdict } from "../verdict";
import { FaceWorkerRequestSchema, FaceWorkerResponseSchema, type FaceWorkerRequest, type FaceWorkerResponse } from "./protocol";

// T7c: the engine side of the face worker. The face gate's heavy work —
// image decode, YuNet, SFace — runs in ONE worker thread this module owns;
// the engine sends bytes and gets back a small, validated verdict or
// embedding, so its own event loop (commands, ledger fsyncs, progress
// events) never waits on WASM.
//
// Why a worker AND a kill switch. Synchronous WASM work cannot be
// interrupted from the thread it runs on, so neither a gate timeout nor a
// job's cancel could ever stop a pathological input — the old design could
// only abandon such a computation logically (T7b re-review, B1), leaving a
// "zombie" that kept burning CPU and could overlap the next check. Here the
// interruption is real: when the computation in flight is cancelled (or
// times out), the worker is TERMINATED, and the lane is released only once
// it has actually exited — so two computations can never overlap. The next
// check lazily spawns a fresh worker (~0.2 s to load; the models are read
// from the page cache).
//
// The lane is one computation at a time, FIFO within a class and with two
// classes (S4.P3). A run's work (check, embed, start, the gate's own kills)
// always goes before a focus detect: the autopilot draws and renders at once,
// and a run's check left waiting past its timeout is GateBroken — it stops the
// run and loses a paid image. At most `FACE_LANE_MAX_WAITING_DETECTS` detects
// wait at a time; one more is refused with `FaceLaneFullError` (its caller
// falls back or retries — a detect is never worth a queue). Nothing is ever
// preempted: a detect already running finishes first (bounded by one
// detection), and detects are not starved by an idle lane — they wait only
// while run work is waiting; a detect that still waits when its caller's
// bound expires leaves the queue by its signal. A detect also never holds the
// lane for long: its computation (worker load included) has its own bound,
// `FACE_DETECT_COMPUTE_TIMEOUT_MS`, after which the worker is terminated like
// any interrupted computation. A caller cancelled while still queued leaves the queue at once (removed by
// identity, so nothing behind it is disturbed — the T7b re-review's B1
// hazard cannot arise from a chained-promise design it no longer has) and
// never touches the worker that is busy for someone else.
//
// Failure classification is the one the in-thread gate had: a result the
// worker reports as a clean failure (`failed`) keeps the worker alive and
// surfaces as an ordinary Error (a decode failure, a broken model) — or
// `NoFaceInReferenceError` for the one expected failure, a master with no
// face. Everything else — a crash, an exit, a message outside the protocol,
// a load failure or timeout — kills the worker and rejects with an Error:
// systemic, never a per-photo retry, exactly like a broken in-thread gate
// (runJob.ts's checkFree reads any uncaught gate failure as GateBroken).

/** Below main's own 30 s command deadline (`engineHost.ts`'s REQUEST_TIMEOUT_MS), for the same reason `FACE_GATE_LOAD_TIMEOUT_MS` in main.ts is: a load must succeed or fail informatively before main gives up on it. */
export const FACE_WORKER_LOAD_TIMEOUT_MS = 25_000;

/** A terminate is milliseconds; this only bounds a worker that will not die (a wedged runtime), which the gate then refuses to live alongside. */
export const FACE_WORKER_KILL_TIMEOUT_MS = 5_000;

/**
 * How long a focus detect may HOLD the lane (from being granted it: the worker's load, if it must respawn, included), whatever its
 * caller's own bound. A run's face check waits at most `QA_GATE_TIMEOUT_MS` = 60 s (runs/qa.ts) and a timed-out check is GateBroken —
 * the run stops and a paid image is lost — while a prefetch may wait 120 s. Run checks go before waiting detects, so a check ever waits
 * behind ONE detect: at most this bound (10 s) + the kill (a terminate is milliseconds; at worst `FACE_WORKER_KILL_TIMEOUT_MS` = 5 s)
 * = 15 s before its own turn, which leaves 45 s of its 60 s for its own respawn (typically 0.2 s, at worst
 * `FACE_WORKER_LOAD_TIMEOUT_MS` = 25 s) and inference. A real YuNet detect of a 12 MP photo takes about a second.
 */
export const FACE_DETECT_COMPUTE_TIMEOUT_MS = 10_000;

export interface WorkerFaceGateOptions {
  /** Starts one worker thread. The engine's entry supplies `new Worker(<built faceWorker entry>, { workerData })`; tests supply a scripted one. */
  spawnWorker: () => Worker;
  /** How long a freshly spawned worker may take to report `ready`. `FACE_WORKER_LOAD_TIMEOUT_MS` unless a test overrides it. */
  loadTimeoutMs?: number;
  /**
   * Terminate the worker once it has been idle this long, giving its memory
   * back (the next check respawns one, ~0.2 s). onnxruntime-web's WASM heap
   * grows with the largest input it ever saw and never shrinks (T7b re-review,
   * N5) — measured on Electron's Node: ~340 MB just loaded, ~610 MB after
   * 2K checks and a 12 MP master, all returned by a terminate. Off unless set.
   */
  idleRecycleMs?: number;
  /** How long `worker.terminate()` may take before the gate gives up on the worker and declares itself broken. `FACE_WORKER_KILL_TIMEOUT_MS` unless a test overrides it. */
  killTimeoutMs?: number;
  /** How long a detect may hold the lane. `FACE_DETECT_COMPUTE_TIMEOUT_MS` unless a test overrides it. */
  detectComputeTimeoutMs?: number;
}

/** How many focus detects may wait for the lane at once (the one running does not count). */
export const FACE_LANE_MAX_WAITING_DETECTS = 2;

/** `detect` was refused because `FACE_LANE_MAX_WAITING_DETECTS` detects are already waiting for the lane. An answer to the caller ("not now"), never a fault of the gate or the worker. */
export class FaceLaneFullError extends Error {
  constructor() {
    super("the face lane already has its limit of detects waiting");
  }
}

/** What `detect` answers: the decoded source's size and its largest face (or none), both in source pixels. */
export interface FaceDetection {
  width: number;
  height: number;
  face: FaceBox | null;
}

export interface WorkerFaceGate {
  /** Spawns the worker and waits for it to load (the engine's preflight); a no-op when one is already live. Aborting `signal` terminates a load in progress. */
  start(signal?: AbortSignal): Promise<void>;
  /** Decodes `bytes` (JPEG/PNG), normalizes, detects, and — front/three-quarter with one prominent face — compares with `masterEmbedding`. `bytes` is copied, never transferred away from the caller. */
  check(input: { pose: FacePose; bytes: Uint8Array; masterEmbedding: Float32Array }, signal: AbortSignal): Promise<FaceVerdict>;
  /** The reference image's SFace embedding. Rejects with `NoFaceInReferenceError` when the worker finds no face. */
  embed(bytes: Uint8Array, signal: AbortSignal): Promise<Float32Array>;
  /**
   * S8 (focus): decodes `bytes`, normalises, runs YuNet only, and returns the
   * largest face's box in SOURCE-image pixels (`face: null` when there is none —
   * an answer, not an error) with the source's size. No pose, no embedding.
   * Same lane, bounds, cancellation and validation as `check`/`embed`, but the
   * lowest priority on it (S4.P3): run work goes first, and a detect arriving
   * while `FACE_LANE_MAX_WAITING_DETECTS` others wait rejects with
   * `FaceLaneFullError`. A failure to decode rejects with an ordinary Error
   * (the worker stays alive).
   */
  detect(bytes: Uint8Array, signal: AbortSignal): Promise<FaceDetection>;
  /** Terminates the worker for good; a computation in flight fails, and every later call rejects. */
  dispose(): Promise<void>;
  /** True once a worker could not be terminated: every later call fails with it until the engine restarts. Lets the engine refuse a run for free instead of finding out after the first paid image. */
  isBroken(): boolean;
}

/** A worker's answer to one request: a value, or a failure the worker itself reported (it stays alive after those). */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: Error };

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
  onDeath: ((error: Error) => void) | null;
}

/** "run": a run's check/embed, start-up, the gate's own kills. "detect": a focus detect, which always yields to run work. */
type Lane = "run" | "detect";

interface Waiter {
  readonly lane: Lane;
  grant(): void;
  reject(error: Error): void;
}

const NEVER_ABORTED = new AbortController().signal;

function describeDeath(failure: Error | null, code: number): string {
  return failure !== null ? failure.message : `exit code ${code}`;
}

export function createWorkerFaceGate(options: WorkerFaceGateOptions): WorkerFaceGate {
  const loadTimeoutMs = options.loadTimeoutMs ?? FACE_WORKER_LOAD_TIMEOUT_MS;
  let live: Live | null = null;
  let disposed = false;
  let nextRequestId = 0;
  /** Set once a worker would not terminate: every later call fails with it (GateBroken) rather than spawn a second worker beside one that may still be running. */
  let broken: Error | null = null;
  const pendingKills = new Set<Promise<void>>();

  // ---- the lane -----------------------------------------------------------
  let busy = false;
  const queue: Waiter[] = [];

  function acquire(signal: AbortSignal, lane: Lane): Promise<() => void> {
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
    if (lane === "detect" && queue.filter((waiting) => waiting.lane === "detect").length >= FACE_LANE_MAX_WAITING_DETECTS) {
      return Promise.reject(new FaceLaneFullError());
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      const waiter: Waiter = {
        lane,
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
      // Run work goes after the run work already waiting (FIFO) and before every waiting detect.
      const firstDetect = queue.findIndex((waiting) => waiting.lane === "detect");
      if (lane === "run" && firstDetect >= 0) queue.splice(firstDetect, 0, waiter);
      else queue.push(waiter);
    });
  }

  /** A background kill's lane request is rejected only when dispose() emptied the queue; dispose() kills the live worker itself, so there is nothing left to do but say so. */
  function laneRequestRejected(error: unknown): void {
    console.warn(`studio engine: a background face worker kill gave up its place in the lane (${error instanceof Error ? error.message : "unknown error"})`);
  }

  // ---- idle recycling -----------------------------------------------------
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }

  /** Arms the recycle when the lane is idle and a worker is live. The recycle itself takes the lane, so a check arriving mid-terminate waits for the worker to be gone before a new one starts. */
  function scheduleIdleRecycle(): void {
    cancelIdleTimer();
    const after = options.idleRecycleMs;
    if (after === undefined || disposed || busy || live === null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (busy || live === null) return;
      acquire(NEVER_ABORTED, "run")
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
    let failLoad: (error: Error) => void = () => {};
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

    /** The worker broke the contract (an unsolicited or undeserializable message): fail whoever is waiting on it, or — when nobody is — kill it under the lane so no second worker can overlap it. */
    const violate = (reason: string): void => {
      const error = new Error(reason);
      if (!ready) failLoad(error);
      else if (entry.onDeath !== null) entry.onDeath(error);
      else killUnderLane(entry);
    };

    worker.on("message", (raw: unknown) => {
      if (ready) {
        if (entry.onMessage !== null) entry.onMessage(raw);
        else violate("the face worker sent a message nobody asked for");
        return;
      }
      const parsed = FaceWorkerResponseSchema.safeParse(raw);
      if (parsed.success && parsed.data.type === "ready") {
        ready = true;
        markLoaded();
      } else if (parsed.success && parsed.data.type === "load-failed") {
        failLoad(new Error(`the face worker could not load: ${parsed.data.message}`));
      } else {
        failLoad(new Error("the face worker sent something other than ready while loading"));
      }
    });
    worker.on("messageerror", () => violate("the face worker sent a message that could not be deserialized (messageerror)"));
    worker.on("error", (error: Error) => {
      failure = error;
    });
    worker.on("exit", (code: number) => {
      entry.dead = true;
      if (live === entry) live = null;
      const error = new Error(`the face worker died (${describeDeath(failure, code)})`);
      failLoad(error);
      entry.onDeath?.(error);
      markGone();
    });
    return entry;
  }

  /**
   * Terminates `entry` and returns once it has really exited. Idempotent, and
   * never rejects: a terminate that does not finish within `killTimeoutMs`
   * (a wedged runtime), or that fails outright, is logged and makes the gate
   * BROKEN — every later call fails rather than spawn a worker beside one
   * that may still be running.
   */
  function kill(entry: Live): Promise<void> {
    if (live === entry) live = null;
    if (entry.killing === null) {
      const killing = (async () => {
        // An already-exited worker is never asked to terminate: Bun's own
        // `terminate()` on one never settles (Node's resolves), and there is
        // nothing left to stop anyway.
        if (entry.dead) return;
        const killTimeoutMs = options.killTimeoutMs ?? FACE_WORKER_KILL_TIMEOUT_MS;
        const bound = timeoutSignal(killTimeoutMs);
        try {
          await untilAborted(entry.worker.terminate().then(() => entry.gone), bound.signal);
        } catch (error) {
          const why = bound.signal.aborted ? `within ${killTimeoutMs} ms` : `(${error instanceof Error ? error.message : "unknown error"})`;
          broken = new Error(`the face worker could not be terminated ${why}; the face gate is broken until the engine restarts`);
          console.error(`studio engine: ${broken.message}`);
        } finally {
          bound.clear();
        }
      })();
      entry.killing = killing;
      pendingKills.add(killing);
      void killing.finally(() => pendingKills.delete(killing)).catch(() => {}); // `killing` never rejects; the catch keeps that from ever surfacing as unhandled
    }
    return entry.killing;
  }

  /** Kills an idle `entry` while holding the lane, so a check arriving meanwhile waits for it to be gone before a new worker starts. */
  function killUnderLane(entry: Live): void {
    acquire(NEVER_ABORTED, "run")
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

  /** The live worker, spawning and loading a fresh one when there is none. The load is bounded (`loadTimeoutMs`) and abortable; a failed load leaves no worker behind. */
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
      if (timeout.signal.aborted && !signal.aborted) throw new Error(`the face worker did not become ready within ${loadTimeoutMs} ms`);
      throw error;
    } finally {
      timeout.clear();
    }
  }

  /** Runs `body` on the live worker, alone (the lane), and interruptibly: abort — or any failure that is not the worker's own clean report — terminates the worker before this settles. */
  async function inLane<T>(lane: Lane, signal: AbortSignal, body: (entry: Live) => Promise<Outcome<T>>, computeMs?: number): Promise<T> {
    if (disposed) throw new Error("the face worker gate is disposed");
    if (broken !== null) throw broken;
    cancelIdleTimer();
    let release: () => void;
    try {
      release = await acquire(signal, lane);
    } catch (error) {
      scheduleIdleRecycle(); // cancelled while queued: whoever holds the lane re-arms it; when nobody does, re-arm here
      throw error;
    }
    // The compute bound starts when the lane is GRANTED, and covers the worker's load as well as the body.
    const compute = computeMs === undefined ? null : timeoutSignal(computeMs);
    const work = compute === null ? signal : AbortSignal.any([signal, compute.signal]);
    try {
      work.throwIfAborted();
      if (disposed) throw new Error("the face worker gate is disposed");
      const entry = await liveWorker(work);
      let outcome: Outcome<T>;
      try {
        outcome = await untilAborted(body(entry), work);
      } catch (error) {
        await kill(entry);
        throw error;
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } catch (error) {
      if (compute !== null && compute.signal.aborted && !signal.aborted) throw new Error(`the face worker did not finish the detect within ${computeMs} ms; it was terminated`);
      throw error;
    } finally {
      compute?.clear();
      release();
      scheduleIdleRecycle();
    }
  }

  /** Posts one request and waits for the response `pick` recognizes as its own; anything else is a protocol violation (the caller kills the worker). */
  function request<T>(entry: Live, message: FaceWorkerRequest, transfer: ArrayBuffer[], pick: (response: FaceWorkerResponse) => T | undefined): Promise<Outcome<T>> {
    return new Promise<Outcome<T>>((resolve, reject) => {
      if (entry.dead) return reject(new Error("the face worker died before the request could be sent"));
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
        const parsed = FaceWorkerResponseSchema.safeParse(raw);
        if (!parsed.success) return reject(new Error("the face worker answered with something outside the protocol"));
        const response = parsed.data;
        if (response.type === "failed" && response.id === message.id) {
          return resolve({ ok: false, error: response.code === "no-face-in-reference" ? new NoFaceInReferenceError() : new Error(response.message) });
        }
        const value = pick(response);
        if (value === undefined) return reject(new Error(`the face worker sent an unexpected ${response.type} response`));
        resolve({ ok: true, value });
      };
      entry.worker.postMessage(message, transfer);
    });
  }

  /** What crosses to the worker is a copy: the caller still needs its own bytes (to store the photo), and a transferred buffer would be detached. The copy itself is transferred, not cloned again. */
  function copyForTransfer(bytes: Uint8Array): ArrayBuffer {
    // Not `bytes.slice()`: on a Node/Bun `Buffer` that is a VIEW of the same
    // memory, and transferring it would detach the caller's own bytes.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  return {
    isBroken: () => broken !== null,

    async start(signal: AbortSignal = NEVER_ABORTED): Promise<void> {
      await inLane("run", signal, async () => ({ ok: true, value: undefined }));
    },

    async check(input, signal) {
      const id = nextRequestId++;
      const bytes = copyForTransfer(input.bytes);
      const message = FaceWorkerRequestSchema.parse({ type: "check", id, pose: input.pose, bytes, masterEmbedding: input.masterEmbedding });
      return await inLane("run", signal, (entry) => request(entry, message, [bytes], (r) => (r.type === "checked" && r.id === id ? r.verdict : undefined)));
    },

    async embed(bytes, signal) {
      const id = nextRequestId++;
      const copy = copyForTransfer(bytes);
      const message = FaceWorkerRequestSchema.parse({ type: "embed", id, bytes: copy });
      return await inLane("run", signal, (entry) => request(entry, message, [copy], (r) => (r.type === "embedded" && r.id === id ? r.embedding : undefined)));
    },

    async detect(bytes, signal) {
      // Nothing is copied or validated until the lane is granted: a detect that waits (or is refused) costs no memory.
      return await inLane(
        "detect",
        signal,
        (entry) => {
          const id = nextRequestId++;
          const copy = copyForTransfer(bytes);
          const parsed = FaceWorkerRequestSchema.safeParse({ type: "detect", id, bytes: copy });
          // A request the worker would never understand is the caller's failure, not the worker's: it must not cost the worker its life.
          if (!parsed.success) return Promise.resolve<Outcome<FaceDetection>>({ ok: false, error: new Error(`the detect request is invalid: ${parsed.error.message}`) });
          return request(entry, parsed.data, [copy], (r) => (r.type === "detected" && r.id === id ? { width: r.width, height: r.height, face: r.face } : undefined));
        },
        options.detectComputeTimeoutMs ?? FACE_DETECT_COMPUTE_TIMEOUT_MS,
      );
    },

    async dispose(): Promise<void> {
      disposed = true;
      cancelIdleTimer();
      for (const waiter of queue.splice(0)) waiter.reject(new Error("the face worker gate is disposed"));
      if (live !== null) await kill(live);
      await Promise.all([...pendingKills]);
    },
  };
}
