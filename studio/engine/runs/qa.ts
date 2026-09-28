import type { EngineError } from "../../shared/engine";
import type { FaceGateImage } from "../face";
import type { ImageMediaType, LibraryReference, PhotoQa, PhotoSidecar } from "../library";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import type { OpenRouterClient } from "../openrouter/types";
import type { PlanSlot } from "../scenes";

// T6 declares the QA gate; T7a (PDQ near-duplicates, the optional per-photo
// age check) and T7b (the face gate, studio/engine/face) implement it. The
// run job hands every paid image that passed its media checks to each gate
// in turn before the photo is stored: a free gate inside the run's CPU pool,
// a paid one inside the network pool (it sends a request).
//
// A verdict decides the slot:
// - pass: the photo is stored, its `qa` fields merged into the sidecar's
//   (PhotoQa: `pdq`, `faceCos`, `headRatio`, `age`);
// - retry: a clear failure (the face gate's no-face, multiple-faces,
//   unexpected-face or mismatch; a near-duplicate): the slot's next
//   pre-allocated attempt — it counts against the slot's limit of 3
//   (invariant 7), and an attempt on the one-attempt fallback is never
//   retried;
// - reject: the photo is dropped and the slot is not retried (the age
//   check's own rule: only a clear no, a refusal to judge or an unreadable
//   answer reject — see GateFailure below for everything else).
// A slot that ends through its gates ends with QA_REJECTED.
//
// A gate throws only when it cannot run at all (a missing model, a broken
// decoder), and a gate that outlives its `timeoutMs` is read the same way:
// the job then stops sending, since every later image would meet the same
// gate. An image the gate cannot judge for a reason specific to IT (a decode
// failure, e.g.) is a `retry`, not a throw.
//
// review (T7a whole-slice, finding 2/6): a paid gate whose own request fails
// for a reason that is NOT "this one photo looks doubtful" — a transient
// failure (rate limited, a network error, a 5xx after retries), a fatal one
// (an invalid key, insufficient credits), or its own reserve refused because
// the ledger is halted or the run's cap/the month has no room — must not be
// swallowed into a `reject` verdict: rejecting spends nothing more on THIS
// slot, but every OTHER slot's paid image would face the exact same
// unresolved problem and get quietly rejected too, one paid image at a time,
// instead of the run stopping the way an image attempt's own failure already
// does (T6 H1). A gate throws `GateFailure(error)` instead, carrying the T0
// `EngineError` classified the same way an image attempt's own failure is
// (`runs/failures.ts`'s `classifyFailure`, reused as-is): `BUDGET_EXCEEDED`
// and `RUN_CAP_EXCEEDED` leave the slot open for a resume without stopping
// other slots (mirroring `ctx.limited`); anything else stops the whole run
// with slots left open, its code preserved (`AUTH_INVALID` still marks the
// key rejected; `INSUFFICIENT_CREDITS`/a ledger halt still reach the UI
// unchanged, not collapsed to a bare INTERNAL).
//
// A gate must settle promptly once its `signal` aborts (the run's cancel, or
// its own timeout): stop its work and let the abort propagate — the job does
// not wait for it, and the gate's pool slot (CPU or network) is freed the
// moment the signal aborts — but a gate that keeps running after that still
// uses the CPU, or a request OpenRouter may bill, that no slot accounts for
// any more.
//
// An image that arrives after the user's cancel is still paid for, so it is
// kept when every gate is free: those gates run with a signal the cancel does
// not abort, bounded by a short timeout of their own instead. With any paid
// gate registered such an image is dropped: nothing is sent after a cancel.
//
// A paid gate (the age check) reserves through `budget` in the run's `scope`
// under an attempt id derived from `attemptId` (e.g. `${attemptId}:age`),
// at `priceBook`'s prices; the run's estimate already prices one age check
// per attempt when the image age check is on. After the run stopped sending
// (a fatal error, a cancel) a paid gate is never run: the image it would
// judge is dropped instead.
//
// review (T7a whole-slice, the architectural finding): a paid gate cannot
// hold an OpenRouter client, or the avatar's known photos, of its own — it is
// wired in once, before any run (and before the engine even has a key) ever
// exists. `QaInput` instead carries the run's OWN resources directly: `chat`
// (already bound to the run's key and reporting to the run's network pool,
// exactly like the run's own image client), `beforeSend` (the same
// just-before-send check an image attempt makes, T6 review L1 — a paid gate
// must forward it into its own paid call) and `photosByAvatar` (the run's own
// `RunLibrary`, so "the avatar's known photos" never fails open to an empty
// list because nothing was wired up yet).

/** The name the image age check's gate registers under; a run with the check on refuses to start without it (invariant 8). */
export const AGE_GATE_NAME = "age";

/** How long a gate may take before it is read as broken, unless it says otherwise. */
export const QA_GATE_TIMEOUT_MS = 60_000;

export interface QaInput {
  runId: string;
  /** The job the image's attempt belongs to: a paid gate reserves under it. */
  jobId: string;
  avatarId: string;
  /** The image attempt's own id: a paid gate derives its own attempt id from it. */
  attemptId: string;
  /** The run's cap scope: a paid gate reserves in it. */
  scope: Scope;
  /** The engine's one Budget, for a paid gate's reserve. */
  budget: Budget;
  /** The prices the run was started or resumed at. */
  priceBook: PriceBook;
  /** The plan's slot, carried whole (T5c adds `pose`, which the face gate reads). */
  slot: PlanSlot;
  image: { bytes: Uint8Array; mediaType: ImageMediaType; width: number; height: number };
  /** Aborts on the run's cancel or the gate's own timeout: a gate stops, and the image is dropped. */
  signal: AbortSignal;
  /**
   * The run's own `OpenRouterClient.chat`, already bound to the run's key and
   * reporting every response to the run's network pool (so a 429 from a
   * paid gate's own call shrinks the pool exactly like a 429 from an image
   * call would) — a paid gate calls this instead of holding a client of its
   * own, which it cannot: it is wired in before any run, or any key, exists.
   */
  chat: OpenRouterClient["chat"];
  /**
   * Mirrors `AttemptParams.beforeSend` (T6 review L1): asked right before a
   * paid gate's own request would leave. `false` means the run has already
   * stopped sending for some other reason since this gate's pool slot was
   * granted — the gate must pass this straight through to its own paid call
   * (never send if it answers false) rather than assume its own acquire
   * already proves the run is still sending.
   */
  beforeSend: () => boolean;
  /**
   * The avatar's already-stored photos, read fresh from the run's own
   * library on every call (its in-memory index already reflects a photo this
   * same run stored moments ago). A gate that needs to compare against known
   * photos (pdq) reads this instead of a dependency wired in at gate
   * construction time, which would have no way to reach the run's actual
   * library and would have to fail open to an empty list instead.
   */
  photosByAvatar: (avatarId: string) => readonly PhotoSidecar[];
  /**
   * T7b: the avatar's master portrait, the same encoded bytes `runJob.ts`'s
   * `loadMaster()` already loaded as the image attempt's own OpenRouter
   * reference — never a second read of the library. The face gate is the
   * only gate that needs it (its master embedding, computed once per
   * avatar and cached, is compared against every candidate's own face).
   */
  master: LibraryReference;
  /**
   * T7b's own decode decision: the engine's utilityProcess has no
   * `nativeImage` of its own (confirmed empirically — see the T7b wiring
   * notes in docs/studio/2026-09-24-stage-2-plan.md), and the runtime rule
   * (invariant 1) forbids importing `electron` from anywhere reachable from
   * the engine entry regardless. So decoding to the tagged RGBA/BGRA pixels
   * the face gate needs happens in the REAL main process (Electron's
   * `nativeImage`, the same decoder the spike's parity numbers were measured
   * against) and travels back over the engine↔main control channel
   * (control.ts's `EngineCall`/`MainReply`, `studio/main/imageDecode.ts`).
   * Only the face gate calls this today; every other gate's own decode
   * (pdq's 64x64 grayscale, the age gate's downscaled JPEG) stays on the
   * engine's own ffmpeg, which has no identity-precision requirement to
   * keep parity with.
   */
  decodeImage: (bytes: Uint8Array, signal: AbortSignal) => Promise<FaceGateImage>;
}

export type QaVerdict =
  | { verdict: "pass"; qa?: PhotoQa }
  | { verdict: "retry"; reason: string }
  | { verdict: "reject"; reason: string };

export interface QaGate {
  /** Short and fixed (e.g. "pdq", "face", "age"): it names the gate in the run's journal and errors. */
  readonly name: string;
  /** Whether `check` sends a paid request: it then runs in a network slot, and never after the run stopped sending. */
  readonly paid: boolean;
  /** QA_GATE_TIMEOUT_MS unless the gate needs longer (a paid gate: at least its own request's bound). */
  readonly timeoutMs?: number;
  check(input: QaInput): Promise<QaVerdict>;
  /**
   * Releases a provisional claim this gate made for one attempt (T7a's pdq
   * gate: a `pass` is not a commitment until the photo is actually stored —
   * a hash must never block a future image unless its photo was really
   * stored). `runJob.ts`'s `runGates` calls it, for every gate that already
   * passed, the moment a later gate in the same pipeline ends the attempt
   * without storing the photo. Optional: a gate with no claim to release (the
   * age gate, the face gate) simply never implements it.
   */
  releaseClaim?(avatarId: string, attemptId: string): void;
}

/**
 * Thrown by a paid gate's own `check()` for a failure that is not "this one
 * photo looks doubtful" — see this file's own header for the full reasoning.
 * `error` is a T0 `EngineError`, already classified (`runs/failures.ts`'s
 * `classifyFailure`, reused by the gate itself): `runJob.ts` reads its `code`
 * to decide whether this stops only the current slot (`BUDGET_EXCEEDED`,
 * `RUN_CAP_EXCEEDED` — the run's own `limit` outcome) or the whole run, and
 * preserves it unchanged in the run's own failure (so `AUTH_INVALID` still
 * marks the stored key rejected, and the UI still sees the real cause).
 */
export class GateFailure extends Error {
  readonly error: EngineError;

  constructor(error: EngineError) {
    super(error.detail ?? error.code);
    this.error = error;
  }
}
