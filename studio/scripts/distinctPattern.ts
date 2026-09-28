import { encodeGrayscalePng } from "./grayscalePng";

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
// This module is the one place that structure is generated, and
// `servedPoolImagePng` is the one function that turns an index into the
// exact served bytes: studio/scripts/mockOpenRouter.ts and
// studio/scripts/distinctPattern.test.ts both call it, so they can never
// drift apart the way a hand-copied render once did (round 1 review, HIGH:
// the test hashed a pattern rendered directly at 64x64, but the mock served
// it at 200x356 with pixel-absolute stripe math — geometrically a different
// image, so the test proved nothing about the shipped artifact).
//
// Two families, chosen because a few large regions is squarely a LOW spatial
// frequency — inside PDQ's kept 16x16 DCT band, unlike a fine-grained
// pattern, which would alias away under PDQ's own downscale the same way a
// solid colour does: a checkerboard of a few large blocks, and stripes at a
// rotated angle. Every parameter is a plain number `patternFor` bakes in once
// (including the trig), so no caller needs its own. Both families are
// resolution-independent (every coordinate is a fraction of width/height,
// never an absolute pixel), so the served size never changes the geometry —
// the test still decodes the real served pixels through the real gate
// command rather than trusting that alone (see distinctPattern.test.ts).

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
  /** Full light+dark cycles across the unit square's diagonal projection. */
  readonly cycles: number;
  readonly light: number;
  readonly dark: number;
}

export type PoolPattern = CheckerboardPattern | StripesPattern;

/**
 * Kept far from zero so `floor()`'s sign convention (positive vs negative
 * input) never enters into it: every fractional projection this pattern can
 * produce (roughly ±1.5 either side of zero) stays comfortably positive.
 */
const PROJECTION_OFFSET = 1_000;

/** The served pool images' own size (9:16-ish, matching a photo run's own aspect ratio) — the one place it is decided. */
export const POOL_IMAGE_WIDTH = 200;
export const POOL_IMAGE_HEIGHT = 356;

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

/**
 * The pattern's luminance (0..255) at one pixel, at any resolution — the
 * same function a renderer and the proof test both call. Every coordinate
 * used is `x/width`/`y/height` (a fraction in [0, 1)), never an absolute
 * pixel: the pattern's geometry is the same fraction of the image whatever
 * its resolution or aspect ratio.
 */
export function luminanceAt(pattern: PoolPattern, x: number, y: number, width: number, height: number): number {
  const nx = x / width;
  const ny = y / height;
  if (pattern.family === "checkerboard") {
    const bx = Math.floor(nx * pattern.blocksX);
    const by = Math.floor(ny * pattern.blocksY);
    return (bx + by) % 2 === 0 ? pattern.light : pattern.dark;
  }
  const period = 1 / pattern.cycles;
  const projection = nx * pattern.cosA + ny * pattern.sinA + PROJECTION_OFFSET;
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

/**
 * The exact bytes a photo run's slot `index` (0-based, wrapping every 48)
 * gets served as its fake image: a real, valid, non-animated PNG, at the
 * pool's own size (`POOL_IMAGE_WIDTH` x `POOL_IMAGE_HEIGHT`). The one
 * function studio/scripts/mockOpenRouter.ts serves from and
 * studio/scripts/distinctPattern.test.ts proves PDQ-distinct — never two
 * separate renders of "the same" pattern.
 */
export function servedPoolImagePng(index: number): Uint8Array {
  return encodeGrayscalePng(POOL_IMAGE_WIDTH, POOL_IMAGE_HEIGHT, renderGray(patternFor(index), POOL_IMAGE_WIDTH, POOL_IMAGE_HEIGHT));
}
