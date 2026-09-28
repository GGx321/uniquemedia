// T7a (merging soon) adds an always-on PDQ near-duplicate QA gate to photo
// runs: any pair of images whose PDQ hash sits within 20 of 256 bits is read
// as a duplicate and retried (src/core/pdq). PDQ's hash comes from the SIGN
// of each kept low-frequency 2D-DCT coefficient (src/core/pdq/pdq.ts's
// computePdqHash) — a uniform image (one solid colour) has a flat DCT, so
// every coefficient sits at the same median and the hash is the same for
// every such image, however different their hue: PDQ compares luminance
// structure, not colour. Every fake image T6's kill-and-resume scenario
// feeds a photo run must therefore differ in luminance structure.
//
// This module is the one place that structure is generated, so
// studio/scripts/mockOpenRouter.ts (a real served image, via grayscalePng.ts)
// and studio/scripts/distinctPattern.test.ts (the proof, hashed directly with
// src/core/pdq) always agree on exactly the same pattern math.
//
// Two families, chosen because a few large regions is squarely a LOW spatial
// frequency — inside PDQ's kept 16x16 DCT band, unlike a fine-grained
// pattern, which would alias away under PDQ's own 64x64 downscale the same
// way a solid colour does: a checkerboard of a few large blocks, and stripes
// at a rotated angle. Every parameter is a plain number `patternFor` bakes in
// once (including the trig), so no caller needs its own.

export interface CheckerboardPattern {
  readonly family: "checkerboard";
  readonly blocksX: number;
  readonly blocksY: number;
  readonly light: number;
  readonly dark: number;
}

export interface StripesPattern {
  readonly family: "stripes";
  /** A unit direction (cosA, sinA), precomputed once so no caller needs its own trig. */
  readonly cosA: number;
  readonly sinA: number;
  /** Full light+dark cycles across the image's longer side. */
  readonly cycles: number;
  readonly light: number;
  readonly dark: number;
}

export type PoolPattern = CheckerboardPattern | StripesPattern;

/**
 * Kept far from zero so `floor()`'s sign convention (positive vs negative
 * input) never enters into it, whatever renders this pattern: every pixel
 * projection a realistic image size can produce stays comfortably positive.
 */
const PROJECTION_OFFSET = 10_000;

/**
 * Every pool index gets its own pattern: even indices a checkerboard (block
 * counts step with the index, up to 6x6 — 36 combinations before any would
 * repeat), odd indices stripes (the angle steps by a prime-ish 37°, so it
 * wraps slowly, and the cycle count varies too). 48 indices never repeat.
 */
export function patternFor(index: number): PoolPattern {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`index must be a non-negative integer, got ${index}`);
  const light = 225;
  const dark = 30;
  if (index % 2 === 0) {
    const blocksX = 2 + (Math.floor(index / 2) % 6);
    const blocksY = 2 + (Math.floor(index / 12) % 6);
    return { family: "checkerboard", blocksX, blocksY, light, dark };
  }
  const angleRad = (((index * 37) % 180) * Math.PI) / 180;
  const cycles = 3 + (Math.floor(index / 2) % 5);
  return { family: "stripes", cosA: Math.cos(angleRad), sinA: Math.sin(angleRad), cycles, light, dark };
}

/** The pattern's luminance (0..255) at one pixel, at any resolution — the same function a renderer and the proof test both call. */
export function luminanceAt(pattern: PoolPattern, x: number, y: number, width: number, height: number): number {
  if (pattern.family === "checkerboard") {
    const bx = Math.floor((x * pattern.blocksX) / width);
    const by = Math.floor((y * pattern.blocksY) / height);
    return (bx + by) % 2 === 0 ? pattern.light : pattern.dark;
  }
  const period = Math.max(width, height) / pattern.cycles;
  const projection = x * pattern.cosA + y * pattern.sinA + PROJECTION_OFFSET;
  return Math.floor(projection / period) % 2 === 0 ? pattern.light : pattern.dark;
}

/** A full `width` x `height` grayscale bitmap (row-major, one byte per pixel) of `pattern`. */
export function renderGray(pattern: PoolPattern, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`width and height must be positive integers, got ${width}x${height}`);
  }
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) gray[y * width + x] = luminanceAt(pattern, x, y, width, height);
  }
  return gray;
}
