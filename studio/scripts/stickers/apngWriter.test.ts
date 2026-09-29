import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { inspectApng } from "../../shared/stickers/apng";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { encodeApng } from "./apngWriter";
useNativeGlobals();

/** A frame whose pixels are a function of position and frame number: gradients in both axes and an alpha ramp. */
function frame(width: number, height: number, n: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i] = (x * 5 + n * 17) & 255;
      out[i + 1] = (y * 3 + x) & 255;
      out[i + 2] = ((x ^ y) * 7 + n) & 255;
      out[i + 3] = (x * 255) / Math.max(1, width - 1);
    }
  }
  return out;
}

interface Chunk {
  readonly name: string;
  readonly data: Uint8Array;
}

function chunksOf(bytes: Uint8Array): Chunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Chunk[] = [];
  for (let pos = 8; pos < bytes.length; ) {
    const len = view.getUint32(pos);
    out.push({ name: new TextDecoder().decode(bytes.subarray(pos + 4, pos + 8)), data: bytes.subarray(pos + 8, pos + 8 + len) });
    pos += 12 + len;
  }
  return out;
}

function unfilter(raw: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= 4 ? (out[y * stride + x - 4] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (out[(y - 1) * stride + x - 4] ?? 0) : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const add = [0, a, b, (a + b) >> 1, paeth][type] ?? 0;
      out[y * stride + x] = (v + add) & 255;
    }
  }
  return out;
}

/** Decodes every frame of an APNG written with full-canvas frames. */
function decodeFrames(bytes: Uint8Array, width: number, height: number): Uint8Array[] {
  const frames: Uint8Array[][] = [];
  for (const c of chunksOf(bytes)) {
    if (c.name === "fcTL") frames.push([]);
    else if (c.name === "IDAT") frames[0]?.push(c.data);
    else if (c.name === "fdAT") frames[frames.length - 1]?.push(c.data.subarray(4));
  }
  return frames.map((parts) => unfilter(inflateSync(Buffer.concat(parts)), width, height));
}

describe("encodeApng", () => {
  const W = 24;
  const H = 16;
  const source = { width: W, height: H, frames: [0, 1, 2, 3].map((n) => frame(W, H, n)) };

  test("writes a file the header validator accepts", () => {
    const result = inspectApng(encodeApng(source));
    expect(result.ok).toBe(true);
  });
  test("writes the canvas size it was given", () => {
    const result = inspectApng(encodeApng(source));
    if (!result.ok) throw new Error(result.code);
    expect([result.info.width, result.info.height]).toEqual([W, H]);
  });
  test("writes one frame per source frame, each lasting one 30 fps frame", () => {
    const result = inspectApng(encodeApng(source));
    if (!result.ok) throw new Error(result.code);
    expect(result.info.frames.map((f) => [f.delayNum, f.delayDen])).toEqual([1, 2, 3, 4].map(() => [1, 30]));
  });
  test("makes the loop as long as the frame count in 30 fps frames", () => {
    const result = inspectApng(encodeApng(source));
    if (!result.ok) throw new Error(result.code);
    expect(result.info.loopFrames).toBe(4);
  });
  test("loops forever", () => {
    const result = inspectApng(encodeApng(source));
    if (!result.ok) throw new Error(result.code);
    expect(result.info.loopCount).toBe(0);
  });
  test("stores RGBA 8-bit pixels", () => {
    const result = inspectApng(encodeApng(source));
    if (!result.ok) throw new Error(result.code);
    expect([result.info.colorType, result.info.bitDepth]).toEqual([6, 8]);
  });
  test("keeps every pixel of every frame exactly", () => {
    const decoded = decodeFrames(encodeApng(source), W, H);
    expect(decoded.length).toBe(4);
    decoded.forEach((d, n) => expect(Buffer.compare(d, source.frames[n] ?? new Uint8Array(0))).toBe(0));
  });
  test("keeps fully transparent pixels' colour channels as given, so alpha is never premultiplied away", () => {
    const f = new Uint8Array(W * H * 4);
    for (let i = 0; i < f.length; i += 4) f.set([200, 100, 50, 0], i);
    const decoded = decodeFrames(encodeApng({ width: W, height: H, frames: [f, f] }), W, H);
    expect(Array.from(decoded[0]?.subarray(0, 4) ?? [])).toEqual([200, 100, 50, 0]);
  });
  test("gives the same bytes for the same input, twice", () => {
    expect(Buffer.compare(encodeApng(source), encodeApng(source))).toBe(0);
  });
  test("refuses a frame of the wrong length", () => {
    expect(() => encodeApng({ width: W, height: H, frames: [new Uint8Array(W * H * 4 - 1)] })).toThrow(/length/);
  });
  test("refuses no frames", () => {
    expect(() => encodeApng({ width: W, height: H, frames: [] })).toThrow(/frame/);
  });
  test("refuses a zero-sized canvas", () => {
    expect(() => encodeApng({ width: 0, height: H, frames: [new Uint8Array(0)] })).toThrow(/size/);
  });
});
