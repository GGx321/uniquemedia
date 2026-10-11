import { test, expect } from "bun:test";
import { sampleRecipe } from "./sampler";
import { EXPORT_DIMS, type ResolvedCopyOptions } from "./types";

const PACK = ["/pack/a.jpg", "/pack/b.jpg", "/pack/c.jpg", "/pack/d.jpg"];

const base: ResolvedCopyOptions = {
  strength: 1,
  exportFormat: "reels",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 38,
  identity: "engine",
  edgeMode: "auto",
  firstFrame: { mode: "off" },
};
const on: ResolvedCopyOptions = { ...base, frame: { backgrounds: PACK } };

test("frame off: the recipe carries no frame", () => {
  expect(sampleRecipe(base, 1, 1).frame).toBeUndefined();
});

test("frame on: the video is 90-95 percent of the canvas, whatever the seed or intensity", () => {
  const { w: W, h: H } = EXPORT_DIMS.reels;
  for (const intensity of [1, 2, 3]) {
    for (let seed = 0; seed < 300; seed++) {
      const f = sampleRecipe(on, seed, intensity).frame!;
      expect(f.w).toBeGreaterThanOrEqual(Math.floor(W * 0.9) - 2);
      expect(f.w).toBeLessThanOrEqual(Math.ceil(W * 0.95) + 2);
      expect(f.h).toBeGreaterThanOrEqual(Math.floor(H * 0.9) - 2);
      expect(f.h).toBeLessThanOrEqual(Math.ceil(H * 0.95) + 2);
    }
  }
});

test("frame on: the video never touches an edge, and every gap is at least a quarter of the free space", () => {
  const { w: W, h: H } = EXPORT_DIMS.reels;
  for (const intensity of [1, 2]) {
    for (let seed = 0; seed < 1000; seed++) {
      const f = sampleRecipe(on, seed, intensity).frame!;
      const freeX = W - f.w;
      const freeY = H - f.h;
      const gaps = [
        [f.x, freeX],
        [W - (f.x + f.w), freeX],
        [f.y, freeY],
        [H - (f.y + f.h), freeY],
      ];
      for (const [gap, free] of gaps) {
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeGreaterThanOrEqual(free / 4);
      }
    }
  }
});

test("frame on: the video sits inside the canvas, on even coordinates", () => {
  const { w: W, h: H } = EXPORT_DIMS.reels;
  for (let seed = 0; seed < 500; seed++) {
    const f = sampleRecipe(on, seed, 1).frame!;
    expect(f.x + f.w).toBeLessThanOrEqual(W);
    expect(f.y + f.h).toBeLessThanOrEqual(H);
    for (const v of [f.w, f.h, f.x, f.y]) expect(v % 2).toBe(0);
  }
});

test("frame on: keeps the canvas aspect, so the picture is only scaled", () => {
  const { w: W, h: H } = EXPORT_DIMS.reels;
  for (let seed = 0; seed < 100; seed++) {
    const f = sampleRecipe(on, seed, 1).frame!;
    expect(Math.abs(f.w / f.h - W / H)).toBeLessThan(0.01);
  }
});

test("frame on: the background is one of the pack, and every one gets used", () => {
  const used = new Set<string>();
  for (let seed = 0; seed < 200; seed++) {
    const f = sampleRecipe(on, seed, 1).frame!;
    expect(PACK).toContain(f.background);
    used.add(f.background);
  }
  expect(used.size).toBe(PACK.length);
});

test("frame on: size and offset vary between copies", () => {
  const sizes = new Set<number>();
  const xs = new Set<number>();
  for (let seed = 0; seed < 50; seed++) {
    const f = sampleRecipe(on, seed, 1).frame!;
    sizes.add(f.w);
    xs.add(f.x);
  }
  expect(sizes.size).toBeGreaterThan(10);
  expect(xs.size).toBeGreaterThan(10);
});

test("frame on: the same seed gives the same frame", () => {
  expect(sampleRecipe(on, 77, 1).frame).toEqual(sampleRecipe(on, 77, 1).frame);
});

test("frame on: every other draw is what it is with the frame off", () => {
  for (let seed = 0; seed < 20; seed++) {
    const a = sampleRecipe(base, seed, 1);
    const b = sampleRecipe(on, seed, 1);
    expect(b.video).toEqual(a.video);
    expect(b.segments).toEqual(a.segments);
    expect(b.audio).toEqual(a.audio);
  }
});

test("frame on with the original format puts the video on a reels canvas and fits it, uncropped", () => {
  const r = sampleRecipe({ ...on, exportFormat: "original" }, 5, 1);
  expect(r.exportFormat).toBe("reels");
  expect(r.frame!.fit).toBe(true);
});

test("frame on with a fixed export format keeps that format's crop", () => {
  for (const exportFormat of ["reels", "feed", "square"] as const) {
    const r = sampleRecipe({ ...on, exportFormat }, 5, 1);
    expect(r.exportFormat).toBe(exportFormat);
    expect(r.frame!.fit).toBe(false);
  }
});

test("frame on with an empty pack is refused rather than drawing from nothing", () => {
  expect(() => sampleRecipe({ ...base, frame: { backgrounds: [] } }, 1, 1)).toThrow(/фон/);
});
