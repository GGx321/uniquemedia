import type { MediaUnsupportedReason } from "../shared/engine";
import { SMOKE_TEST_PNG } from "../engine/decode/realBackend";
import { PNG_1X1 } from "../engine/library/testing/sampleData";
import { buildGif, framesOf } from "../shared/stickers/gif.testkit";

// The pure parts of the packaged smoke's own-media scenario (3f.1b), kept apart so they are tested. The scenario drives `media.pickImport`
// through main's E2E dialog stand-in (`--studio-pick-media`, one path): the file at that path is REWRITTEN between picks, one tiny file per
// case, and picked with `any`, so the kind comes from the bytes (never the name). Only a photo is accepted, by the real photo importer
// (3f.2: decoded, turned upright and stored as a JPEG with no metadata); a 1x1 picture and an animated WebP are refused by it. Every other
// kind has no importer yet and is refused `not-yet-supported`, except a video (3f.3a): a file that is only a header is accepted into a JOB, which
// the importer's own box walker fails (`format`), and the real clip (`MEDIA_SMOKE_CLIP`) is imported at the end.

/** What one pick of a file must come to: a job that is started, or the refusal's reason. */
export type MediaSmokeExpectation = { readonly job: true } | { readonly refused: MediaUnsupportedReason } | { readonly failed: MediaUnsupportedReason };

export interface MediaSmokeFile {
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly expect: MediaSmokeExpectation;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/** An ISO box file's first box: `ftyp` with a brand, 24 bytes. Enough to be told apart by the engine's sniffing and for nothing else. */
function ftyp(brand: string): Uint8Array {
  return Uint8Array.from([0, 0, 0, 24, ...ascii("ftyp"), ...ascii(brand), 0, 0, 0, 0, ...ascii(brand), ...ascii("mp41")]);
}

const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const riffChunk = (type: string, body: number[]): number[] => [...ascii(type), ...u32le(body.length), ...body];

/** An animated WebP's headers only (a 2x2 canvas with the animation flag, an ANIM and one ANMF chunk): the importer turns it away from them. */
function animatedWebpHeaders(): Uint8Array {
  const inner = [...ascii("WEBP"), ...riffChunk("VP8X", [0x02, 0, 0, 0, 1, 0, 0, 1, 0, 0]), ...riffChunk("ANIM", [0, 0, 0, 0, 0, 0]), ...riffChunk("ANMF", new Array<number>(16).fill(0))];
  return Uint8Array.from([...ascii("RIFF"), ...u32le(inner.length), ...inner]);
}

/** In the order they are picked: the photo first (the one that is stored), then each refusal. */
export const MEDIA_SMOKE_FILES: readonly MediaSmokeFile[] = [
  { label: "photo", bytes: SMOKE_TEST_PNG, expect: { job: true } },
  { label: "tiny", bytes: PNG_1X1, expect: { failed: "too-small" } },
  { label: "animated-webp", bytes: animatedWebpHeaders(), expect: { failed: "animated-webp" } },
  { label: "video", bytes: ftyp("isom"), expect: { failed: "format" } },
  // 3f.4: an M4A head with no stream in it is audio by its bytes, so the music importer takes it into a job and turns it away inside, as a format.
  { label: "audio", bytes: ftyp("M4A "), expect: { failed: "format" } },
  // 3f.5: a sticker has an importer, so a GIF that is only a header is taken as a job and refused INSIDE it (a truncated file is `format`).
  { label: "broken-gif", bytes: Uint8Array.from([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0]), expect: { failed: "format" } },
  { label: "text", bytes: Uint8Array.from(ascii("just some notes, not a media file\n")), expect: { refused: "format" } },
  { label: "heic", bytes: ftyp("heic"), expect: { refused: "heic" } },
];

/** The name the dialog stand-in's one path has, and what the stored photo's record must say of it: the importer's own JPEG (its size is the ffmpeg build's, so it is not pinned). */
export const MEDIA_SMOKE_STORED = { kind: "photo", name: "smoke-media.png", width: 2, height: 2, extension: "jpg" } as const;

/** A mono 8-bit PCM WAV of `samples` samples at 8 kHz: a quiet square wave, so it is audio and not silence. */
function tinyWav(samples: number): Uint8Array {
  const body = Array.from({ length: samples }, (_, i) => (Math.floor(i / 20) % 2 === 0 ? 150 : 106));
  return Uint8Array.from([...ascii("RIFF"), ...u32le(36 + samples), ...ascii("WAVE"), ...ascii("fmt "), ...u32le(16), 1, 0, 1, 0, ...u32le(8000), ...u32le(8000), 1, 0, 8, 0, ...ascii("data"), ...u32le(samples), ...body]);
}

/**
 * The own TRACK of the packaged run (3f.4): a real file the music importer takes, in the packaged engine with the packaged ffmpeg (probe, pinned encode,
 * check of the output). 4.5 s of tone as a WAV is 36 KB (the shortest track the library keeps is the shortest montage, 4 s: `MIN_TRACK_MS`, 3f.6); the stored file is
 * an AAC M4A (a whole number of 1024-sample frames, about 4.5 s).
 */
export const MEDIA_SMOKE_TRACK = { kind: "audio", extension: "m4a", minMs: 4_400, maxMs: 4_700, bytes: tinyWav(36_000) } as const;

/** The markers of a JPEG's metadata segments (APPn: JFIF, EXIF, XMP, ICC; COM: a comment) before its scan. The stored photo must have none. */
export function jpegMetadataMarkers(jpeg: Uint8Array): number[] {
  const found: number[] = [];
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return found;
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1] ?? 0;
    if (marker === 0xda || marker === 0xd9) break;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) found.push(marker);
    const length = ((jpeg[at + 2] ?? 0) << 8) | (jpeg[at + 3] ?? 0);
    if (length < 2) break;
    at += 2 + length;
  }
  return found;
}

/**
 * Problems with the library's `media/` folder (its names, without the `.staging` folder) after one photo was imported: exactly the stored
 * file `<id>.<ext>` and its record `<id>.json` must be there. Anything else is what a failed or crashed import leaves behind (a copy, a
 * part file, a temp file, an orphan) or what a cleanup missed.
 */
export function mediaRecordFileProblems(names: readonly string[], mediaId: string, extension: string): string[] {
  const wanted = [`${mediaId}.json`, `${mediaId}.${extension}`];
  return [...wanted.filter((name) => !names.includes(name)).map((name) => `${name} is missing`), ...names.filter((name) => !wanted.includes(name)).map((name) => `${name} is left in media/`)];
}

// ---------- own stickers (3f.5) ----------

/**
 * The packaged smoke's own-sticker files, picked with `any` through the same dialog stand-in (the kind is read from the bytes). A 6x4 GIF of three
 * frames of 10 cs becomes, in the packaged engine (the bounded GIF reader, the packaged ffmpeg's two decodes, the encode worker thread inside the asar),
 * an APNG of the same canvas with three delays of 3 slots on the 30 fps grid; a GIF of one frame fails as `not-animated`, a truncated one as `format`.
 */
export const STICKER_SMOKE_FILES: readonly MediaSmokeFile[] = [
  { label: "animated-gif", bytes: buildGif({ width: 6, height: 4, frames: framesOf(3, 10) }), expect: { job: true } },
  { label: "still-gif", bytes: buildGif({ width: 6, height: 4, frames: framesOf(1, 10) }), expect: { failed: "not-animated" } },
  { label: "broken-gif", bytes: Uint8Array.from([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0]), expect: { failed: "format" } },
];

/** What the stored sticker's record must say of the animated GIF, and the extension of the stored APNG. */
export const STICKER_SMOKE_STORED = { kind: "sticker", name: "smoke-sticker.gif", width: 6, height: 4, loopFrames: 9, delayFrames: [3, 3, 3], extension: "png" } as const;
/**
 * The real clip the packaged smoke imports (3f.3a): an HEVC HLG clip, variable frame rate, turned a quarter, in a QuickTime file (an iPhone held
 * upright). It is the committed fixture `video/testing/fixtures/hevc-hlg-rotated-vfr.mov`, 4 KB: the packaged ffmpeg of each operating system
 * (macOS 6.0, Windows 6.1.1) must turn it into a 96 x 192 constant-rate SDR H.264 clip.
 */
export const MEDIA_SMOKE_CLIP = { fixture: "hevc-hlg-rotated-vfr.mov", width: 96, height: 192, hdrToSdr: true, minDurationMs: 700, maxDurationMs: 770 } as const;
