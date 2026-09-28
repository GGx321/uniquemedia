import type { ImageMediaType, PhotoQa } from "../library";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
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
//   check's own rule: any doubt → rejected, never re-rolled).
// A slot that ends through its gates ends with QA_REJECTED.
//
// A gate throws only when it cannot run at all (a missing model, a broken
// decoder), and a gate that outlives its `timeoutMs` is read the same way:
// the job then stops sending, since every later image would meet the same
// gate. An image the gate cannot judge is a `retry`, not a throw.
//
// A gate must settle promptly once its `signal` aborts (the run's cancel, or
// its own timeout): stop its work, abort its own request, and reject. The
// job does not wait for it — the verdict is dropped and the gate's pool slot
// (CPU or network) is freed the moment the signal aborts — but a gate that
// keeps running after that still uses the CPU, or a request OpenRouter may
// bill, that no slot accounts for any more.
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
}

/**
 * An additive, optional extension of QaGate (not a change to the contract
 * above): a gate whose own `pass` is provisional, not a commitment — T7a's
 * pdq gate claims a hash on `pass` so a second, concurrent near-duplicate
 * cannot also pass before either is stored, but that claim must not outlive
 * the attempt if a *later* gate then retries or rejects the same photo (a
 * hash must never block a future image unless its photo was really stored).
 * `runJob.ts`'s `runGates` calls `releaseClaim` for every gate that already
 * passed, the moment a later gate in the same pipeline ends the attempt
 * without storing the photo — duck-typed (`"releaseClaim" in gate`), so a
 * gate that has no claim to release (the age gate, the face gate) simply
 * never implements this and is never asked.
 */
export interface ReleasableGate {
  releaseClaim(avatarId: string, attemptId: string): void;
}

/** Whether `gate` implements `ReleasableGate`; null when it does not, so a caller never needs its own cast. */
export function releasable(gate: QaGate): (QaGate & ReleasableGate) | null {
  if (!("releaseClaim" in gate) || typeof gate.releaseClaim !== "function") return null;
  // Verified above at runtime: `gate` really does carry a `releaseClaim` of the right shape.
  return gate as QaGate & ReleasableGate;
}
