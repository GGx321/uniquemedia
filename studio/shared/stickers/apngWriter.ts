import { crc32 } from "./crc32";
import { zlibCompress } from "./deflate";

// An APNG writer for generated stickers and for the own stickers the importer re-encodes (3f.5): RGBA 8-bit, full-canvas frames, each
// frame lasting a whole number of 1/30 s (one, for the built-in set), looping forever. The sum of the delays is therefore the loop length
// in 30 fps frames, which is what 3b.6 validates. All bytes are a pure function of the pixels and delays (see ./deflate.ts for why it is
// not zlib).
//
// `createApngEncoder` takes frames ONE AT A TIME and keeps only what each compressed to, so an import of 300 frames of 720 x 720 (600 MiB
// of pixels) never holds more than one frame of raw pixels; `encodeApng` is the all-at-once form and writes the same bytes.

export interface ApngSource {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits per channel, straight (not premultiplied) alpha, `width * height * 4` bytes each. */
  readonly frames: readonly Uint8Array[];
}

/** The file would pass the byte limit the encoder was given. */
export class ApngTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`the APNG passes its limit of ${maxBytes} bytes`);
    this.name = "ApngTooLargeError";
    this.maxBytes = maxBytes;
  }
}

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/** One chunk whose data is the concatenation of `pieces`. */
function chunk(name: string, ...pieces: readonly Uint8Array[]): Uint8Array {
  const size = pieces.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + size);
  out.set(u32(size), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  let at = 8;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  out.set(u32(crc32(out.subarray(4, 8 + size))), 8 + size);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** PNG scanlines with the filter, per row, whose residuals have the smallest sum of magnitudes (ties: the lowest type). */
function filterRows(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array((stride + 1) * height);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  const [none, sub, up, average, paethRow] = candidates as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let cost0 = 0;
    let cost1 = 0;
    let cost2 = 0;
    let cost3 = 0;
    let cost4 = 0;
    for (let x = 0; x < stride; x++) {
      const v = rgba[row + x] ?? 0;
      const a = x >= 4 ? (rgba[row + x - 4] ?? 0) : 0;
      const b = y > 0 ? (rgba[row - stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (rgba[row - stride + x - 4] ?? 0) : 0;
      const r0 = v;
      const r1 = (v - a) & 255;
      const r2 = (v - b) & 255;
      const r3 = (v - ((a + b) >> 1)) & 255;
      const r4 = (v - paeth(a, b, c)) & 255;
      none[x] = r0;
      sub[x] = r1;
      up[x] = r2;
      average[x] = r3;
      paethRow[x] = r4;
      cost0 += r0 < 128 ? r0 : 256 - r0;
      cost1 += r1 < 128 ? r1 : 256 - r1;
      cost2 += r2 < 128 ? r2 : 256 - r2;
      cost3 += r3 < 128 ? r3 : 256 - r3;
      cost4 += r4 < 128 ? r4 : 256 - r4;
    }
    const cost = [cost0, cost1, cost2, cost3, cost4];
    let best = 0;
    for (let t = 1; t < 5; t++) if ((cost[t] ?? 0) < (cost[best] ?? 0)) best = t;
    out[y * (stride + 1)] = best;
    out.set(candidates[best] ?? new Uint8Array(stride), y * (stride + 1) + 1);
  }
  return out;
}

export interface ApngEncoderOptions {
  readonly width: number;
  readonly height: number;
  /** How many frames will be added: the animation control chunk is written before the first of them. */
  readonly frameCount: number;
  /** The file may not pass this many bytes: `add` and `finish` throw `ApngTooLargeError` as soon as it would. */
  readonly maxBytes?: number;
}

export interface ApngEncoder {
  /** Adds the next frame: RGBA, `width * height * 4` bytes, lasting `delayFrames` (a whole number of 1/30 s, at least 1; 1 by default). */
  add(rgba: Uint8Array, delayFrames?: number): void;
  /** The finished file. Throws when fewer frames were added than were declared. */
  finish(): Uint8Array;
}

/** Writes an APNG a frame at a time. Throws on an empty canvas, no frames, a mis-sized frame, a bad delay, or too many frames. */
export function createApngEncoder(options: ApngEncoderOptions): ApngEncoder {
  const { width, height, frameCount, maxBytes } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`bad canvas size ${width}x${height}`);
  if (!Number.isInteger(frameCount) || frameCount < 1) throw new Error("an APNG needs at least one frame");
  const parts: Uint8Array[] = [SIGNATURE, chunk("IHDR", Uint8Array.from([...u32(width), ...u32(height), 8, 6, 0, 0, 0])), chunk("acTL", Uint8Array.from([...u32(frameCount), ...u32(0)]))];
  let size = parts.reduce((n, p) => n + p.length, 0) + 12; // + IEND
  let added = 0;
  let seq = 0;
  const check = (): void => {
    if (maxBytes !== undefined && size > maxBytes) throw new ApngTooLargeError(maxBytes);
  };

  return {
    add(rgba, delayFrames = 1) {
      if (added >= frameCount) throw new Error(`more than the ${frameCount} frames declared`);
      if (rgba.length !== width * height * 4) throw new Error(`frame ${added} has length ${rgba.length}, expected ${width * height * 4}`);
      if (!Number.isInteger(delayFrames) || delayFrames < 1 || delayFrames > 0xffff) throw new Error(`frame ${added} has a bad delay of ${delayFrames} frames`);
      // `delayFrames`/30 s, dispose NONE, blend SOURCE: each frame replaces the canvas.
      const fcTL = chunk("fcTL", Uint8Array.from([...u32(seq), ...u32(width), ...u32(height), ...u32(0), ...u32(0), delayFrames >> 8, delayFrames & 255, 0, 30, 0, 0]));
      seq += 1;
      const data = zlibCompress(filterRows(rgba, width, height));
      const body = added === 0 ? chunk("IDAT", data) : chunk("fdAT", Uint8Array.from(u32(seq)), data);
      if (added > 0) seq += 1;
      // Judged before the frame is kept, so a hostile run never holds more than the limit.
      size += fcTL.length + body.length;
      check();
      parts.push(fcTL, body);
      added += 1;
    },
    finish() {
      if (added !== frameCount) throw new Error(`${added} frames were added, ${frameCount} declared`);
      check();
      parts.push(chunk("IEND", new Uint8Array(0)));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    },
  };
}

/** Encodes `source` as an APNG, every frame lasting one 30 fps frame. Throws on an empty or mis-sized input. */
export function encodeApng(source: ApngSource): Uint8Array {
  const { width, height, frames } = source;
  if (frames.length === 0) throw new Error("an APNG needs at least one frame");
  const encoder = createApngEncoder({ width, height, frameCount: frames.length });
  for (const f of frames) encoder.add(f);
  return encoder.finish();
}
