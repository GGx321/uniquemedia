import { FRAME_H, FRAME_W, GUTTER } from "./constants";
import type { Rect } from "./types";

// Collage cell rectangles at 1080x1920 with a 12 px black gutter. One layout
// per collage size, as in the mockup. Every x, y, width and height is EVEN,
// because the output is 4:2:0 and an odd crop or overlay offset would shift
// chroma by half a pixel.
//
// Rounding: sizes are integer divisions of the frame minus the gutters, and
// the one non-exact share (collage3's top row, 58% of the height left after
// the gutter) is rounded DOWN to an even number: (1920 - 12) * 58 / 100 =
// 1106.64, so 1106. The bottom row takes the rest (802).

export type CollageLayout = "collage2" | "collage3" | "collage4";

/** What is needed to know a clip's cells: its kind and, for a collage, its layout. Any contract `Clip` fits. */
export type CellClip = { readonly kind: "photo" | "video" } | { readonly kind: "collage"; readonly layout: CollageLayout };

/** Collage3's top row is this share of the height left after the gutter, in percent. */
const COLLAGE3_TOP_PERCENT = 58;

const evenFloor = (n: number): number => n - (n % 2);

const halfW = (FRAME_W - GUTTER) / 2; // 534
const halfH = (FRAME_H - GUTTER) / 2; // 954
const collage3Top = evenFloor(Math.floor(((FRAME_H - GUTTER) * COLLAGE3_TOP_PERCENT) / 100)); // 1106
const collage3Bottom = FRAME_H - GUTTER - collage3Top; // 802

/** The full 1080x1920 frame: the single cell of a photo or video clip. */
export const FULL_FRAME: Rect = { x: 0, y: 0, w: FRAME_W, h: FRAME_H };

const LAYOUT_RECTS: Record<CollageLayout, readonly Rect[]> = {
  collage2: [
    { x: 0, y: 0, w: FRAME_W, h: halfH },
    { x: 0, y: halfH + GUTTER, w: FRAME_W, h: halfH },
  ],
  collage3: [
    { x: 0, y: 0, w: FRAME_W, h: collage3Top },
    { x: 0, y: collage3Top + GUTTER, w: halfW, h: collage3Bottom },
    { x: halfW + GUTTER, y: collage3Top + GUTTER, w: halfW, h: collage3Bottom },
  ],
  collage4: [
    { x: 0, y: 0, w: halfW, h: halfH },
    { x: halfW + GUTTER, y: 0, w: halfW, h: halfH },
    { x: 0, y: halfH + GUTTER, w: halfW, h: halfH },
    { x: halfW + GUTTER, y: halfH + GUTTER, w: halfW, h: halfH },
  ],
};

/** The cells of a collage layout in reading order (left to right, top to bottom). A fresh array each call. */
export function collageRects(layout: CollageLayout): Rect[] {
  return LAYOUT_RECTS[layout].map((r) => ({ ...r }));
}

/** The cells of any clip: one full-frame cell for a photo or video, the layout's cells for a collage. */
export function clipCellRects(clip: CellClip): Rect[] {
  return clip.kind === "collage" ? collageRects(clip.layout) : [{ ...FULL_FRAME }];
}
