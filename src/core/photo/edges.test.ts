import { test, expect } from "bun:test";
import { edgeBusyness, edgePadColor, shouldPreserveEdges } from "./edges";

const SIZE = 64;

/** Builds a 64x64 gray frame from a function of its coordinates. */
function frame(f: (x: number, y: number) => number): Uint8Array {
  const g = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) g[y * SIZE + x] = Math.max(0, Math.min(255, Math.round(f(x, y))));
  }
  return g;
}

const uniform = (level: number) => frame(() => level);
const gradient = () => frame((x) => (x / (SIZE - 1)) * 255);
const noisy = () => frame((x, y) => (Math.imul(y * SIZE + x + 1, 2654435761) >>> 24) & 0xff);
const halfAndHalf = () => frame((x) => (x < SIZE / 2 ? 0 : 255));

/**
 * The measured profile of the user's 1080x1920 story: a flat black background
 * with bright graphics running right up to the frame edge over a large minority
 * of the outer band. This is the case that MUST choose fit — padding a flat
 * background is invisible, cropping it eats a letter.
 */
const storyLike = () =>
  frame((x, y) => {
    const outer = x < 3 || x >= SIZE - 3 || y < 3 || y >= SIZE - 3;
    if (!outer) return 40 + ((x * 7 + y * 13) % 180); // busy picture in the middle
    return (x + y) % 5 === 0 ? 210 : 0; // 20% of the band is graphics, the rest is background
  });

/**
 * The measured profile of a photograph (the mandelbrot fixture): no dominant
 * edge colour, every band pixel a little different from its neighbours. This is
 * the case that MUST choose crop — a flat border would read as a border.
 */
const photoLike = () => frame((x, y) => 100 + (((x * 31 + y * 17) % 25) - 12));

/** Population standard deviation of the outer band, for the one test that
 *  exists to show why the implementation does NOT use it. */
function bandStdev(g: Uint8Array): number {
  const band: number[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x < 3 || x >= SIZE - 3 || y < 3 || y >= SIZE - 3) band.push(g[y * SIZE + x]);
    }
  }
  const mu = band.reduce((a, b) => a + b, 0) / band.length;
  return Math.sqrt(band.reduce((a, b) => a + (b - mu) ** 2, 0) / band.length);
}

test("a uniform frame has no edge busyness at all", () => {
  for (const level of [0, 1, 40, 128, 254, 255]) {
    expect(edgeBusyness(uniform(level))).toBe(0);
  }
});

test("a gradient across the frame reads as fully busy", () => {
  expect(edgeBusyness(gradient())).toBe(1);
});

test("a noisy frame reads as fully busy", () => {
  expect(edgeBusyness(noisy())).toBe(1);
});

test("a frame split down the middle reads as fully busy", () => {
  expect(edgeBusyness(halfAndHalf())).toBe(1);
});

test("busyness stays within 0..1 for every frame it is given", () => {
  for (const g of [uniform(0), uniform(255), gradient(), noisy(), halfAndHalf(), storyLike(), photoLike()]) {
    const b = edgeBusyness(g);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(1);
  }
});

test("only the outer band counts: a busy centre behind flat edges reads flat", () => {
  // The question the number answers is whether a border of one colour would be
  // noticed, and only pixels next to that border can answer it.
  const flatEdgeBusyCentre = frame((x, y) => {
    const outer = x < 3 || x >= SIZE - 3 || y < 3 || y >= SIZE - 3;
    return outer ? 12 : (Math.imul(y * SIZE + x + 1, 2654435761) >>> 24) & 0xff;
  });
  expect(edgeBusyness(flatEdgeBusyCentre)).toBe(0);
  expect(shouldPreserveEdges(flatEdgeBusyCentre)).toBe(true);
});

test("a flat edge with graphics on it still reads flat", () => {
  // The defining case. Graphics reaching the frame edge put a large minority of
  // bright pixels in the band, but the background is still one colour and a
  // border of it is still invisible.
  expect(shouldPreserveEdges(storyLike())).toBe(true);
});

test("a photograph's edge reads busy", () => {
  expect(shouldPreserveEdges(photoLike())).toBe(false);
});

/**
 * Why the statistic is a median absolute deviation and not a standard
 * deviation. Measured on the two real fixtures: the story (which must be
 * padded) scores stdev 45.7 and the mandelbrot photograph (which must be
 * cropped) scores 11.2 — the wrong way round, because a minority of bright
 * pixels dominates a squared-error statistic. Their MADs are 1 and 9, which is
 * the right way round. This test pins that inversion so the "obvious"
 * simplification cannot be made by accident.
 */
test("the chosen statistic survives a case where dispersion says the opposite", () => {
  const story = storyLike();
  const photo = photoLike();
  expect(bandStdev(story)).toBeGreaterThan(bandStdev(photo));
  expect(edgeBusyness(story)).toBeLessThan(edgeBusyness(photo));
  expect(shouldPreserveEdges(story)).toBe(true);
  expect(shouldPreserveEdges(photo)).toBe(false);
});

test("the decision threshold sits between the two real fixtures", () => {
  // Measured busyness: the story fixture 0.0625, the mandelbrot fixture 0.5625.
  // Both synthetic stand-ins must land on the same sides, with room to spare.
  expect(edgeBusyness(storyLike())).toBeLessThan(0.25);
  expect(edgeBusyness(photoLike())).toBeGreaterThan(0.25);
});

test("busyness rejects a frame that is not the 64x64 the pipeline extracts", () => {
  // Silently reading past the end would produce a confident number about
  // nothing. The buffer comes from an executor, so the size is worth checking.
  expect(() => edgeBusyness(new Uint8Array(1000))).toThrow();
  expect(() => shouldPreserveEdges(new Uint8Array(0))).toThrow();
});

/** 64x64 rgb24, built from a function of its coordinates. */
function rgbFrame(f: (x: number, y: number) => [number, number, number]): Uint8Array {
  const buf = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = f(x, y);
      buf[(y * SIZE + x) * 3] = r;
      buf[(y * SIZE + x) * 3 + 1] = g;
      buf[(y * SIZE + x) * 3 + 2] = b;
    }
  }
  return buf;
}

const inBand = (x: number, y: number) => x < 3 || y < 3 || x >= SIZE - 3 || y >= SIZE - 3;

test("the pad colour of a uniform frame is that colour", () => {
  expect(edgePadColor(rgbFrame(() => [0, 0, 0]))).toBe("0x000000");
  expect(edgePadColor(rgbFrame(() => [255, 255, 255]))).toBe("0xFFFFFF");
  expect(edgePadColor(rgbFrame(() => [26, 43, 60]))).toBe("0x1A2B3C");
});

test("the pad colour comes from the outer band, not the middle of the picture", () => {
  // Black is right for the user's story and wrong for a light background, so
  // the colour has to be read off the border the padding will sit next to.
  const paleEdgeDarkCentre = rgbFrame((x, y) => (inBand(x, y) ? [240, 240, 240] : [0, 0, 0]));
  expect(edgePadColor(paleEdgeDarkCentre)).toBe("0xF0F0F0");
});

test("a minority of bright marks on the band does not move the pad colour", () => {
  // Same reason the busyness statistic is a median: graphics touching the edge
  // are the minority, and the padding has to match what is behind them. This is
  // why the colour is not sampled at 8x8 as first proposed — measured on the
  // story fixture, an 8x8 ring pixel averages 135 px of graphics into the
  // background and returns 0x261F0E, a dark olive, where 64x64 returns
  // 0x010101. A visible olive border is the defect this whole mode exists to
  // avoid, so the resolution has to be fine enough for the median to find
  // uncontaminated background.
  const flatWithMarks = rgbFrame((x, y) => {
    if (!inBand(x, y)) return [90, 90, 90];
    return (x + y) % 4 === 0 ? [255, 250, 10] : [8, 8, 8];
  });
  expect(edgePadColor(flatWithMarks)).toBe("0x080808");
});

test("the pad colour is the whole band's, not one edge's", () => {
  // A sky at the top and a dark border on the other three sides: the padding
  // goes on all four, so one edge must not decide for the rest.
  const brightTop = rgbFrame((x, y) => {
    if (!inBand(x, y)) return [70, 70, 70];
    return y < 3 ? [200, 200, 200] : [10, 10, 10];
  });
  expect(edgePadColor(brightTop)).toBe("0x0A0A0A");
});

test("the pad colour is an ffmpeg colour literal", () => {
  expect(edgePadColor(rgbFrame((x) => [(x * 4) % 256, 255 - ((x * 4) % 256), 128]))).toMatch(
    /^0x[0-9A-F]{6}$/
  );
});

test("the pad colour rejects a buffer that is not the 64x64 rgb24 it expects", () => {
  expect(() => edgePadColor(new Uint8Array(192))).toThrow();
});
