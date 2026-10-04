import { stickerById, type StickerCategoryId } from "../../shared/stickers/manifest";
import { concatBytes, PNG_SIGNATURE, pngBase64Url, pngChunk, zlibStored } from "./mockPng";

// The dev mock's stand-in for a built-in sticker's picture (3d.3b; 3d.4: animated): the dev build has no
// `studio-media://sticker/<id>`, so the mock client hands an APNG data URL instead, a sparkle in the colour of the sticker's
// category that turns and pulses over the manifest's own loop, one frame per 1/30 s like the real set. So the preview decodes and
// loops it the way the real app does. Not the sticker: never design on its look (the real one is the generated set, 3b.5).

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

const made = new Map<string, string>();

/** The four-pointed star of outer radius `r`, turned by `turn` radians, centred on the picture: its eight corners. */
function star(r: number, turn: number): [number, number][] {
  const c = SIDE / 2;
  return Array.from({ length: 8 }, (_, i): [number, number] => {
    const angle = turn + (i * Math.PI) / 4;
    const radius = i % 2 === 0 ? r : r * 0.38;
    return [c + radius * Math.cos(angle), c + radius * Math.sin(angle)];
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

/** Frame `k` of `frames`: the star a quarter turn further each loop (it looks the same after a quarter turn), pulsing once. */
function frameRows(k: number, frames: number): Uint8Array {
  const phase = k / frames;
  const points = star((SIDE / 2 - 2) * (0.78 + 0.22 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase))), (Math.PI / 2) * phase);
  const stride = 1 + SIDE / 4;
  const raw = new Uint8Array(stride * SIDE);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
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

/** A frame control: the whole picture, shown for 1/30 s, replacing the frame before. */
function fctl(sequence: number): Uint8Array {
  const out = new Uint8Array(26);
  out.set(u32(sequence, SIDE, SIDE, 0, 0), 0);
  const view = new DataView(out.buffer);
  view.setUint16(20, 1);
  view.setUint16(22, 30);
  out[24] = 0; // dispose: none
  out[25] = 0; // blend: source
  return out;
}

function standIn(category: StickerCategoryId, frames: number): Uint8Array {
  const [r, g, b] = CATEGORY_COLOURS[category];
  const header = concatBytes([u32(SIDE, SIDE), Uint8Array.from([2, 3, 0, 0, 0])]);
  const parts: Uint8Array[] = [
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk("IHDR", header),
    pngChunk("acTL", u32(frames, 0)),
    pngChunk("PLTE", Uint8Array.from([0, 0, 0, r, g, b, r, g, b])),
    pngChunk("tRNS", Uint8Array.from([0, EDGE_ALPHA, 255])),
  ];
  let sequence = 0;
  for (let k = 0; k < frames; k++) {
    parts.push(pngChunk("fcTL", fctl(sequence++)));
    const data = zlibStored(frameRows(k, frames));
    parts.push(k === 0 ? pngChunk("IDAT", data) : pngChunk("fdAT", concatBytes([u32(sequence++), data])));
  }
  parts.push(pngChunk("IEND", new Uint8Array(0)));
  return concatBytes(parts);
}

/** An animated data URL standing in for built-in sticker `stickerId` (made once), or null when the set does not have it. */
export function mockStickerUrl(stickerId: string): string | null {
  const sticker = stickerById(stickerId);
  if (sticker === undefined) return null;
  const known = made.get(sticker.id);
  if (known !== undefined) return known;
  const url = pngBase64Url(standIn(sticker.category, sticker.loopFrames));
  made.set(sticker.id, url);
  return url;
}
