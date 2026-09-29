import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { cosTurns, Raster, sinTurns, type Contour, type Paint } from "./raster";
useNativeGlobals();

// The raster draws in a 0..100 design space onto a size x size pixel grid, so
// at size 100 one design unit is one pixel.
const SIZE = 100;
const red: Paint = { kind: "solid", rgb: [255, 0, 0] };
const rect = (x0: number, y0: number, x1: number, y1: number): Contour => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const px = (rgba: Uint8Array, x: number, y: number): number[] => Array.from(rgba.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));

describe("sinTurns and cosTurns", () => {
  test("agree with Math.sin and Math.cos to 1e-6 over several turns", () => {
    for (let k = -800; k <= 800; k++) {
      const t = k / 137;
      expect(Math.abs(sinTurns(t) - Math.sin(2 * Math.PI * t))).toBeLessThan(1e-6);
      expect(Math.abs(cosTurns(t) - Math.cos(2 * Math.PI * t))).toBeLessThan(1e-6);
    }
  });
  test("repeat after whole turns of the argument, to rounding", () => {
    for (const t of [0.1, 0.37, 0.5, 0.9]) expect(Math.abs(sinTurns(t + 3) - sinTurns(t))).toBeLessThan(1e-12);
  });
  test("hit the exact values at the quarter turns", () => {
    expect([sinTurns(0), sinTurns(0.25), sinTurns(0.5), sinTurns(0.75)].map((v) => Math.round(v * 1e8) / 1e8 + 0)).toEqual([0, 1, 0, -1]);
  });
});

describe("Raster.fill", () => {
  test("paints the inside of a pixel-aligned rectangle fully opaque in the paint's colour", () => {
    const r = new Raster(SIZE);
    r.fill([rect(10, 10, 30, 30)], red);
    expect(px(r.toRgba(), 20, 20)).toEqual([255, 0, 0, 255]);
  });
  test("leaves the outside of the shape fully transparent", () => {
    const r = new Raster(SIZE);
    r.fill([rect(10, 10, 30, 30)], red);
    expect(px(r.toRgba(), 40, 40)[3]).toBe(0);
  });
  test("gives an edge pixel half covered an alpha near 128", () => {
    const r = new Raster(SIZE);
    r.fill([rect(10.5, 10, 30, 30)], red);
    const a = px(r.toRgba(), 10, 20)[3] ?? 0;
    expect(Math.abs(a - 128)).toBeLessThanOrEqual(2);
  });
  test("gives a pixel a quarter covered in both axes an alpha near 64", () => {
    const r = new Raster(SIZE);
    r.fill([rect(10.5, 10.5, 30, 30)], red);
    const a = px(r.toRgba(), 10, 10)[3] ?? 0;
    expect(Math.abs(a - 64)).toBeLessThanOrEqual(3);
  });
  test("keeps the paint's colour at a partly covered edge (straight alpha)", () => {
    const r = new Raster(SIZE);
    r.fill([rect(10.5, 10, 30, 30)], red);
    expect(px(r.toRgba(), 10, 20).slice(0, 3)).toEqual([255, 0, 0]);
  });
  test("treats a second contour as a hole (even-odd)", () => {
    const r = new Raster(SIZE);
    r.fill([rect(10, 10, 50, 50), rect(20, 20, 40, 40)], red);
    const out = r.toRgba();
    expect(px(out, 15, 15)[3]).toBe(255);
    expect(px(out, 30, 30)[3]).toBe(0);
  });
  test("multiplies the paint's alpha into the coverage", () => {
    const r = new Raster(SIZE);
    r.fill([rect(10, 10, 30, 30)], { kind: "solid", rgb: [255, 0, 0], alpha: 0.5 });
    expect(px(r.toRgba(), 20, 20)[3]).toBe(128);
  });
  test("blends two half-transparent layers to three quarters alpha", () => {
    const r = new Raster(SIZE);
    const half: Paint = { kind: "solid", rgb: [0, 0, 255], alpha: 0.5 };
    r.fill([rect(10, 10, 30, 30)], half);
    r.fill([rect(10, 10, 30, 30)], half);
    expect(Math.abs((px(r.toRgba(), 20, 20)[3] ?? 0) - 191)).toBeLessThanOrEqual(1);
  });
  test("draws a later layer over an earlier one", () => {
    const r = new Raster(SIZE);
    r.fill([rect(10, 10, 30, 30)], red);
    r.fill([rect(10, 10, 30, 30)], { kind: "solid", rgb: [0, 255, 0] });
    expect(px(r.toRgba(), 20, 20)).toEqual([0, 255, 0, 255]);
  });
  test("interpolates a vertical gradient between its two colours", () => {
    const r = new Raster(SIZE);
    r.fill([rect(0, 0, 100, 100)], { kind: "vertical", y0: 0, y1: 100, from: [0, 0, 0], to: [200, 100, 50] });
    const out = r.toRgba();
    expect(px(out, 5, 0)[0]).toBeLessThan(3);
    expect(Math.abs((px(out, 5, 50)[0] ?? 0) - 100)).toBeLessThanOrEqual(2);
    expect(Math.abs((px(out, 5, 99)[0] ?? 0) - 200)).toBeLessThanOrEqual(3);
  });
  test("clips a shape that runs off the canvas without throwing", () => {
    const r = new Raster(SIZE);
    r.fill([rect(-50, -50, 150, 150)], red);
    expect(px(r.toRgba(), 0, 0)).toEqual([255, 0, 0, 255]);
  });
  test("ignores a degenerate contour", () => {
    const r = new Raster(SIZE);
    r.fill([[{ x: 5, y: 5 }, { x: 9, y: 9 }]], red);
    expect(r.toRgba().every((b) => b === 0)).toBe(true);
  });
  test("softness spreads the edge: an opaque core stays and the edge falls off over several pixels", () => {
    const r = new Raster(SIZE);
    r.fill([rect(30, 30, 70, 70)], red, 4);
    const out = r.toRgba();
    expect(px(out, 50, 50)[3]).toBe(255);
    const edge = [26, 28, 30, 32].map((x) => px(out, x, 50)[3] ?? 0);
    expect(edge).toEqual([...edge].sort((a, b) => a - b));
    expect(edge[0]).toBeGreaterThan(0);
    expect(edge[3]).toBeLessThan(255);
  });
});

describe("Raster.glow", () => {
  test("is strongest at its centre and gone at its radius", () => {
    const r = new Raster(SIZE);
    r.glow(50, 50, 30, [255, 200, 0], 0.8);
    const out = r.toRgba();
    expect(Math.abs((px(out, 50, 50)[3] ?? 0) - 204)).toBeLessThanOrEqual(2);
    expect(px(out, 85, 50)[3]).toBe(0);
  });
  test("falls off monotonically with distance", () => {
    const r = new Raster(SIZE);
    r.glow(50, 50, 40, [255, 200, 0], 1);
    const out = r.toRgba();
    const alphas = [50, 55, 60, 70, 80, 88].map((x) => px(out, x, 50)[3] ?? 0);
    expect(alphas).toEqual([...alphas].sort((a, b) => b - a));
  });
});

describe("Raster.toRgba", () => {
  test("is width * height * 4 bytes", () => {
    expect(new Raster(SIZE).toRgba().length).toBe(SIZE * SIZE * 4);
  });
  test("gives the same bytes for the same drawing, twice", () => {
    const draw = (): Uint8Array => {
      const r = new Raster(SIZE);
      r.glow(40, 40, 30, [255, 100, 0], 0.7);
      r.fill([rect(12.3, 8.8, 60.1, 70.7)], { kind: "vertical", y0: 8, y1: 70, from: [255, 0, 80], to: [80, 0, 255] }, 2);
      return r.toRgba();
    };
    expect(Buffer.compare(draw(), draw())).toBe(0);
  });
  test("gives a fully transparent pixel next to a coloured one that neighbour's colour, so scaling shows no dark halo", () => {
    const r = new Raster(SIZE);
    r.fill([rect(10, 10, 30, 30)], { kind: "solid", rgb: [200, 100, 50] });
    const out = r.toRgba();
    expect(px(out, 31, 20)).toEqual([200, 100, 50, 0]);
  });
  test("leaves a fully transparent pixel far from any colour black", () => {
    const r = new Raster(SIZE);
    r.fill([rect(10, 10, 30, 30)], red);
    expect(px(r.toRgba(), 90, 90)).toEqual([0, 0, 0, 0]);
  });
});
