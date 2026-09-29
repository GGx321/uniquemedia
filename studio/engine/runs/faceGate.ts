import { createHash } from "node:crypto";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import type { PhotoQa } from "../library";
import { timeoutSignal } from "../money/timeoutSignal";
import type { QaGate, QaInput, QaPrepareInput, QaVerdict } from "./qa";

// T7b: the face gate's QaGate adapter. `studio/engine/face` (createFaceGate,
// runFaceGate, decideFaceVerdict) never decodes an image file and never
// learns about QaInput/QaVerdict — see face/index.ts's own header, which
// sketched this exact shape. This file is the only bridge: it decodes the
// candidate image by handing its bytes to the face worker thread (T7c;
// the worker decodes with the engine's own WASM decoder — security review,
// T7b section A) and maps the verdict onto the
// owner's hybrid policy (face/config.ts, face/policy.ts): a `match` or
// `skipped-by-pose` passes; every clear-failure kind the owner named
// (`no-face`, `multiple-faces`, `unexpected-face`, `mismatch`) retries —
// exactly the mapping face/verdict.ts's own header documents.
//
// Free (`paid: false`): the decode costs no money, and neither does the ONNX
// inference — both run in the face worker thread (T7c), off the engine's
// event loop, inside a slot of the run's CPU pool like the pdq gate. No `releaseClaim`: this gate makes no provisional claim of its
// own (nothing here is a resource another attempt could race for), so
// `runJob.ts`'s unconditional per-gate release is a harmless no-op for it,
// exactly like the age gate's.
//
// MONEY REVIEW H1 (the implementer's own earlier choice, corrected — this
// header used to attribute the old design to the owner; it was not): a
// master with no detectable face used to be discovered lazily, on the
// first candidate's own `check()` — AFTER that first image was already
// generated and paid for. `prepare()` (qa.ts's own `QaPrepareInput` has the
// full contract) now computes the master embedding EAGERLY, once per job,
// before the writer phase or any image is generated (`runJob.ts`'s
// `work()`) — a master with no usable face is discovered for free, and the
// job ends `MASTER_FACE_UNUSABLE` before a single request is sent.
//
// MONEY REVIEW M1/N1: `prepare()` is given `input.masterOriginal` — the
// avatar's ORIGINAL, undownscaled master file (`Library.
// loadMasterOriginal()`) — never `QaInput.master` (the ≤1024px reference
// downscaled for OpenRouter), which measurably drifts the embedding past
// this gate's own 0.001 parity budget.
//
// MONEY REVIEW H2: the master embedding is cached per avatarId, keyed
// together with the master bytes' own sha256 (never avatarId alone — a
// resume whose master somehow differs, or simply a defensive guard against
// a stale cache entry, gets a fresh embedding). Only a SUCCESSFUL embedding
// is kept: a rejected computation is evicted immediately, so a later
// attempt (a resume, after a transient decode failure) gets a fresh try
// rather than being stuck with a permanently poisoned cache for the rest of
// this engine process's life. The shared computation itself runs
// independent of any one caller's own abort signal — a caller that gives
// up waiting (its own timeout, the job stopping) never kills the
// computation for another caller (or a later job's `prepare()`) still
// waiting on the very same one; each caller instead races its own wait
// against its own signal (`abortableWait` below).
//
// A candidate image that cannot be decoded (the worker reports the failure) is,
// as of the security review's decode decision (section A.4), SYSTEMIC, not
// a per-photo `retry`: it propagates uncaught, exactly like a broken
// underlying worker `check`/`embed` — `runJob.ts`'s existing `checkFree`
// wrapper already reads any uncaught gate failure as GateBroken (or
// GateDropped, if the job was already cancelled). decode/wasmDecode.ts's
// own header has the full reasoning: these bytes already passed the pdq
// gate's own ffmpeg decode, so a WASM decode failure here means the
// decoder itself cannot handle this format/file, not that this one photo
// is bad — never something worth burning up to 3 paid attempts retrying.

export const FACE_GATE_NAME = "face";

export interface FaceQaGateDeps {
  /**
   * The real one: studio/engine/face/worker's `createWorkerFaceGate()` — the
   * face worker thread behind a FIFO lane (T7c). Only `check` and `embed`
   * are used — `start()`/`dispose()` are the wiring's own concern (main.ts),
   * not this adapter's.
   */
  faceGate: Pick<WorkerFaceGate, "check" | "embed" | "isBroken">;
  /**
   * Re-review N11: how long a master-embedding computation may stay cached
   * without settling before it is evicted — and, T7c, the bound of the
   * signal the computation itself runs against: at that point a real worker
   * is TERMINATED rather than left occupying the lane. `EMBEDDING_COMPUTE_TIMEOUT_MS`
   * unless a test overrides it.
   */
  embeddingComputeTimeoutMs?: number;
}

/**
 * Re-review N11: a master-embedding computation that never settles (a real
 * decode/ORT hang, not merely a caller giving up) used to stay cached
 * forever — `computeEmbedding`'s own eviction only ran on REJECTION
 * (`promise.catch(...)`), so a promise that neither resolves nor rejects
 * poisoned the avatarId+sha cache entry for the rest of this engine
 * process's life: every later job for this avatar (a resume, a brand new
 * run) would be handed the exact same hung promise and time out identically
 * — forever, not just once. This bounds how long an entry may sit
 * unsettled before it is evicted regardless, so a later job gets a fresh
 * attempt; the original hung computation is not cancelled (nothing here can
 * force that), it simply stops being trusted as the cache's own answer.
 */
export const EMBEDDING_COMPUTE_TIMEOUT_MS = 30_000;

/** L7: the photo schema caps faceCos at [-1, 1] (schemas.ts); a rounding-step overflow past either edge would otherwise throw in Library.addPhoto and stop the run. */
function clampCosine(similarity: number): number {
  return Math.min(1, Math.max(-1, similarity));
}

function qaOf(verdict: { kind: "match" | "mismatch"; similarity: number; headRatio: number }): PhotoQa {
  return { faceCos: clampCosine(verdict.similarity), headRatio: verdict.headRatio };
}

/** Waits for `promise` without affecting it: rejects early if `signal` aborts first, but the underlying computation (and any other caller waiting on it) keeps running either way. */
function abortableWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
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

interface CachedEmbedding {
  sha256: string;
  promise: Promise<Float32Array>;
}

// Re-review N5 (memory) and round 2's B1 used to live here as a FIFO mutex
// around decode + inference on the engine's own thread, with a "zombie"
// computation nothing could stop after a timeout. T7c moved all of it into
// the face worker's own gate (face/worker/workerGate.ts): one worker is one
// computation at a time, a waiter cancelled while queued leaves the queue by
// identity, and a cancel or timeout of the computation in flight TERMINATES
// the worker — the lane is released only once it is gone, so there is no
// zombie left to overlap the next check. Its tests carry the N5/B1 pins.

export function createFaceQaGate(deps: FaceQaGateDeps): QaGate {
  /** H2: one cached (possibly still-pending) embedding per avatarId, keyed together with the master bytes' sha256; only a successful result is kept. */
  const masterEmbeddings = new Map<string, CachedEmbedding>();

  function computeEmbedding(avatarId: string, masterOriginal: Uint8Array, sha256: string): Promise<Float32Array> {
    // Independent of any one caller's signal (H2): the computation runs
    // against its OWN bound only, so it completes (or really fails)
    // regardless of who is still waiting on it. T7c: that bound is a real
    // one — when it fires, the worker gate terminates the worker, so a hung
    // computation frees the lane instead of occupying it.
    const bound = timeoutSignal(deps.embeddingComputeTimeoutMs ?? EMBEDDING_COMPUTE_TIMEOUT_MS);
    const promise = deps.faceGate.embed(masterOriginal, bound.signal);
    promise.then(bound.clear, bound.clear);
    const entry: CachedEmbedding = { sha256, promise };
    masterEmbeddings.set(avatarId, entry);

    function evictIfStillThis(): void {
      // Evict only if this exact attempt is still the cached one — a newer
      // attempt (a different sha256, or a fresh computation already
      // replacing this one) must not be clobbered by a stale callback.
      const current = masterEmbeddings.get(avatarId);
      if (current === entry) masterEmbeddings.delete(avatarId);
    }
    promise.catch(evictIfStillThis);

    // N11: a computation that never settles must not poison the cache
    // forever — see EMBEDDING_COMPUTE_TIMEOUT_MS's own comment.
    const evictTimer = setTimeout(evictIfStillThis, deps.embeddingComputeTimeoutMs ?? EMBEDDING_COMPUTE_TIMEOUT_MS);
    promise.finally(() => clearTimeout(evictTimer)).catch(() => {}); // settled (either way) before the timer fired: no eviction needed from here.

    return promise;
  }

  function embeddingFor(input: QaPrepareInput): Promise<Float32Array> {
    const sha256 = createHash("sha256").update(input.masterOriginal).digest("hex");
    const cached = masterEmbeddings.get(input.avatarId);
    const promise = cached !== undefined && cached.sha256 === sha256 ? cached.promise : computeEmbedding(input.avatarId, input.masterOriginal, sha256);
    return abortableWait(promise, input.signal).then((value) => {
      // Round-2 verification, B2: N11's own eviction timer can fire while
      // this exact computation is still pending (a slow, not hung,
      // decode+embed — a job 1 cancelled mid-flight, a resume reusing the
      // same pending promise) and THEN the computation succeeds anyway —
      // this caller's own `prepare()` resolves correctly, but the cache
      // entry it was reading from is already gone, so a later `check()`
      // would find nothing (GateBroken, after a paid image). Re-install a
      // settled entry here, but only if the slot is still empty or still
      // holds this exact sha — never clobber a genuinely newer/different
      // preparation that has since taken over.
      //
      // T7c: with the worker gate this path is UNREACHABLE — the computation
      // runs against the same bound as the eviction timer
      // (`embeddingComputeTimeoutMs`), so a computation that outlives it is
      // terminated and rejects, never "succeeds anyway". It is kept as a
      // defence for a gate that ignores its signal (the unit test drives it
      // with exactly such a fake), and for the instant-race where the timer
      // fires as the result arrives.
      const current = masterEmbeddings.get(input.avatarId);
      if (current === undefined || current.sha256 === sha256) {
        masterEmbeddings.set(input.avatarId, { sha256, promise: Promise.resolve(value) });
      }
      return value;
    });
  }

  return {
    name: FACE_GATE_NAME,
    paid: false,

    available: () => !deps.faceGate.isBroken(),

    async prepare(input: QaPrepareInput): Promise<void> {
      // A broken worker gate fails every check, so a master whose embedding is already cached must not pass here and
      // then pay for a wave of images before the first check fails. The engine refuses earlier, for free
      // (`available()`, FACE_GATE_UNAVAILABLE); this is the same rule for a gate that breaks between that check and here.
      if (deps.faceGate.isBroken()) throw new Error("the face gate is broken (its worker could not be terminated); it stays broken until Studio restarts");
      // Propagates uncaught on failure (see this file's own header).
      // runJob.ts's prepareGates() classifies it, not this gate: only
      // NoFaceInReferenceError (a real, detectable "no face on the master")
      // becomes MASTER_FACE_UNUSABLE (N3); every other failure (a broken
      // decoder, a missing model, a master that fails to decode at all) is
      // systemic and becomes INTERNAL — or, since M1, gets one retry
      // against the OpenRouter reference before failing at all.
      await embeddingFor(input);
    },

    async check(input: QaInput): Promise<QaVerdict> {
      // N10: keyed by avatarId, but a cache entry is only trusted when its
      // own sha256 matches the masterSha256 THIS job's own prepareGates()
      // recorded — never whatever happens to be cached for the avatarId
      // right now, which could be a stale or differently keyed preparation
      // in this same long-lived engine process.
      const cached = masterEmbeddings.get(input.avatarId);
      if (cached === undefined || cached.sha256 !== input.masterSha256) {
        throw new Error(
          `faceGate: no master embedding prepared for avatar ${input.avatarId} matching this job's own master (sha ${input.masterSha256 ?? "null"}) — prepare() must run before check() with the same master (runJob.ts's own wiring bug, not a per-photo problem)`,
        );
      }
      const masterEmbedding = await abortableWait(cached.promise, input.signal);

      // Security review, section A.4: a failure — an undecodable image, a
      // dead worker — propagates uncaught, never a retry: see this file's
      // own header. The worker gate queues this behind any check already
      // running (FIFO) and terminates the worker if `input.signal` aborts
      // while it computes.
      const verdict = await deps.faceGate.check({ pose: input.slot.pose, bytes: input.image.bytes, masterEmbedding }, input.signal);
      switch (verdict.kind) {
        case "match":
          return { verdict: "pass", qa: qaOf(verdict) };
        case "skipped-by-pose":
          return { verdict: "pass" };
        case "mismatch":
          return { verdict: "retry", reason: `similarity ${verdict.similarity} is below the identity threshold (gross drift)` };
        case "no-face":
          return { verdict: "retry", reason: "no face was detected in the photo" };
        case "multiple-faces":
          return { verdict: "retry", reason: `${verdict.faces} prominent faces were detected` };
        case "unexpected-face":
          return { verdict: "retry", reason: `a face was detected on a shot posed from behind (headRatio ${verdict.headRatio})` };
      }
    },
  };
}
