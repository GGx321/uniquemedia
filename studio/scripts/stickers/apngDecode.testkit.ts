import { inflateSync } from "node:zlib";

// Test support: a minimal APNG reader for files written with full-canvas RGBA
// frames (what the generator writes). It uses the platform's inflate, not our
// deflate, so it is an independent check of the writer.

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
export function decodeFrames(bytes: Uint8Array, width: number, height: number): Uint8Array[] {
  const frames: Uint8Array[][] = [];
  for (const c of chunksOf(bytes)) {
    if (c.name === "fcTL") frames.push([]);
    else if (c.name === "IDAT") frames[0]?.push(c.data);
    else if (c.name === "fdAT") frames[frames.length - 1]?.push(c.data.subarray(4));
  }
  return frames.map((parts) => unfilter(inflateSync(Buffer.concat(parts)), width, height));
}

