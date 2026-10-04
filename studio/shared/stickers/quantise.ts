import { STICKER_FPS } from "./apng";

// Own stickers (3f.5): a source animation's frame delays, put on the 30 fps grid the render and the preview share.
//
// A GIF counts in centiseconds and an APNG in any fraction of a second, and neither lands on 1/30 s. Rounding each frame's delay alone
// drifts: seven 4 cs frames (a 25 fps GIF, 280 ms) would become seven 1/30 s frames (233 ms) or seven 2/30 s ones (467 ms). So the
// loop is quantised by ACCUMULATED time: frame i starts at the slot `round(T_i * 30)`, T_i being the exact sum of the delays before it,
// and lasts until the next frame's slot. The error never builds up (the loop is the whole duration rounded once), and it is the very
// rule of ffmpeg's `fps=30` filter (nearest slot, a half rounds up), which the importer cross-checks by counting what ffmpeg decodes.
//
// A frame shorter than a slot can get no slot at all: it is dropped from the loop (`slots[i] === 0`), exactly as `fps=30` drops it.
//
// The arithmetic is exact: delays are fractions of a second, summed as BigInt fractions, so a denominator that does not divide 30 (or
// a long run of them) never meets a float.

/** One frame's duration in seconds, as a fraction. `den` is never 0 (the callers read a zero denominator the way their format says). */
export interface FrameDuration {
  readonly num: number;
  readonly den: number;
}

export interface Quantised {
  /** The 30 fps slots each source frame lasts, in order; a frame that rounds to none has 0 and is not part of the loop. */
  readonly slots: readonly number[];
  /** The sum of `slots`: the loop's length in 30 fps frames. */
  readonly loopFrames: number;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};

export function quantiseByAccumulatedTime(durations: readonly FrameDuration[]): Quantised {
  const fps = BigInt(STICKER_FPS);
  // The running sum as a reduced fraction N / D.
  let n = 0n;
  let d = 1n;
  let previous = 0;
  const slots: number[] = [];
  for (const duration of durations) {
    if (!Number.isInteger(duration.num) || !Number.isInteger(duration.den) || duration.num <= 0 || duration.den <= 0) {
      throw new RangeError("a frame's duration must be a positive fraction of a second");
    }
    const num = BigInt(duration.num);
    const den = BigInt(duration.den);
    n = n * den + num * d;
    d = d * den;
    const g = gcd(n, d);
    n /= g;
    d /= g;
    // round-half-up(N / D * fps) = floor((2 * fps * N + D) / (2 * D))
    const boundary = Number((2n * fps * n + d) / (2n * d));
    slots.push(boundary - previous);
    previous = boundary;
  }
  return { slots, loopFrames: previous };
}

/**
 * The delay a GIF frame is played for, in centiseconds. A delay of 0 or 1 cs is a "no delay" some encoders write, and every player
 * replaces it with 10 cs: browsers do for 0 and 1 (the 10 ms clamp), and so does ffmpeg's gif demuxer (`min_delay` 2: anything under
 * 2 cs is its `default_delay`, 10 cs). The importer decides the same and writes it down; 2 cs and above are kept.
 */
export function clampGifDelayCs(delayCs: number): number {
  return delayCs < 2 ? 10 : delayCs;
}
