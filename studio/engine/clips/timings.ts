// Stage 5, 5b.1, S5.V3b (plan s5b1 §5.15, critic M6): every duration of the clip money path in one object. The engine passes the REAL set; the engine tests, the parity rigs and the packaged
// smoke pass the SHORT set, so «proof 2 min → Grok», `late` and the holds run in milliseconds. The short set is the real one divided by a thousand, which keeps every ordering (15 s < 2 min
// < 20 min < 60 min stay in that order), so each story that passes on one passes on the other.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

export interface ClipTimings {
  /** How often a running attempt is polled (I5.48). */
  readonly pollMs: number;
  /** The first `/generation` read, after the terminal status: a video's record appears about 15 s after it completes (probe P-V), so an earlier 404 proves nothing. */
  readonly proofFirstReadMs: number;
  /** The second `/generation` read, together with the second `/credits` read (I5.47). */
  readonly proofSecondReadMs: number;
  /** The pause before a free read that came back unreadable is tried again. */
  readonly proofRetryMs: number;
  /** An attempt with no terminal status this long after its submit is abandoned and goes `late` (I5.48). */
  readonly lifetimeMs: number;
  /** How often a `late` clip is polled for its file. */
  readonly latePollMs: number;
  /** A `late` clip is given up on this long after its submit. */
  readonly lateGiveUpMs: number;
  /** The reconcile hold of an uncertain submit, and of a reserve with no `submitted` line (I5.48). */
  readonly holdUncertainMs: number;
  /** The reconcile hold after a terminal status. */
  readonly holdTerminalMs: number;
  /** The reconcile hold of a submitted job with no terminal status yet. */
  readonly holdSubmittedMs: number;
  /** An export shows its progress line only after this long (§5.13). */
  readonly exportProgressMs: number;
}

/** A free call (`/generation`, `/credits`) that comes back unreadable is read this many times before the money path stops trusting it (I5.47). */
export const PROOF_READ_TRIES = 3;

export const REAL_CLIP_TIMINGS: ClipTimings = Object.freeze({
  pollMs: 20 * SECOND,
  proofFirstReadMs: 15 * SECOND,
  proofSecondReadMs: 2 * MINUTE,
  proofRetryMs: 5 * SECOND,
  lifetimeMs: 20 * MINUTE,
  latePollMs: 60 * SECOND,
  lateGiveUpMs: 60 * MINUTE,
  holdUncertainMs: 20 * MINUTE,
  holdTerminalMs: 2 * MINUTE,
  holdSubmittedMs: 60 * MINUTE,
  exportProgressMs: 2 * SECOND,
});

export const SHORT_CLIP_TIMINGS: ClipTimings = Object.freeze({
  pollMs: REAL_CLIP_TIMINGS.pollMs / 1_000,
  proofFirstReadMs: REAL_CLIP_TIMINGS.proofFirstReadMs / 1_000,
  proofSecondReadMs: REAL_CLIP_TIMINGS.proofSecondReadMs / 1_000,
  proofRetryMs: REAL_CLIP_TIMINGS.proofRetryMs / 1_000,
  lifetimeMs: REAL_CLIP_TIMINGS.lifetimeMs / 1_000,
  latePollMs: REAL_CLIP_TIMINGS.latePollMs / 1_000,
  lateGiveUpMs: REAL_CLIP_TIMINGS.lateGiveUpMs / 1_000,
  holdUncertainMs: REAL_CLIP_TIMINGS.holdUncertainMs / 1_000,
  holdTerminalMs: REAL_CLIP_TIMINGS.holdTerminalMs / 1_000,
  holdSubmittedMs: REAL_CLIP_TIMINGS.holdSubmittedMs / 1_000,
  exportProgressMs: REAL_CLIP_TIMINGS.exportProgressMs / 1_000,
});

/**
 * The packaged smoke's set: the real one divided by twenty (a poll every second, the proof's readings at 0.75 s and 6 s, a lifetime of a minute). Not the short set: a lifetime of 1.2 s would turn a clip
 * the fake provider takes a moment over into `late` on a slow runner. Only an E2E build hands it to the engine (engine/main.ts, behind `STUDIO_E2E`); a production bundle is checked for its absence.
 */
export const E2E_CLIP_TIMINGS: ClipTimings = Object.freeze({
  pollMs: REAL_CLIP_TIMINGS.pollMs / 20,
  proofFirstReadMs: REAL_CLIP_TIMINGS.proofFirstReadMs / 20,
  proofSecondReadMs: REAL_CLIP_TIMINGS.proofSecondReadMs / 20,
  proofRetryMs: REAL_CLIP_TIMINGS.proofRetryMs / 20,
  lifetimeMs: REAL_CLIP_TIMINGS.lifetimeMs / 20,
  latePollMs: REAL_CLIP_TIMINGS.latePollMs / 20,
  lateGiveUpMs: REAL_CLIP_TIMINGS.lateGiveUpMs / 20,
  holdUncertainMs: REAL_CLIP_TIMINGS.holdUncertainMs / 20,
  holdTerminalMs: REAL_CLIP_TIMINGS.holdTerminalMs / 20,
  holdSubmittedMs: REAL_CLIP_TIMINGS.holdSubmittedMs / 20,
  exportProgressMs: REAL_CLIP_TIMINGS.exportProgressMs / 20,
});

/** The set the engine runs with (`EngineDeps.clipTimings` overrides it): real unless a test, a parity rig or the E2E smoke asks for a shorter one. */
export function clipTimings(set: "real" | "short" = "real"): ClipTimings {
  return set === "short" ? SHORT_CLIP_TIMINGS : REAL_CLIP_TIMINGS;
}
