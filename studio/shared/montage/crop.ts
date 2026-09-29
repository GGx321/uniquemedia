import type { Focus } from "../engine/montage";
import { FOCUS_FALLBACK } from "./constants";
import type { Rect, Size } from "./types";

// Cover-crop: which part of a source image fills a cell. The photo is scaled
// so it covers the cell, and the part that overflows is cut away around the
// focus point. The crop is expressed in SOURCE pixels, as whole numbers, so
// the graph builder can feed it straight to ffmpeg's `crop` and the preview
// can show the same region.
//
// EVEN: every side and offset is even. ffmpeg's `crop` on yuv420p rounds an
// odd size (and, without `exact=1`, an odd offset) to even on its own, so an
// odd result here would make the render cut a different region than the
// preview shows, and the canvas and anchor computed from it would be wrong.
//
// Rounding (pinned by tests):
// - the axis that overflows keeps its full source size, rounded DOWN to even;
//   the other side is `floor(that * cell ratio)`, rounded DOWN to even (at
//   least 2), so the crop never exceeds the source and its aspect is off by
//   under 2 source pixels;
// - the crop is centred on the focus with `Math.round` (half up), clamped into
//   the image, then rounded DOWN to an even offset;
// - a source side of 1 cannot be even: such a source is returned whole
//   (a 1 px photo is not a real input; the engine refuses it upstream).

const evenFloor = (n: number): number => n - (n % 2);

/** `value` rounded down to even, at least 2, and never above `cap` (a `cap` of 1 gives 1: it cannot be even). */
const evenSide = (value: number, cap: number): number => Math.min(cap, Math.max(2, evenFloor(value)));

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * The focus to use: the given one with each coordinate clamped into 0..1, or
 * the (0.5, 0.38) fallback for a missing focus (and for a coordinate that is
 * not a finite number).
 */
export function resolveFocus(focus: Focus | null | undefined): Focus {
  const axis = (v: number | undefined, fallback: number): number => (v === undefined || !Number.isFinite(v) ? fallback : clamp(v, 0, 1));
  return { x: axis(focus?.x, FOCUS_FALLBACK.x), y: axis(focus?.y, FOCUS_FALLBACK.y) };
}

function assertSize(size: Size, what: string): void {
  if (!Number.isSafeInteger(size.w) || !Number.isSafeInteger(size.h) || size.w < 1 || size.h < 1) {
    throw new RangeError(`${what} must be whole positive pixels, got ${size.w}x${size.h}`);
  }
}

/**
 * The part of `source` (in source pixels) that fills a `cell`-shaped area,
 * centred on `focus` and clamped so it stays inside the source.
 */
export function coverCrop(source: Size, cell: Size, focus: Focus | null | undefined): Rect {
  assertSize(source, "source");
  assertSize(cell, "cell");
  const f = resolveFocus(focus);

  // Compare aspects by cross-multiplying, so no division is involved: the
  // source is wider than the cell when source.w / source.h > cell.w / cell.h.
  const sourceIsWider = source.w * cell.h > cell.w * source.h;
  const w = sourceIsWider ? evenSide(Math.floor((evenSide(source.h, source.h) * cell.w) / cell.h), source.w) : evenSide(source.w, source.w);
  const h = sourceIsWider ? evenSide(source.h, source.h) : evenSide(Math.floor((evenSide(source.w, source.w) * cell.h) / cell.w), source.h);

  const x = evenFloor(clamp(Math.round(f.x * source.w - w / 2), 0, source.w - w));
  const y = evenFloor(clamp(Math.round(f.y * source.h - h / 2), 0, source.h - h));
  return { x, y, w, h };
}
