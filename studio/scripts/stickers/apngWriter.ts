import { crc32 } from "../../shared/stickers/crc32";
import { zlibCompress } from "./deflate";

// An APNG writer for generated stickers: RGBA 8-bit, full-canvas frames, every
// frame lasting exactly 1/30 s, looping forever. The frame count is therefore
// the loop length in 30 fps frames, which is what 3b.6 validates. All bytes are
// a pure function of the pixels (see ./deflate.ts for why it is not zlib).

export interface ApngSource {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits per channel, straight (not premultiplied) alpha, `width * height * 4` bytes each. */
  readonly frames: readonly Uint8Array[];
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
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const cost = [0, 0, 0, 0, 0];
    for (let x = 0; x < stride; x++) {
      const v = rgba[row + x] ?? 0;
      const a = x >= 4 ? (rgba[row + x - 4] ?? 0) : 0;
      const b = y > 0 ? (rgba[row - stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (rgba[row - stride + x - 4] ?? 0) : 0;
      const residuals = [v, (v - a) & 255, (v - b) & 255, (v - ((a + b) >> 1)) & 255, (v - paeth(a, b, c)) & 255];
      residuals.forEach((r, t) => {
        const target = candidates[t];
        if (target !== undefined) target[x] = r;
        cost[t] = (cost[t] ?? 0) + (r < 128 ? r : 256 - r);
      });
    }
    let best = 0;
    for (let t = 1; t < 5; t++) if ((cost[t] ?? 0) < (cost[best] ?? 0)) best = t;
    out[y * (stride + 1)] = best;
    out.set(candidates[best] ?? new Uint8Array(stride), y * (stride + 1) + 1);
  }
  return out;
}

/** Encodes `source` as an APNG. Throws on an empty or mis-sized input. */
export function encodeApng(source: ApngSource): Uint8Array {
  const { width, height, frames } = source;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`bad canvas size ${width}x${height}`);
  if (frames.length === 0) throw new Error("an APNG needs at least one frame");
  frames.forEach((f, i) => {
    if (f.length !== width * height * 4) throw new Error(`frame ${i} has length ${f.length}, expected ${width * height * 4}`);
  });

  const parts: Uint8Array[] = [
    SIGNATURE,
    chunk("IHDR", Uint8Array.from([...u32(width), ...u32(height), 8, 6, 0, 0, 0])),
    chunk("acTL", Uint8Array.from([...u32(frames.length), ...u32(0)])),
  ];
  let seq = 0;
  frames.forEach((f, i) => {
    // delay 1/30 s, dispose NONE, blend SOURCE: each frame replaces the canvas.
    const delay = [0, 1, 0, 30, 0, 0];
    parts.push(chunk("fcTL", Uint8Array.from([...u32(seq), ...u32(width), ...u32(height), ...u32(0), ...u32(0), ...delay])));
    seq += 1;
    const data = zlibCompress(filterRows(f, width, height));
    if (i === 0) parts.push(chunk("IDAT", data));
    else {
      parts.push(chunk("fdAT", Uint8Array.from(u32(seq)), data));
      seq += 1;
    }
  });
  parts.push(chunk("IEND", new Uint8Array(0)));

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
