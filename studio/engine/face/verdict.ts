/**
 * The face gate's output. Matches the plan's contract literally
 * (`{ kind, similarity?, faces, headRatio? }`) while giving each `kind` only
 * the fields that make sense for it, so a caller destructuring on `kind`
 * gets a narrowed type instead of guessing which optional field is present.
 *
 * - `match` / `mismatch`: front or three-quarter, exactly one prominent face,
 *   identity compared against the configured strategy and threshold.
 * - `no-face`: no face at all.
 * - `multiple-faces`: more than one prominent face, any pose — checked before
 *   any pose-specific rule, since a crowded frame is never trustworthy.
 * - `skipped-by-pose`: profile (identity is never checked on a profile), or
 *   back with no reliably detected face (the expected case).
 * - `unexpected-face`: back, but a face was detected with good confidence —
 *   the model ignored the "from behind" instruction.
 */
export type FaceVerdict =
  | { kind: "match"; similarity: number; faces: number; headRatio: number }
  | { kind: "mismatch"; similarity: number; faces: number; headRatio: number }
  | { kind: "no-face"; faces: 0 }
  | { kind: "multiple-faces"; faces: number }
  | { kind: "skipped-by-pose"; faces: number }
  | { kind: "unexpected-face"; faces: number; headRatio: number };
