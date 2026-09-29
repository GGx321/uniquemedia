import { FRAME_H, FRAME_W } from "./constants";
import type { Rect, Size } from "./types";

// Layer boxes: where a text or sticker layer sits on the 1080x1920 frame.
// Layers are anchored at their CENTRE: the contract's (x, y) is the centre as
// a fraction of the frame.
//
// - A STICKER's width is `size` (a fraction of the frame width); its height
//   follows the asset's aspect (default square). Both sides are rounded to the
//   nearest EVEN number.
// - A TEXT box's size is not in the contract: it is the size of the caption
//   raster the engine lays out and draws (slice 3b, with the layer's `scale`
//   already applied). 3b passes that raster size in; the box keeps it as is.
// - The top-left offset is `round(centre - side / 2)`, clamped so the box lies
//   inside the frame, then rounded DOWN to even, because the offsets feed
//   ffmpeg's `overlay` on 4:2:0 video.

/** The mockup's default text row: its centre is at y = 0.195 of the frame height (~374 px). */
export const DEFAULT_TEXT_Y = 0.195;
/** The mockup's default sticker: centre (0.741, 0.333), size 0.203 of the frame width. */
export const DEFAULT_STICKER = { x: 0.741, y: 0.333, size: 0.203 } as const;

const evenFloor = (n: number): number => n - (n % 2);
/** The nearest even number (half rounds up to the even number above). */
const evenRound = (n: number): number => 2 * Math.round(n / 2);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function assertFraction(v: number, what: string): void {
  if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`${what} must be a number in 0..1, got ${v}`);
}

/** The top-left offset of a box of `side` centred at `centre` on an axis of `length`, clamped inside and even. */
function offset(centre: number, side: number, length: number): number {
  return evenFloor(clamp(Math.round(centre - side / 2), 0, length - side));
}

/** A sticker layer's pixel box. `aspect` is the sticker asset's width:height (default square). */
export function stickerBox(layer: { readonly x: number; readonly y: number; readonly size: number }, aspect: Size = { w: 1, h: 1 }): Rect {
  assertFraction(layer.x, "x");
  assertFraction(layer.y, "y");
  if (!Number.isFinite(layer.size) || layer.size <= 0 || layer.size > 1) throw new RangeError(`size must be a number in (0, 1], got ${layer.size}`);
  if (!(aspect.w > 0) || !(aspect.h > 0) || !Number.isFinite(aspect.w) || !Number.isFinite(aspect.h)) throw new RangeError("aspect must be positive");
  const w = Math.min(FRAME_W, Math.max(2, evenRound(layer.size * FRAME_W)));
  const h = Math.min(FRAME_H, Math.max(2, evenRound((w * aspect.h) / aspect.w)));
  return { x: offset(layer.x * FRAME_W, w, FRAME_W), y: offset(layer.y * FRAME_H, h, FRAME_H), w, h };
}

/** A text layer's pixel box, given the size of the caption raster the engine drew for it. */
export function textBox(layer: { readonly x: number; readonly y: number }, raster: Size): Rect {
  assertFraction(layer.x, "x");
  assertFraction(layer.y, "y");
  if (!Number.isSafeInteger(raster.w) || !Number.isSafeInteger(raster.h) || raster.w < 1 || raster.h < 1) {
    throw new RangeError(`raster must be whole positive pixels, got ${raster.w}x${raster.h}`);
  }
  if (raster.w > FRAME_W || raster.h > FRAME_H) throw new RangeError(`raster ${raster.w}x${raster.h} does not fit the frame`);
  return { x: offset(layer.x * FRAME_W, raster.w, FRAME_W), y: offset(layer.y * FRAME_H, raster.h, FRAME_H), w: raster.w, h: raster.h };
}
