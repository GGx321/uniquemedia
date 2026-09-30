import { inflateSync } from "node:zlib";

// A decoder for exactly what resvg writes: 8-bit RGBA, not interlaced. Test support; never imported by production code.
// It reads the pixels back so a test can say what a caption looks like (a plaque colour here, a shadow there) without
// pinning bytes.

export interface Rgba {
  width: number;
  height: number;
  /** Row-major, 4 bytes a pixel, straight (not premultiplied) alpha. */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png: Uint8Array): Rgba {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let i = 0; i < SIGNATURE.length; i++) if (png[i] !== SIGNATURE[i]) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.byteLength; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (png[at + 16] !== 8 || png[at + 17] !== 6 || png[at + 20] !== 0) throw new Error("only 8-bit RGBA, not interlaced");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= 4 ? (out[y * stride + x - 4] ?? 0) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= 4 ? (out[(y - 1) * stride + x - 4] ?? 0) : 0;
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      out[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, data: out };
}

export function pixel(image: Rgba, x: number, y: number): [r: number, g: number, b: number, a: number] {
  const at = (y * image.width + x) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0, image.data[at + 3] ?? 0];
}

/** How many pixels satisfy `test`. */
export function countPixels(image: Rgba, test: (r: number, g: number, b: number, a: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < image.data.length; i += 4) if (test(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0, image.data[i + 3] ?? 0)) n++;
  return n;
}

/** The columns and rows where a pixel satisfies `test`, or null when none does. */
export function extent(image: Rgba, test: (r: number, g: number, b: number, a: number) => boolean): { left: number; right: number; top: number; bottom: number } | null {
  let left = Infinity;
  let right = -1;
  let top = Infinity;
  let bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [r, g, b, a] = pixel(image, x, y);
      if (!test(r, g, b, a)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : { left, right, top, bottom };
}
