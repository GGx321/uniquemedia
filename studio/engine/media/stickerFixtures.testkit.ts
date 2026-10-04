import { crc32 } from "../../shared/stickers/crc32";
import { createApngEncoder } from "../../shared/stickers/apngWriter";
import { buildGif, type TestGifFrame } from "../../shared/stickers/gif.testkit";

// Test support for the own-sticker importer (3f.5): small, deterministic GIFs and APNGs whose frames are flat colours a test can name, and the
// edits that make an APNG hostile (other delays, a poster image before the first frame, a frame outside the canvas). Test-only.

export type Rgba = readonly [number, number, number, number];

/** The testkit's GIF palette (indices 0..3), as the pixels ffmpeg decodes them to. */
export const PALETTE: readonly Rgba[] = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 255, 255],
];
export const [GIF_RED, GIF_GREEN, GIF_BLUE, GIF_WHITE] = PALETTE as readonly [Rgba, Rgba, Rgba, Rgba];

/** A GIF of flat frames: frame `i` is all palette index `colours[i]`, lasting `delaysCs[i]` (10 by default). */
export function flatGif(colours: readonly number[], delaysCs: readonly (number | null)[] = [], size: { width?: number; height?: number } = {}): Uint8Array {
  const width = size.width ?? 8;
  const height = size.height ?? 6;
  const frames: TestGifFrame[] = colours.map((colour, i) => ({ delayCs: delaysCs[i] === undefined ? 10 : delaysCs[i], indices: Array.from({ length: width * height }, () => colour) }));
  return buildGif({ width, height, frames });
}

/** RGBA of one flat colour. */
export function flatRgba(width: number, height: number, colour: Rgba): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) out.set(colour, i);
  return out;
}

/** An APNG of flat frames (full canvas), each lasting one 30 fps frame (the writer's own delays). */
export function flatApng(colours: readonly Rgba[], size: { width?: number; height?: number } = {}): Uint8Array {
  const width = size.width ?? 8;
  const height = size.height ?? 6;
  const encoder = createApngEncoder({ width, height, frameCount: colours.length });
  for (const colour of colours) encoder.add(flatRgba(width, height, colour));
  return encoder.finish();
}

interface Chunk {
  readonly name: string;
  readonly data: Uint8Array;
}

function chunksOf(bytes: Uint8Array): Chunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Chunk[] = [];
  for (let pos = 8; pos < bytes.length; ) {
    const length = view.getUint32(pos);
    out.push({ name: String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)), data: bytes.subarray(pos + 8, pos + 8 + length) });
    pos += 12 + length;
  }
  return out;
}

function chunkBytes(name: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const sig = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const out = new Uint8Array(sig.length + chunks.reduce((n, c) => n + c.length, 0));
  out.set(sig, 0);
  let at = sig.length;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The same APNG with each frame's delay replaced by `[num, den]`. */
export function withDelays(apng: Uint8Array, delays: readonly (readonly [number, number])[]): Uint8Array {
  let frame = 0;
  return join(
    chunksOf(apng).map((c) => {
      if (c.name !== "fcTL") return chunkBytes(c.name, c.data);
      const data = Uint8Array.from(c.data);
      const view = new DataView(data.buffer);
      const [num, den] = delays[frame++] ?? [1, 30];
      view.setUint16(20, num);
      view.setUint16(22, den);
      return chunkBytes("fcTL", data);
    }),
  );
}

/** The same APNG with `edit` applied to frame `index`'s fcTL data (a view over its 26 bytes, big-endian fields at the PNG spec's offsets). */
export function withFctl(apng: Uint8Array, index: number, edit: (view: DataView) => void): Uint8Array {
  let frame = 0;
  return join(
    chunksOf(apng).map((c) => {
      if (c.name !== "fcTL") return chunkBytes(c.name, c.data);
      const data = Uint8Array.from(c.data);
      if (frame++ === index) edit(new DataView(data.buffer));
      return chunkBytes("fcTL", data);
    }),
  );
}

/** The same APNG with acTL's `num_frames` replaced: a file that lies about how many frames it holds. */
export function withDeclaredFrames(apng: Uint8Array, declared: number): Uint8Array {
  return join(
    chunksOf(apng).map((c) => {
      if (c.name !== "acTL") return chunkBytes(c.name, c.data);
      const data = Uint8Array.from(c.data);
      new DataView(data.buffer).setUint32(0, declared);
      return chunkBytes("acTL", data);
    }),
  );
}

/**
 * An APNG whose default image is NOT its first frame: the first frame's pixels come first as a plain IDAT with no fcTL before it (a poster), then
 * the animation proper follows in fcTL / fdAT chunks. `apng` is a file from `flatApng`; its first frame becomes the poster.
 */
export function withPoster(apng: Uint8Array): Uint8Array {
  const chunks = chunksOf(apng);
  const ihdr = chunks.find((c) => c.name === "IHDR");
  const actl = chunks.find((c) => c.name === "acTL");
  const poster = chunks.find((c) => c.name === "IDAT");
  if (ihdr === undefined || actl === undefined || poster === undefined) throw new Error("not a file flatApng wrote");
  const out: Uint8Array[] = [chunkBytes("IHDR", ihdr.data), chunkBytes("acTL", actl.data), chunkBytes("IDAT", poster.data)];
  let seq = 0;
  for (const c of chunks) {
    if (c.name === "fcTL") {
      const data = Uint8Array.from(c.data);
      new DataView(data.buffer).setUint32(0, seq++);
      out.push(chunkBytes("fcTL", data));
    } else if (c.name === "IDAT" || c.name === "fdAT") {
      const pixels = c.name === "IDAT" ? c.data : c.data.subarray(4);
      const data = new Uint8Array(4 + pixels.length);
      new DataView(data.buffer).setUint32(0, seq++);
      data.set(pixels, 4);
      out.push(chunkBytes("fdAT", data));
    }
  }
  out.push(chunkBytes("IEND", new Uint8Array(0)));
  return join(out);
}

/**
 * An APNG of `count` frames that all share ONE compressed picture (so a big canvas costs one compression, not `count`), each lasting `delay`
 * seconds: for the importer's size rules, which are judged before any pixel is decoded. The pixels are a flat colour.
 */
export function repeatedFramesApng(width: number, height: number, count: number, delay: readonly [number, number]): Uint8Array {
  const chunks = chunksOf(flatApng([[10, 20, 30, 255]], { width, height }));
  const ihdr = chunks.find((c) => c.name === "IHDR");
  const picture = chunks.find((c) => c.name === "IDAT");
  if (ihdr === undefined || picture === undefined) throw new Error("not a file flatApng wrote");
  const actl = new Uint8Array(8);
  new DataView(actl.buffer).setUint32(0, count);
  const out: Uint8Array[] = [chunkBytes("IHDR", ihdr.data), chunkBytes("acTL", actl)];
  let seq = 0;
  for (let i = 0; i < count; i++) {
    const fctl = new Uint8Array(26);
    const view = new DataView(fctl.buffer);
    view.setUint32(0, seq++);
    view.setUint32(4, width);
    view.setUint32(8, height);
    view.setUint16(20, delay[0]);
    view.setUint16(22, delay[1]);
    out.push(chunkBytes("fcTL", fctl));
    if (i === 0) {
      out.push(chunkBytes("IDAT", picture.data));
    } else {
      const data = new Uint8Array(4 + picture.data.length);
      new DataView(data.buffer).setUint32(0, seq++);
      data.set(picture.data, 4);
      out.push(chunkBytes("fdAT", data));
    }
  }
  out.push(chunkBytes("IEND", new Uint8Array(0)));
  return join(out);
}
