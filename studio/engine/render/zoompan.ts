import { FPS, type Anchor, type MotionPlan, type Size } from "../../shared/montage";
import { quoteExpression } from "./filterString";

// The `zoompan` of a moving clip, written from the SAME numbers `motionWindow`
// uses (the plan's per-mille zoom, the anchor, the pan direction), so the
// preview and the render agree.
//
// `motionWindow` is integer maths: the zoom is an exact rational, the window
// size is `roundDiv(canvas / zoom)`, positions are `roundDiv(...)`, rounding
// half up. The expressions below are that same maths in ffmpeg's expression
// language, where `floor((2a + b) / 2b)` is `roundDiv(a, b)` and is exact:
// the operands are whole numbers far below 2^53, and a quotient of two such
// numbers that is not a whole number stays farther from the next whole number
// than a double's rounding error.
//
// What ffmpeg does with them (SP1 and this task's pixel test):
// - the zoom `z` is one number for both axes, and the window is `trunc(iw /
//   z)` by `trunc(ih / z)`. `z` is the plan's exact zoom, so each side is
//   `motionWindow`'s rounded size or one less: within 1 canvas pixel;
// - `x` and `y` are whole numbers, exactly `motionWindow`'s. zoompan then
//   snaps them down to even for 4:2:0, which is the other pixel of slack.
//
// The measured deviation on real frames is in render.ffmpeg.test.ts.

/** A plan that moves: `static` clips take no `zoompan` (they are one scale and a `loop`). */
export type MovingMotionPlan = Exclude<MotionPlan, { readonly kind: "static" }>;

/** `constant + slope * variable`, written without a `+-`. */
function linear(constant: number, slope: number, variable: string): string {
  if (slope === 0) return `${constant}`;
  return slope > 0 ? `(${constant}+${slope}*${variable})` : `(${constant}-${-slope}*${variable})`;
}

/** `roundDiv(numerator, denominator)`, half up, both non-negative expressions: exact in ffmpeg's doubles. */
const roundDiv = (numerator: string, denominator: string): string => `floor((2*${numerator}+${denominator})/(2*${denominator}))`;

function assertWhole(value: number, min: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${what} must be a whole number of at least ${min}, got ${value}`);
}

/**
 * The `zoompan` filter for one cell: `canvas` is the upscaled cover-cropped
 * photo (`motionCanvas`), `anchor` the focus inside it, `frames` the clip's
 * length and `out` the cell's size. One input frame in, `frames` frames out.
 */
export function zoompanFilter(plan: MovingMotionPlan, canvas: Size, anchor: Anchor, frames: number, out: Size): string {
  assertWhole(frames, 1, "frames");
  assertWhole(canvas.w, 1, "canvas width");
  assertWhole(canvas.h, 1, "canvas height");
  assertWhole(out.w, 1, "output width");
  assertWhole(out.h, 1, "output height");
  for (const v of [anchor.uPermille, anchor.vPermille]) {
    if (!Number.isSafeInteger(v) || v < 0 || v > 1000) throw new RangeError(`anchor must be whole per-mille in 0..1000, got ${v}`);
  }

  // The progress `on / last`, kept as a whole numerator over `last` (a one-frame clip has `last` 1: it sits at its start).
  const last = Math.max(1, frames - 1);
  const denominator = 1000 * last;
  // The zoom as `numerator / denominator`, exact.
  const zoomNumerator = linear(plan.zoomFromPermille * last, plan.zoomToPermille - plan.zoomFromPermille, "on");
  const z = `${zoomNumerator}/${denominator}`;

  // `motionWindow`'s window size on each axis, and the room left to move in.
  const windowW = roundDiv(`iw*${denominator}`, zoomNumerator);
  const windowH = roundDiv(`ih*${denominator}`, zoomNumerator);
  const freeX = `(iw-${windowW})`;
  const freeY = `(ih-${windowH})`;

  // Anchored on the focus: keep its relative place in the window as in the canvas.
  let x = roundDiv(`${anchor.uPermille}*${freeX}`, "1000");
  let y = roundDiv(`${anchor.vPermille}*${freeY}`, "1000");
  if (plan.kind === "pan") {
    const forward = plan.direction === "right" || plan.direction === "down";
    const along = forward ? "on" : `(${last}-on)`;
    if (plan.direction === "left" || plan.direction === "right") x = roundDiv(`${freeX}*${along}`, `${last}`);
    else y = roundDiv(`${freeY}*${along}`, `${last}`);
  }

  return `zoompan=z=${quoteExpression(z)}:x=${quoteExpression(x)}:y=${quoteExpression(y)}:d=${frames}:s=${out.w}x${out.h}:fps=${FPS}`;
}
