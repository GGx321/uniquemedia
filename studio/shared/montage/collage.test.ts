import { describe, expect, test } from "bun:test";
import { COLLAGE_CELL_COUNT } from "../engine/montage";
import { clipCellRects, collageRects, FULL_FRAME, type CollageLayout } from "./collage";
import { FRAME_H, FRAME_W, GUTTER } from "./constants";

const LAYOUTS: CollageLayout[] = ["collage2", "collage3", "collage4"];

describe("collageRects: the exact layouts at 1080x1920 with a 12 px gutter", () => {
  test("collage2 is two 1080x954 cells, one above the other", () => {
    expect(collageRects("collage2")).toEqual([
      { x: 0, y: 0, w: 1080, h: 954 },
      { x: 0, y: 966, w: 1080, h: 954 },
    ]);
  });

  test("collage3 is a 1080x1106 top cell (58% of the frame) over two 534x802 cells", () => {
    expect(collageRects("collage3")).toEqual([
      { x: 0, y: 0, w: 1080, h: 1106 },
      { x: 0, y: 1118, w: 534, h: 802 },
      { x: 546, y: 1118, w: 534, h: 802 },
    ]);
  });

  test("collage4 is a 2x2 grid of 534x954 cells in reading order", () => {
    expect(collageRects("collage4")).toEqual([
      { x: 0, y: 0, w: 534, h: 954 },
      { x: 546, y: 0, w: 534, h: 954 },
      { x: 0, y: 966, w: 534, h: 954 },
      { x: 546, y: 966, w: 534, h: 954 },
    ]);
  });

  test("the full frame is 1080x1920 at the origin", () => {
    expect(FULL_FRAME).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
  });

  test("returns a fresh array each call, so a caller cannot corrupt the layout", () => {
    const first = collageRects("collage2");
    first.pop();
    expect(collageRects("collage2")).toHaveLength(2);
  });
});

describe.each(LAYOUTS)("%s geometry", (layout) => {
  const rects = collageRects(layout);

  test("has the layout's cell count", () => {
    expect(rects).toHaveLength(COLLAGE_CELL_COUNT[layout]);
  });

  test("every cell has even x, y, width and height (4:2:0 needs even sides)", () => {
    for (const r of rects) for (const v of [r.x, r.y, r.w, r.h]) expect(v % 2).toBe(0);
  });

  test("every cell lies inside the frame and is not empty", () => {
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(r.x + r.w).toBeLessThanOrEqual(FRAME_W);
      expect(r.y + r.h).toBeLessThanOrEqual(FRAME_H);
    }
  });

  test("no pixel belongs to two cells, and the only uncovered pixels are the gutters", () => {
    const seen = new Uint8Array(FRAME_W * FRAME_H);
    for (const r of rects) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) seen[y * FRAME_W + x] = (seen[y * FRAME_W + x] ?? 0) + 1;
    }
    let overlapping = 0;
    let uncovered = 0;
    for (const n of seen) {
      if (n > 1) overlapping++;
      if (n === 0) uncovered++;
    }
    expect(overlapping).toBe(0);
    // Sum of the gutter strips: a 12 px horizontal strip across the frame, plus the vertical strips between neighbours in a row.
    const expectedUncovered = { collage2: FRAME_W * GUTTER, collage3: FRAME_W * GUTTER + GUTTER * 802, collage4: FRAME_W * GUTTER + 2 * GUTTER * 954 }[layout];
    expect(uncovered).toBe(expectedUncovered);
  });

  test("cells that touch a neighbour are exactly one gutter (12 px) apart and the outer edges touch the frame", () => {
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    expect([minX, minY, maxX, maxY]).toEqual([0, 0, FRAME_W, FRAME_H]);
    rects.forEach((a, i) =>
      rects.forEach((b, j) => {
        if (i >= j) return;
        const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
        const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
        // Separated on at least one axis, never closer than the gutter.
        expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(GUTTER);
      }),
    );
  });
});

describe("clipCellRects", () => {
  test("a photo clip has one full-frame cell", () => {
    expect(clipCellRects({ kind: "photo" })).toEqual([FULL_FRAME]);
  });

  test("a video clip has one full-frame cell", () => {
    expect(clipCellRects({ kind: "video" })).toEqual([FULL_FRAME]);
  });

  test.each(LAYOUTS)("a %s clip gets that layout's cells", (layout) => {
    expect(clipCellRects({ kind: "collage", layout })).toEqual(collageRects(layout));
  });
});
