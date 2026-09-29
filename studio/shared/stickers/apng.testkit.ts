import { crc32 } from "./crc32";

// Test support: builds APNG byte streams for the header validator. The frame
// data is filler, because the validator never inflates it.

export interface TestFrame {
  readonly delayNum?: number;
  readonly delayDen?: number;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  /** Overrides the sequence number this frame's fcTL carries. */
  readonly seq?: number;
}

export interface TestApng {
  readonly width?: number;
  readonly height?: number;
  readonly frames: readonly TestFrame[];
  readonly numPlays?: number;
  /** Declared `num_frames` in acTL, when it should differ from `frames.length`. */
  readonly declaredFrames?: number;
  readonly omitActl?: boolean;
  readonly colorType?: number;
  readonly bitDepth?: number;
  /** Chunks written right after IHDR, before acTL. */
  readonly early?: readonly Uint8Array[];
}

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One chunk with a correct CRC (or the given one). */
export function chunk(type: string, data: readonly number[], crcOverride?: number): Uint8Array {
  const body = Uint8Array.from([...ascii(type), ...data]);
  return Uint8Array.from([...u32(data.length), ...body, ...u32(crcOverride ?? crc32(body))]);
}

export const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function ihdr(width: number, height: number, bitDepth = 8, colorType = 6, interlace = 0): Uint8Array {
  return chunk("IHDR", [...u32(width), ...u32(height), bitDepth, colorType, 0, 0, interlace]);
}

export function actl(numFrames: number, numPlays: number): Uint8Array {
  return chunk("acTL", [...u32(numFrames), ...u32(numPlays)]);
}

export function fctl(seq: number, w: number, h: number, x: number, y: number, delayNum: number, delayDen: number): Uint8Array {
  return chunk("fcTL", [...u32(seq), ...u32(w), ...u32(h), ...u32(x), ...u32(y), ...u16(delayNum), ...u16(delayDen), 0, 0]);
}

export const idat = (): Uint8Array => chunk("IDAT", [1, 2, 3, 4, 5]);
export const fdat = (seq: number): Uint8Array => chunk("fdAT", [...u32(seq), 1, 2, 3]);
export const plte = (colours = 2): Uint8Array => chunk("PLTE", Array.from({ length: colours * 3 }, (_, i) => i * 7));
export const iend = (): Uint8Array => chunk("IEND", []);

export function buildApng(spec: TestApng): Uint8Array {
  const width = spec.width ?? 8;
  const height = spec.height ?? 8;
  const parts: Uint8Array[] = [PNG_SIGNATURE, ihdr(width, height, spec.bitDepth ?? 8, spec.colorType ?? 6)];
  parts.push(...(spec.early ?? []));
  if (!spec.omitActl) parts.push(actl(spec.declaredFrames ?? spec.frames.length, spec.numPlays ?? 0));
  let seq = 0;
  spec.frames.forEach((f, i) => {
    const w = f.width ?? width;
    const h = f.height ?? height;
    parts.push(fctl(f.seq ?? seq, w, h, f.x ?? 0, f.y ?? 0, f.delayNum ?? 1, f.delayDen ?? 30));
    seq += 1;
    if (i === 0) parts.push(idat());
    else {
      parts.push(fdat(seq));
      seq += 1;
    }
  });
  if (spec.omitActl && spec.frames.length === 0) parts.push(idat());
  parts.push(iend());
  return concat(parts);
}
