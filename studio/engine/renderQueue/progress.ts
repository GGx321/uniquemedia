/**
 * The share of a render job's progress range that pass 1 (the clips) takes;
 * pass 2 (the composite and the final encode) takes the rest. Chosen from
 * time, not from frames: on the dev machine (a 6 s two-clip render) pass 1's
 * near-lossless ultrafast clips took 2.3 s and pass 2's final encode 4.2 s,
 * so 35 / 65 (measured 35.0 / 65.0 over three runs). A bar that moves at the
 * speed of the work is worth more than an even split; the split is only about
 * looks, and nothing else depends on it.
 */
export const PASS1_SHARE_PERCENT = 35;

/**
 * Folds a render's two passes into one number: frames of the FINAL video,
 * `Σ durationMs × 3 / 100` in all. Each pass reports its own frame count
 * (pass 1: the frames of all its clips so far; pass 2: the frames of the
 * output so far), and the fold maps them into one range that
 * - never goes back (a smaller or repeated count adds nothing),
 * - never exceeds `total - 1`: the last frame belongs to the job's own end,
 *   when the file is verified and committed (the registry sets `done = total`
 *   only for a finished job).
 */
export class ProgressFold {
  readonly #total: number;
  /** Where pass 1's share ends, in frames of the final video. */
  readonly #pass1End: number;
  readonly #ceiling: number;
  #done = 0;

  constructor(totalFrames: number) {
    this.#total = totalFrames;
    this.#pass1End = Math.floor((totalFrames * PASS1_SHARE_PERCENT) / 100);
    this.#ceiling = Math.max(0, totalFrames - 1);
  }

  /** `frames` = the frames pass 1 has made in all its clips so far. The new `done`, or null when nothing moved. */
  pass1(frames: number): number | null {
    return this.#advance(Math.floor((this.#clamp(frames) * PASS1_SHARE_PERCENT) / 100));
  }

  /** `frames` = the frames pass 2 has written so far. The new `done`, or null when nothing moved. */
  pass2(frames: number): number | null {
    const made = this.#clamp(frames);
    if (made === 0) return null; // pass 2 has not made a frame: pass 1's end is not its own progress
    return this.#advance(this.#pass1End + Math.floor((made * (this.#total - this.#pass1End)) / this.#total));
  }

  #clamp(frames: number): number {
    if (!(frames > 0)) return 0; // negative, zero and NaN
    return Math.min(frames, this.#total);
  }

  #advance(candidate: number): number | null {
    const next = Math.min(this.#ceiling, candidate);
    if (next <= this.#done) return null;
    this.#done = next;
    return next;
  }
}

/**
 * How long the copies of a job's own videos may take (3f.3b): 60 s and the bytes at 5 MiB a second (a slow external disk under an antivirus). A copy that outlives it is
 * abandoned and the job ends TIMEOUT, so a read that never returns cannot hold a render slot for ever.
 */
export function stagingTimeoutMs(bytes: number): number {
  return 60_000 + Math.ceil(Math.max(0, bytes) / (5 * 1024 * 1024)) * 1000;
}

/**
 * A render job's whole timeout: `max(90 s, 30 × the video's seconds)`. At 30
 * fps `30 × frames / 30` seconds is just `frames` seconds, so a 15 s render
 * (450 frames) gets 450 s against 15.7 s measured (SP1).
 */
export function renderTimeoutMs(totalFrames: number): number {
  return Math.max(90_000, totalFrames * 1000);
}
