/**
 * What the frame's border looks like, read off the buffers the pipeline already
 * extracts. Nothing here spawns anything or touches a file: the whole point is
 * that choosing between cropping the edge away and padding it back costs no
 * extra decode.
 */

/** The side of the gray buffer `extractGrayFrames` produces. */
const GRAY_SIDE = 64;

/**
 * The side of the RGB thumbnail the pad colour is read from.
 *
 * 8x8 was the first proposal and is measurably too coarse. On the 1080x1920
 * story each 8x8 pixel averages 135 px of width, so graphics touching the edge
 * are mixed into the background before the median ever sees them: the ring came
 * back 0x261F0E, a dark olive, where the same median at 64x64 returns 0x010101.
 * A visible olive border is precisely the defect this mode exists to avoid.
 */
const RGB_SIDE = 64;

/**
 * How many rows and columns count as "the edge" of the 64x64 buffer. Three is
 * 4.7% of the frame on each side, which brackets the fit/crop window the
 * sampler draws (0.88..1.0, i.e. up to 6% per side at the ceiling) — the band
 * the padding would occupy plus a little context. Two and four were measured on
 * the same fixtures and moved the answer for neither.
 */
const BAND = 3;

/**
 * The median absolute deviation, in 0..255 luma, that reads as fully busy.
 *
 * It is the typical distance between a border pixel and the single colour a pad
 * would replace it with. 16/255 is ~6% of the luma range, which is roughly
 * where a flat band stops blending into varying content and starts reading as
 * a band. Everything at or beyond it is clamped to 1.
 */
const BUSY_REFERENCE = 16;

/**
 * Below this, padding is invisible and the edge is worth preserving.
 *
 * 0.25 of BUSY_REFERENCE is a MAD of 4/255 — the typical border pixel is within
 * 1.6% of the colour the padding would be. Measured against the two real
 * fixtures: the 1080x1920 story on a flat background scores 0.0625 (MAD 1) and
 * the mandelbrot photograph scores 0.5625 (MAD 9), so the threshold sits with a
 * 4x margin below and a 2.25x margin above.
 */
const PRESERVE_BELOW = 0.25;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation: the typical distance from the typical value.
 *  Chosen over a standard deviation because graphics reaching the frame edge
 *  are a MINORITY of the band, and a squared-error statistic lets that minority
 *  decide — measured, it ranks the two real fixtures the wrong way round. */
function medianAbsoluteDeviation(values: number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

function outerBand(gray64: Uint8Array): number[] {
  const band: number[] = [];
  for (let y = 0; y < GRAY_SIDE; y++) {
    const edgeRow = y < BAND || y >= GRAY_SIDE - BAND;
    for (let x = 0; x < GRAY_SIDE; x++) {
      if (edgeRow || x < BAND || x >= GRAY_SIDE - BAND) band.push(gray64[y * GRAY_SIDE + x]);
    }
  }
  return band;
}

/**
 * How uniform the frame's outer band is. 0 = flat, 1 = busy.
 *
 * Takes the 64x64 grayscale buffer the pipeline already extracts for hashing,
 * so asking the question costs nothing extra.
 */
export function edgeBusyness(gray64: Uint8Array): number {
  if (gray64.length < GRAY_SIDE * GRAY_SIDE) {
    throw new Error(
      `edgeBusyness: expected a ${GRAY_SIDE}x${GRAY_SIDE} gray frame ` +
        `(${GRAY_SIDE * GRAY_SIDE} bytes), got ${gray64.length}`
    );
  }
  const mad = medianAbsoluteDeviation(outerBand(gray64));
  return Math.min(1, mad / BUSY_REFERENCE);
}

/**
 * Whether the frame's edge should be kept rather than cropped away.
 *
 * A flat border — a story on a solid background — can be padded back to full
 * size and nobody sees the padding, so no picture has to be sacrificed to move
 * the hash. A busy border — a photograph whose content runs to the edge — would
 * show the padding as a visible frame, so cropping stays right there.
 */
export function shouldPreserveEdges(gray64: Uint8Array): boolean {
  return edgeBusyness(gray64) < PRESERVE_BELOW;
}

/**
 * The colour the padding should be, as an ffmpeg colour literal.
 *
 * Reads the per-channel median of the same outer band `edgeBusyness` measures,
 * off a 64x64 RGB thumbnail. Black is right for the user's story and wrong for
 * a light background, so it has to come from the picture; the median rather
 * than the mean because graphics touching the edge are exactly the minority
 * that must not drag the colour away from the background they sit on, and the
 * whole band rather than one side because the padding goes on all four.
 */
export function edgePadColor(rgb64: Uint8Array): string {
  const expected = RGB_SIDE * RGB_SIDE * 3;
  if (rgb64.length < expected) {
    throw new Error(
      `edgePadColor: expected a ${RGB_SIDE}x${RGB_SIDE} rgb24 frame (${expected} bytes), ` +
        `got ${rgb64.length}`
    );
  }
  const channels: [number[], number[], number[]] = [[], [], []];
  for (let y = 0; y < RGB_SIDE; y++) {
    const edgeRow = y < BAND || y >= RGB_SIDE - BAND;
    for (let x = 0; x < RGB_SIDE; x++) {
      if (!edgeRow && x >= BAND && x < RGB_SIDE - BAND) continue;
      const i = (y * RGB_SIDE + x) * 3;
      channels[0].push(rgb64[i]);
      channels[1].push(rgb64[i + 1]);
      channels[2].push(rgb64[i + 2]);
    }
  }
  const hex = channels
    .map((c) => Math.round(median(c)).toString(16).toUpperCase().padStart(2, "0"))
    .join("");
  return `0x${hex}`;
}
