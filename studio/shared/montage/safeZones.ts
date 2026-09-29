import { FRAME_H, FRAME_W } from "./constants";
import type { Rect } from "./types";

// «Зоны Reels»: the parts of the frame Instagram's own UI covers, from the
// mockup. Preview-only: the render never draws them. All integer maths: each
// percentage is applied as `floor(length * percent / 100)`, exact for these
// values on 1080x1920.

/** The bottom strip: the caption and buttons cover the lowest 20% of the height. */
export const SAFE_BOTTOM_PERCENT = 20;
/** The right strip: the action buttons cover the rightmost 15% of the width... */
export const SAFE_RIGHT_PERCENT = 15;
/** ...from 40% of the height... */
export const SAFE_RIGHT_FROM_PERCENT = 40;
/** ...to 80% of the height. */
export const SAFE_RIGHT_TO_PERCENT = 80;

export interface SafeZone {
  readonly id: "top" | "bottom" | "right";
  readonly rect: Rect;
}

const pct = (length: number, percent: number): number => Math.floor((length * percent) / 100);

/**
 * The zones as pixel rectangles, top (only when asked for), bottom, right.
 * Instagram's top band is not in the mockup; the designer may ask for one, as
 * `topPercent` of the height (a whole number, 0 to 100; 0 adds none).
 */
export function reelsSafeZones(options: { readonly topPercent?: number } = {}): SafeZone[] {
  const topPercent = options.topPercent ?? 0;
  if (!Number.isInteger(topPercent) || topPercent < 0 || topPercent > 100) throw new RangeError(`topPercent must be a whole number in 0..100, got ${topPercent}`);
  const zones: SafeZone[] = [];
  if (topPercent > 0) zones.push({ id: "top", rect: { x: 0, y: 0, w: FRAME_W, h: pct(FRAME_H, topPercent) } });
  const bottomH = pct(FRAME_H, SAFE_BOTTOM_PERCENT);
  zones.push({ id: "bottom", rect: { x: 0, y: FRAME_H - bottomH, w: FRAME_W, h: bottomH } });
  const rightW = pct(FRAME_W, SAFE_RIGHT_PERCENT);
  const rightFrom = pct(FRAME_H, SAFE_RIGHT_FROM_PERCENT);
  zones.push({ id: "right", rect: { x: FRAME_W - rightW, y: rightFrom, w: rightW, h: pct(FRAME_H, SAFE_RIGHT_TO_PERCENT) - rightFrom } });
  return zones;
}

/** The zones a box overlaps by at least one pixel; touching an edge is not a hit. */
export function zonesHit(box: Rect, zones: readonly SafeZone[]): SafeZone[] {
  return zones.filter(({ rect }) => box.x < rect.x + rect.w && rect.x < box.x + box.w && box.y < rect.y + rect.h && rect.y < box.y + box.h);
}
