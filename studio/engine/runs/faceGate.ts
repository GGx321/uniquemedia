import { createHash } from "node:crypto";
import type { FaceGate, FaceGateImage } from "../face";
import type { PhotoQa } from "../library";
import type { QaGate, QaInput, QaPrepareInput, QaVerdict } from "./qa";

// T7b: the face gate's QaGate adapter. `studio/engine/face` (createFaceGate,
// runFaceGate, decideFaceVerdict) never decodes an image file and never
// learns about QaInput/QaVerdict — see face/index.ts's own header, which
// sketched this exact shape. This file is the only bridge: it decodes the
// candidate image via `input.decodeImage` (the engine's own WASM decoder —
// security review, T7b section A) and maps `FaceGate`'s verdict onto the
// owner's hybrid policy (face/config.ts, face/policy.ts): a `match` or
// `skipped-by-pose` passes; every clear-failure kind the owner named
// (`no-face`, `multiple-faces`, `unexpected-face`, `mismatch`) retries —
// exactly the mapping face/verdict.ts's own header documents.
//
// Free (`paid: false`): the engine's own decode costs no money, and neither
// does the ONNX inference itself — both run in the run's CPU pool, like the
// pdq gate. No `releaseClaim`: this gate makes no provisional claim of its
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
// A candidate image that cannot be decoded (input.decodeImage rejects) is,
// as of the security review's decode decision (section A.4), SYSTEMIC, not
// a per-photo `retry`: it propagates uncaught, exactly like a broken
// underlying `FaceGate.check`/`embed` — `runJob.ts`'s existing `checkFree`
// wrapper already reads any uncaught gate failure as GateBroken (or
// GateDropped, if the job was already cancelled). decode/wasmDecode.ts's
// own header has the full reasoning: these bytes already passed the pdq
// gate's own ffmpeg decode, so a WASM decode failure here means the
// decoder itself cannot handle this format/file, not that this one photo
// is bad — never something worth burning up to 3 paid attempts retrying.

export const FACE_GATE_NAME = "face";

export interface FaceQaGateDeps {
  /** The real one: studio/engine/face's `createFaceGate()`. Only `check` and `embed` are used — `dispose()` is the wiring's own concern (main.ts), not this adapter's. */
  faceGate: Pick<FaceGate, "check" | "embed">;
  /** Re-review N11: how long a master-embedding computation may stay cached without settling before it is evicted. `EMBEDDING_COMPUTE_TIMEOUT_MS` unless a test overrides it. */
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

/**
 * Re-review N5 (memory): ORT's WASM heap grows with the largest input it
 * has ever seen and never shrinks — decoding and running inference for
 * several candidates at once (the run's own CPU pool lets several free
 * gates overlap) multiplies that peak by however many run concurrently.
 * Measured: +270 MB at 4.2 MP, +950 MB at 12 MP for ONE decode+inference;
 * several concurrent ones compound. Serializing every face check's own
 * decode+inference (never the master-embedding cache lookup, which is
 * cheap and already deduplicated by H2) bounds the peak to one at a time —
 * throughput is unaffected, since the ONNX WASM inference itself already
 * runs synchronously on this one event loop regardless of how many
 * `check()` calls are in flight; this only stops them queuing their own
 * decode+inference memory on top of each other.
 *
 * A plain FIFO mutex: each acquire is a promise chained onto the previous
 * holder's own release, so it costs nothing when uncontended. A caller
 * whose own signal aborts while WAITING rejects immediately, but re-review
 * round 2 (B1) found the FIRST version released its own queue slot right
 * then — which is the slot a LATER waiter is chained onto, so a cancelled
 * middle waiter let whoever was queued behind it acquire the lock while the
 * ORIGINAL holder was still running (repro: H holding, A queued then
 * cancelled, B queued behind A — `start H, start B, end B, end H`, two
 * holders at once). Fixed: an aborted waiter's own slot only resolves once
 * the holder it was ACTUALLY waiting on (`waitFor`) finishes, so whoever is
 * behind the cancelled waiter still queues on the real holder, never on the
 * cancellation itself.
 *
 * Once queued (still waiting for the lock, never once it holds it), a
 * caller's own signal aborting still rejects it and frees its own slot as
 * above. Once a caller HOLDS the lock, `body()` itself might hang forever
 * (a real decode/ORT deadlock, not merely this caller giving up) — B1's own
 * second finding: that would then block every later face check forever,
 * engine-wide. So the holder's own signal aborting also releases the lane
 * (like `CpuPool`'s own shape), accepting that `body()` keeps running as an
 * abandoned "zombie" computation in the background — nothing here can force
 * it to actually stop, the same limitation the master-embedding computation
 * itself already has (H2's own header).
 */
function createMutex(): <T>(signal: AbortSignal, body: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async function withLock<T>(signal: AbortSignal, body: () => Promise<T>): Promise<T> {
    const waitFor = tail;
    let release: () => void = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await abortableWait(waitFor, signal);
    } catch (error) {
      // Never acquired: our own slot must not resolve before the holder we
      // were actually waiting on (`waitFor`) does — otherwise whoever is
      // queued behind us would acquire the lock while that holder still runs.
      void waitFor.then(release);
      throw error;
    }
    // Holds the lock now. If our own signal aborts while `body()` is still
    // running, release the lane anyway (B1) — `body()` becomes a zombie,
    // still running in the background, but the CALLER stops waiting on it
    // (abortableWait) exactly like the master-embedding computation's own
    // zombie pattern above (H2's header) — never leaving a caller hung
    // forever on an abandoned computation just because it still holds no
    // lock any more.
    let releasedByAbort = false;
    const onHolderAbort = (): void => {
      releasedByAbort = true;
      release();
    };
    signal.addEventListener("abort", onHolderAbort, { once: true });
    try {
      const result = body();
      // If `signal` is already aborted (or aborts synchronously inside
      // body()'s own setup, before abortableWait can even register its own
      // listener), abortableWait's fast path abandons `result` without ever
      // observing it — a real rejection there would otherwise surface as an
      // unhandled promise rejection. Marked handled unconditionally, the
      // same defensive shape computeEmbedding's own zombie promise uses.
      result.catch(() => {});
      return await abortableWait(result, signal);
    } finally {
      signal.removeEventListener("abort", onHolderAbort);
      if (!releasedByAbort) release();
    }
  };
}

export function createFaceQaGate(deps: FaceQaGateDeps): QaGate {
  /** H2: one cached (possibly still-pending) embedding per avatarId, keyed together with the master bytes' sha256; only a successful result is kept. */
  const masterEmbeddings = new Map<string, CachedEmbedding>();
  const lock = createMutex();

  function computeEmbedding(avatarId: string, masterOriginal: Uint8Array, sha256: string, decodeImage: QaPrepareInput["decodeImage"]): Promise<Float32Array> {
    // Independent of any one caller's signal (H2): a fresh internal
    // controller that nothing here ever aborts, so the computation always
    // runs to completion (or a real failure) regardless of who is still
    // waiting on it.
    const internal = new AbortController();
    const promise = (async () => {
      const decoded = await decodeImage(masterOriginal, internal.signal);
      return deps.faceGate.embed(decoded);
    })();
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
    const promise = cached !== undefined && cached.sha256 === sha256 ? cached.promise : computeEmbedding(input.avatarId, input.masterOriginal, sha256, input.decodeImage);
    return abortableWait(promise, input.signal);
  }

  return {
    name: FACE_GATE_NAME,
    paid: false,

    async prepare(input: QaPrepareInput): Promise<void> {
      // Propagates uncaught on failure (see this file's own header): a
      // broken master, a broken decoder or a missing model are all "this
      // gate cannot run for this avatar/at all" — runJob.ts's work() reads
      // that as MASTER_FACE_UNUSABLE, before any paid work.
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

      return lock(input.signal, async () => {
        // Security review, section A.4: propagates uncaught, never a retry —
        // see this file's own header.
        const image: FaceGateImage = await input.decodeImage(input.image.bytes, input.signal);

        const verdict = await deps.faceGate.check({ pose: input.slot.pose, image, masterEmbedding });
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
      });
    },
  };
}
