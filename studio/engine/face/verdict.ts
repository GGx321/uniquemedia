/**
 * The face gate's output. Matches the plan's contract literally
 * (`{ kind, similarity?, faces, headRatio? }`) while giving each `kind` only
 * the fields that make sense for it, so a caller destructuring on `kind`
 * gets a narrowed type instead of guessing which optional field is present.
 *
 * - `match` / `mismatch`: front or three-quarter, exactly one prominent face,
 *   identity compared against the configured strategy and threshold. Both
 *   carry `similarity` — OWNER DECISION (2c review): this is a hybrid gate,
 *   not a strict identity filter. `mismatch` only means "gross drift"
 *   (config.ts's default threshold, 0.55 — a different person or a broken
 *   generation); every `match`, however close its `similarity` sits to that
 *   floor, is kept and shown with its score as a badge in the Photos
 *   gallery, so the owner can judge borderline frames by eye instead of an
 *   automatic cutoff silently discarding a usable photo.
 * - `no-face`: no face at all.
 * - `multiple-faces`: more than one prominent face, any pose — checked before
 *   any pose-specific rule, since a crowded frame is never trustworthy.
 * - `skipped-by-pose`: profile (identity is never checked on a profile), or
 *   back with no reliably detected face (the expected case).
 * - `unexpected-face`: back, but a face was detected with good confidence —
 *   the model ignored the "from behind" instruction.
 *
 * Which verdicts the job queue (T6) auto-retries: exactly the four "clear
 * failure" kinds the owner named — `no-face`, `multiple-faces`,
 * `unexpected-face`, and `mismatch` — never `match` (kept as is) and never
 * `skipped-by-pose` (nothing to retry: identity was never meant to be
 * checked on this pose at all).
 */
export type FaceVerdict =
  | { kind: "match"; similarity: number; faces: number; headRatio: number }
  | { kind: "mismatch"; similarity: number; faces: number; headRatio: number }
  | { kind: "no-face"; faces: 0 }
  | { kind: "multiple-faces"; faces: number }
  | { kind: "skipped-by-pose"; faces: number }
  | { kind: "unexpected-face"; faces: number; headRatio: number };
