import type { Focus, Motion } from "../engine/montage";
import { CANVAS_MAX_H, CANVAS_MAX_W, CANVAS_SCALE, KENBURNS_MAX_PERMILLE, KENBURNS_MIN_PERMILLE, PAN_ZOOM_PERMILLE } from "./constants";
import { coverCrop, resolveFocus } from "./crop";
import type { Rect, Size } from "./types";

// The motion model of a photo or collage clip (SP1's `zp4`): the cover-cropped
// photo is upscaled onto a "canvas" (4x, capped at 2880x5120), and `zoompan`
// moves a window over it. This module is that model as pure functions of
// (plan, canvas, anchor, frame, frames), so the graph builder (3a.5) and the
// preview (3d) compute the same window.
//
// The pieces:
// - `motionPlan`: WHAT moves and which way, from `seed` + the clip's id (never
//   its index: reordering clips must not flip a pan);
// - `cellMotionGeometry`: the crop, the canvas and the focus anchor of one cell;
// - `motionWindow`: the window on the canvas at one frame of the clip.
//
// The plan's fields ARE the zoompan parameters: zoom runs linearly from
// `zoomFromPermille` to `zoomToPermille` over the clip's frames; a pan moves
// the window linearly from one edge of the canvas to the other. `motionWindow`
// is the integer reference the builder's zoompan expressions are tested against.
//
// Rounding (pinned by tests): all maths is integer. Zoom is kept as an exact
// rational (per-mille, over `frames - 1` steps), the window size is
// `roundDiv(canvas / zoom)` and positions are `roundDiv(...)`, where roundDiv
// rounds HALF UP. Progress runs 0 on the first frame to 1 on the last
// (`frames - 1` steps; a one-frame clip is at its start).

export type PanDirection = "left" | "right" | "up" | "down";

export type MotionPlan =
  | { readonly kind: "static"; readonly zoomFromPermille: number; readonly zoomToPermille: number }
  | { readonly kind: "kenburns"; readonly direction: "in" | "out"; readonly zoomFromPermille: number; readonly zoomToPermille: number }
  | { readonly kind: "pan"; readonly direction: PanDirection; readonly zoomFromPermille: number; readonly zoomToPermille: number };

/** Where the focus sits inside the cover-cropped region, in per-mille (0 to 1000) of its width and height. */
export interface Anchor {
  readonly uPermille: number;
  readonly vPermille: number;
}

/** Everything the motion of one cell needs: the crop in the source, the upscaled canvas, and the focus anchor. */
export interface CellMotionGeometry {
  readonly crop: Rect;
  readonly canvas: Size;
  readonly anchor: Anchor;
}

const PAN_DIRECTIONS: readonly PanDirection[] = ["left", "right", "up", "down"];
const MAX_SEED = 4_294_967_295;

/** Murmur3's 32-bit finaliser: spreads every input bit over the whole word. */
function fmix32(input: number): number {
  let h = input >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A 32-bit hash of (seed, clip id): FNV-1a over the id's UTF-16 units, started from the mixed seed, then finalised. */
function hashSeedAndId(seed: number, clipId: string): number {
  let h = (0x811c9dc5 ^ fmix32(seed)) >>> 0;
  for (let i = 0; i < clipId.length; i++) {
    h ^= clipId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return fmix32(h);
}

/**
 * The motion of a clip: its kind is the clip's own `motion` field; the
 * direction (Ken Burns in or out, one of four pan ways) is derived from `seed`
 * and the clip's id. Deterministic, and independent of the clip's position.
 */
export function motionPlan(seed: number, clipId: string, motion: Motion): MotionPlan {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) throw new RangeError(`seed must be a uint32, got ${seed}`);
  const h = hashSeedAndId(seed, clipId);
  if (motion === "static") return { kind: "static", zoomFromPermille: 1000, zoomToPermille: 1000 };
  if (motion === "kenburns") {
    const zoomIn = (h & 1) === 0;
    return zoomIn
      ? { kind: "kenburns", direction: "in", zoomFromPermille: KENBURNS_MIN_PERMILLE, zoomToPermille: KENBURNS_MAX_PERMILLE }
      : { kind: "kenburns", direction: "out", zoomFromPermille: KENBURNS_MAX_PERMILLE, zoomToPermille: KENBURNS_MIN_PERMILLE };
  }
  const direction = PAN_DIRECTIONS[(h >>> 1) & 3] ?? "right";
  return { kind: "pan", direction, zoomFromPermille: PAN_ZOOM_PERMILLE, zoomToPermille: PAN_ZOOM_PERMILLE };
}

/** The plan of a clip as the spec stores it. An own video clip is always static. */
export function clipMotionPlan(
  seed: number,
  clip: { readonly kind: "video"; readonly clipId: string } | { readonly kind: "photo" | "collage"; readonly clipId: string; readonly motion: Motion },
): MotionPlan {
  return clip.kind === "video" ? motionPlan(seed, clip.clipId, "static") : motionPlan(seed, clip.clipId, clip.motion);
}

const evenFloor = (n: number): number => n - (n % 2);

/** Integer division rounded half up, for `a >= 0` and `b > 0`. */
const roundDiv = (a: number, b: number): number => Math.floor((2 * a + b) / (2 * b));

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function assertPositiveSize(size: Size, what: string): void {
  if (!Number.isSafeInteger(size.w) || !Number.isSafeInteger(size.h) || size.w < 1 || size.h < 1) {
    throw new RangeError(`${what} must be whole positive pixels, got ${size.w}x${size.h}`);
  }
}

/**
 * The upscaled canvas for a cover-cropped region: 4x its size, or, when that
 * would pass 2880x5120 (a large own photo), scaled down to fit that box with
 * the same aspect. Sides are ROUNDED DOWN to even numbers (4:2:0), at least 2.
 */
export function motionCanvas(crop: Size): Size {
  assertPositiveSize(crop, "crop");
  if (crop.w * CANVAS_SCALE <= CANVAS_MAX_W && crop.h * CANVAS_SCALE <= CANVAS_MAX_H) return { w: crop.w * CANVAS_SCALE, h: crop.h * CANVAS_SCALE };
  // Cross-multiplied comparison: the width is the limiting side when crop.w / CANVAS_MAX_W >= crop.h / CANVAS_MAX_H.
  const widthLimits = CANVAS_MAX_W * crop.h <= CANVAS_MAX_H * crop.w;
  const w = widthLimits ? CANVAS_MAX_W : Math.floor((CANVAS_MAX_H * crop.w) / crop.h);
  const h = widthLimits ? Math.floor((CANVAS_MAX_W * crop.h) / crop.w) : CANVAS_MAX_H;
  return { w: Math.max(2, evenFloor(w)), h: Math.max(2, evenFloor(h)) };
}

/** Where the focus sits inside `crop`, in per-mille, rounded to the nearest whole per-mille and kept inside 0..1000. */
export function focusAnchor(source: Size, crop: Rect, focus: Focus | null | undefined): Anchor {
  const f = resolveFocus(focus);
  const u = Math.round((1000 * (f.x * source.w - crop.x)) / crop.w);
  const v = Math.round((1000 * (f.y * source.h - crop.y)) / crop.h);
  return { uPermille: clamp(u, 0, 1000), vPermille: clamp(v, 0, 1000) };
}

/** The crop, canvas and anchor for a `cell`-sized area filled from `source` around `focus`. */
export function cellMotionGeometry(cell: Size, source: Size, focus: Focus | null | undefined): CellMotionGeometry {
  const crop = coverCrop(source, cell, focus);
  return { crop, canvas: motionCanvas({ w: crop.w, h: crop.h }), anchor: focusAnchor(source, crop, focus) };
}

/**
 * The window on the canvas (whole pixels, inside it) at clip-relative `frame`
 * of a clip that lasts `frames` frames (frame 0 is the clip's first).
 *
 * - static: the whole canvas;
 * - Ken Burns: the window shrinks (in) or grows (out) linearly in zoom and
 *   stays anchored at the focus: it keeps the focus at the same relative
 *   position in the window as in the canvas, so a corner focus hugs the corner;
 * - pan: a fixed window slides linearly from one edge of the canvas to the
 *   other along the plan's direction; on the other axis it sits on the focus.
 */
export function motionWindow(plan: MotionPlan, canvas: Size, anchor: Anchor, frame: number, frames: number): Rect {
  assertPositiveSize(canvas, "canvas");
  if (!Number.isSafeInteger(frames) || frames < 1) throw new RangeError(`frames must be a whole number of at least 1, got ${frames}`);
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frames) throw new RangeError(`frame must be 0..${frames - 1}, got ${frame}`);
  for (const v of [anchor.uPermille, anchor.vPermille]) {
    if (!Number.isSafeInteger(v) || v < 0 || v > 1000) throw new RangeError(`anchor must be whole per-mille in 0..1000, got ${v}`);
  }

  // Progress is `frame / last`, kept as an integer numerator over `last`.
  const last = Math.max(1, frames - 1);
  const zoomNum = plan.zoomFromPermille * last + (plan.zoomToPermille - plan.zoomFromPermille) * frame;
  const zoomDen = 1000 * last;
  const w = clamp(roundDiv(canvas.w * zoomDen, zoomNum), 1, canvas.w);
  const h = clamp(roundDiv(canvas.h * zoomDen, zoomNum), 1, canvas.h);
  const freeX = canvas.w - w;
  const freeY = canvas.h - h;

  let x = roundDiv(anchor.uPermille * freeX, 1000);
  let y = roundDiv(anchor.vPermille * freeY, 1000);
  if (plan.kind === "pan") {
    const forward = plan.direction === "right" || plan.direction === "down";
    const along = forward ? frame : last - frame;
    if (plan.direction === "left" || plan.direction === "right") x = roundDiv(freeX * along, last);
    else y = roundDiv(freeY * along, last);
  }
  return { x, y, w, h };
}
