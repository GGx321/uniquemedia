import { cosTurns, sinTurns, type Contour, type Pt } from "./raster";

// Shape builders for the sticker designs. Everything is in the raster's 0..100
// design space. A "local" contour is drawn around (0, 0) and placed with `place`.

/** Scales a local contour, rotates it by `turns` (clockwise on screen) and moves it to (tx, ty). */
export function place(local: Contour, tx: number, ty: number, sx: number, sy: number = sx, turns = 0): Contour {
  const c = cosTurns(turns);
  const s = sinTurns(turns);
  return local.map((p) => {
    const x = p.x * sx;
    const y = p.y * sy;
    return { x: tx + x * c - y * s, y: ty + x * s + y * c };
  });
}

/** A unit circle (radius 1) as a polygon fine enough for `radius` design units. */
export function unitCircle(radius: number): Contour {
  const n = Math.min(160, Math.max(32, Math.ceil(radius * 4) + 24));
  return Array.from({ length: n }, (_, i) => ({ x: cosTurns(i / n), y: sinTurns(i / n) }));
}

/** A circle at (cx, cy). */
export function circle(cx: number, cy: number, r: number): Contour {
  return place(unitCircle(r), cx, cy, r);
}

/** An ellipse at (cx, cy) with radii rx and ry, rotated by `turns`. */
export function ellipse(cx: number, cy: number, rx: number, ry: number, turns = 0): Contour {
  return place(unitCircle(Math.max(rx, ry)), cx, cy, rx, ry, turns);
}

/** A local star (outer radius 1, inner radius `inner`) with `points` points and one point straight up. */
export function unitStar(points: number, inner: number): Contour {
  const out: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 1 : inner;
    const a = i / (points * 2) - 0.25;
    out.push({ x: r * cosTurns(a), y: r * sinTurns(a) });
  }
  return out;
}

/** A local rectangle of half-width `hw` and half-height `hh`. */
export function unitRect(hw: number, hh: number): Contour {
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
}

export type CubicStep = readonly [c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number];

/** A closed local contour from a start point and cubic Bezier steps, each flattened into 16 segments. */
export function cubicShape(start: readonly [number, number], steps: readonly CubicStep[]): Contour {
  const out: Pt[] = [{ x: start[0], y: start[1] }];
  let px = start[0];
  let py = start[1];
  for (const [c1x, c1y, c2x, c2y, x, y] of steps) {
    for (let i = 1; i <= 16; i++) {
      const t = i / 16;
      const u = 1 - t;
      out.push({
        x: u * u * u * px + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
        y: u * u * u * py + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
      });
    }
    px = x;
    py = y;
  }
  // The last point repeats the start; the polygon closes itself.
  out.pop();
  return out;
}

export const frac = (x: number): number => x - Math.floor(x);

/** 0 -> 1 -> 0 over one period of `t`, smooth at both ends. */
export const beat = (t: number): number => 0.5 - 0.5 * cosTurns(t);

/** A small deterministic integer hash: the same `seed` always gives the same 32 bits. */
export function hash32(seed: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
