import { stickerById, type StickerCategoryId } from "../../shared/stickers/manifest";
import { concatBytes, PNG_SIGNATURE, pngBase64Url, pngChunk, zlibStored } from "./mockPng";

// The dev mock's stand-in for a built-in sticker's picture (3d.3b; 3d.4: animated): the dev build has no
// `studio-media://sticker/<id>`, so the mock client hands an APNG data URL instead, a sparkle in the colour of the sticker's
// category that turns and pulses over the manifest's own loop, one frame per 1/30 s like the real set. So the preview decodes and
// loops it the way the real app does. Not the sticker: never design on its look (the real one is the generated set, 3b.5).
//
// 3f.5: the same star stands in for an OWN sticker (`mockOwnStickerBytes`), on the canvas, the loop and the per-frame delays of its record, so
// the preview decodes and loops it as it would the stored APNG.

const CATEGORY_COLOURS: Record<StickerCategoryId, readonly [number, number, number]> = {
  love: [0xff, 0x6b, 0x8b],
  sparkle: [0xff, 0xd1, 0x66],
  mood: [0xff, 0x9a, 0x52],
  nature: [0x7f, 0xd6, 0xff],
  party: [0xc5, 0x8b, 0xff],
  abstract: [0x8f, 0xb0, 0xff],
  pointer: [0x4f, 0xe0, 0xb0],
};

/** The stand-in's side, in pixels: small, since it is stored uncompressed. */
const SIDE = 64;
/** A 2-bit palette: transparent, the colour at the soft edge, the colour. */
const EDGE_ALPHA = 120;
/** An own sticker's stand-in keeps under this many bytes of pixels (stored uncompressed), by showing fewer, longer frames when its record has many. */
const OWN_PIXEL_BUDGET = 3 * 1024 * 1024;

const made = new Map<string, { bytes: Uint8Array; url: string }>();

/** The four-pointed star of outer radius `r`, turned by `turn` radians, centred on the `w` x `h` picture: its eight corners. */
function star(r: number, turn: number, w: number, h: number): [number, number][] {
  return Array.from({ length: 8 }, (_, i): [number, number] => {
    const angle = turn + (i * Math.PI) / 4;
    const radius = i % 2 === 0 ? r : r * 0.38;
    return [w / 2 + radius * Math.cos(angle), h / 2 + radius * Math.sin(angle)];
  });
}

/** Whether `(px, py)` is inside the polygon (even-odd). */
function inside(points: readonly [number, number][], px: number, py: number): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i] ?? [0, 0];
    const [xj, yj] = points[j] ?? [0, 0];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Frame `k` of `frames` on a `w` x `h` canvas: the star a quarter turn further each loop (it looks the same after a quarter turn), pulsing once. */
function frameRows(k: number, frames: number, w: number, h: number): Uint8Array {
  const phase = k / frames;
  const points = star((Math.min(w, h) / 2 - 2) * (0.78 + 0.22 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase))), (Math.PI / 2) * phase, w, h);
  const stride = 1 + Math.ceil(w / 4);
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hits = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) if (inside(points, x + sx, y + sy)) hits++;
      const index = hits === 0 ? 0 : hits < 3 ? 1 : 2;
      const at = y * stride + 1 + (x >> 2);
      raw[at] = (raw[at] ?? 0) | (index << (6 - 2 * (x & 3)));
    }
  }
  return raw;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v));
  return out;
}

/** A frame control: the whole picture, shown for `delay` 30 fps frames, replacing the frame before. */
function fctl(sequence: number, w: number, h: number, delay: number): Uint8Array {
  const out = new Uint8Array(26);
  out.set(u32(sequence, w, h, 0, 0), 0);
  const view = new DataView(out.buffer);
  view.setUint16(20, delay);
  view.setUint16(22, 30);
  out[24] = 0; // dispose: none
  out[25] = 0; // blend: source
  return out;
}

/** The stand-in: one frame per entry of `delays` (30 fps frames each), on a `w` x `h` canvas, in the colour of `category`. */
function standIn(colour: readonly [number, number, number], delays: readonly number[], w: number, h: number): Uint8Array {
  const [r, g, b] = colour;
  const header = concatBytes([u32(w, h), Uint8Array.from([2, 3, 0, 0, 0])]);
  const parts: Uint8Array[] = [
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk("IHDR", header),
    pngChunk("acTL", u32(delays.length, 0)),
    pngChunk("PLTE", Uint8Array.from([0, 0, 0, r, g, b, r, g, b])),
    pngChunk("tRNS", Uint8Array.from([0, EDGE_ALPHA, 255])),
  ];
  let sequence = 0;
  delays.forEach((delay, k) => {
    parts.push(pngChunk("fcTL", fctl(sequence++, w, h, delay)));
    const data = zlibStored(frameRows(k, delays.length, w, h));
    parts.push(k === 0 ? pngChunk("IDAT", data) : pngChunk("fdAT", concatBytes([u32(sequence++), data])));
  });
  parts.push(pngChunk("IEND", new Uint8Array(0)));
  return concatBytes(parts);
}

function standInOf(stickerId: string): { bytes: Uint8Array; url: string } | null {
  const sticker = stickerById(stickerId);
  if (sticker === undefined) return null;
  const known = made.get(sticker.id);
  if (known !== undefined) return known;
  const bytes = standIn(CATEGORY_COLOURS[sticker.category], Array.from({ length: sticker.loopFrames }, () => 1), SIDE, SIDE);
  const entry = { bytes, url: pngBase64Url(bytes) };
  made.set(sticker.id, entry);
  return entry;
}

/** An animated data URL standing in for built-in sticker `stickerId` (made once), or null when the set does not have it. */
export function mockStickerUrl(stickerId: string): string | null {
  return standInOf(stickerId)?.url ?? null;
}

/**
 * The bytes of that stand-in (a copy): what the mock answers `stickers.bytes` with, as main answers with the verified file
 * (3d.4 review round 1: the preview's decoder never reads the media scheme). Null when the set does not have the sticker.
 */
export function mockStickerBytes(stickerId: string): Uint8Array | null {
  const entry = standInOf(stickerId);
  return entry === null ? null : new Uint8Array(entry.bytes);
}

/** What the stand-in of an own sticker needs of its record. */
export interface OwnStickerFacts {
  readonly mediaId: string;
  readonly width: number;
  readonly height: number;
  readonly loopFrames: number;
  readonly delayFrames: readonly number[];
}

const OWN_COLOURS: readonly (readonly [number, number, number])[] = Object.values(CATEGORY_COLOURS);

/**
 * The bytes of the stand-in of an own sticker (3f.5): an APNG on the canvas, the loop and the per-frame delays of its record, which is what main
 * answers `media.stickerBytes` with (the stored file). A record with so many frames that they would not fit the pixel budget stored uncompressed is
 * shown with fewer, longer frames over the same loop, never a different loop.
 */
export function mockOwnStickerBytes(sticker: OwnStickerFacts): Uint8Array {
  const { width, height, loopFrames, delayFrames } = sticker;
  const frameBytes = (1 + Math.ceil(width / 4)) * height;
  const fits = Math.max(1, Math.floor(OWN_PIXEL_BUDGET / frameBytes));
  let delays = delayFrames;
  if (delays.length > fits) {
    // `fits` frames that share the loop between them, as evenly as whole 30 fps frames allow.
    const base = Math.floor(loopFrames / fits);
    const extra = loopFrames - base * fits;
    delays = Array.from({ length: fits }, (_, i) => base + (i < extra ? 1 : 0));
  }
  let hash = 0;
  for (const ch of sticker.mediaId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const colour = OWN_COLOURS[hash % OWN_COLOURS.length] ?? [0xff, 0xd1, 0x66];
  return standIn(colour, delays, width, height);
}
