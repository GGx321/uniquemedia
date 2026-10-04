import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFfmpegOk } from "../render/ffmpeg.testkit";
import type { MediaKind } from "../../shared/engine";
import type { MediaImportRequest } from "./imports";
import type { StagedMedia, WorkFile } from "./staging";
import type { MediaFormat } from "./sniff";

// Test support for the own-photo importer (3f.2): small pictures made by the bundled ffmpeg from pixels a test chose, the EXIF block
// each container carries, and the hand-off a job gives an importer (a staged file, a signal, a work file). Test-only: never imported by
// production code.

export type Rgb = readonly [number, number, number];

export const RED: Rgb = [230, 20, 20];
export const BLUE: Rgb = [20, 20, 230];

/** Raw RGB24 pixels, `w` x `h`, whose top-left quadrant is `corner` and everything else `rest`. */
export function quadrantPixels(w: number, h: number, corner: Rgb, rest: Rgb): Uint8Array {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const colour = x < w / 2 && y < h / 2 ? corner : rest;
      rgb.set(colour, (y * w + x) * 3);
    }
  }
  return rgb;
}

export type EncodeKind = "jpeg" | "png" | "webp" | "webp-lossless";

const ENCODERS: Record<EncodeKind, readonly string[]> = {
  jpeg: ["-c:v", "mjpeg", "-q:v", "1", "-pix_fmt", "yuvj420p", "-f", "mjpeg"],
  png: ["-c:v", "png", "-f", "image2pipe"],
  webp: ["-c:v", "libwebp", "-quality", "95", "-f", "webp"],
  "webp-lossless": ["-c:v", "libwebp", "-lossless", "1", "-f", "webp"],
};

/** Encodes raw RGB24 pixels as a still picture of `kind` with the bundled ffmpeg (a scratch file in `dir`). */
export async function encodePixels(dir: string, name: string, rgb: Uint8Array, w: number, h: number, kind: EncodeKind): Promise<Uint8Array> {
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, `${name}.rgb`);
  const out = join(dir, `${name}.${kind}.out`);
  writeFileSync(raw, rgb);
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${w}x${h}`, "-i", raw, "-frames:v", "1", ...ENCODERS[kind], out]);
  const bytes = new Uint8Array(await readFile(out));
  await rm(raw, { force: true });
  await rm(out, { force: true });
  return bytes;
}

/** A picture whose top-left quadrant is red and the rest blue. */
export async function quadrantPicture(dir: string, name: string, w: number, h: number, kind: EncodeKind): Promise<Uint8Array> {
  return encodePixels(dir, name, quadrantPixels(w, h, RED, BLUE), w, h, kind);
}

/** An animated WebP of three frames (made from three raw frames), the shape that must be refused. */
export async function animatedWebp(dir: string, name: string, w: number, h: number): Promise<Uint8Array> {
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, `${name}.rgb`);
  const out = join(dir, `${name}.webp.out`);
  const frames = [quadrantPixels(w, h, RED, BLUE), quadrantPixels(w, h, BLUE, RED), quadrantPixels(w, h, RED, RED)];
  writeFileSync(raw, Buffer.concat(frames));
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${w}x${h}`, "-framerate", "2", "-i", raw, "-frames:v", "3", "-c:v", "libwebp", "-loop", "0", "-f", "webp", out]);
  const bytes = new Uint8Array(await readFile(out));
  await rm(raw, { force: true });
  await rm(out, { force: true });
  return bytes;
}

const u16be = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/** A big-endian TIFF block whose IFD0 holds the orientation, and a camera maker string, as a phone writes them. */
export function tiffWithOrientation(orientation: number): number[] {
  const entry = (tag: number, type: number, count: number, value: number[]): number[] => [...u16be(tag), ...u16be(type), ...u32be(count), ...value];
  // Entry 1: Make (ASCII, 5 bytes, at offset 38); entry 2: Orientation. The block is 8 + 2 + 2*12 + 4 = 38 bytes, then the string.
  return [...ascii("MM"), ...u16be(0x2a), ...u32be(8), ...u16be(2), ...entry(0x010f, 2, 5, u32be(38)), ...entry(0x0112, 3, 1, [...u16be(orientation), 0, 0]), ...u32be(0), ...ascii("Acme"), 0];
}

/** `jpeg` with an APP1 EXIF segment (the orientation and a maker string) right after its SOI. */
export function jpegWithExif(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = tiffWithOrientation(orientation);
  const segment = [0xff, 0xe1, ...u16be(2 + 6 + tiff.length), ...ascii("Exif"), 0, 0, ...tiff];
  return Uint8Array.from([...jpeg.subarray(0, 2), ...segment, ...jpeg.subarray(2)]);
}

/** `png` with an `eXIf` chunk right after its IHDR (the CRC is not checked by anything that reads it). */
export function pngWithExif(png: Uint8Array, orientation: number): Uint8Array {
  const tiff = tiffWithOrientation(orientation);
  const at = 8 + 12 + 13;
  return Uint8Array.from([...png.subarray(0, at), ...u32be(tiff.length), ...ascii("eXIf"), ...tiff, 0, 0, 0, 0, ...png.subarray(at)]);
}

/** `webp` with an `EXIF` chunk and a VP8X header that says so. */
export function webpWithExif(webp: Uint8Array, orientation: number, size: { w: number; h: number }): Uint8Array {
  const tiff = tiffWithOrientation(orientation);
  const exif = [...ascii("EXIF"), ...u32le(tiff.length), ...tiff, ...(tiff.length % 2 === 1 ? [0] : [])];
  const body = Array.from(webp.subarray(12));
  const u24 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
  const vp8x = [...ascii("VP8X"), ...u32le(10), 0x08, 0, 0, 0, ...u24(size.w - 1), ...u24(size.h - 1)];
  const inner = [...ascii("WEBP"), ...vp8x, ...body, ...exif];
  return Uint8Array.from([...ascii("RIFF"), ...u32le(inner.length), ...inner]);
}

/** Every marker of a JPEG up to its scan, so a test can say which metadata segments a file holds. */
export function jpegSegmentMarkers(jpeg: Uint8Array): number[] {
  const markers: number[] = [];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1] ?? 0;
    markers.push(marker);
    if (marker === 0xda) break;
    at += 2 + (((jpeg[at + 2] ?? 0) << 8) | (jpeg[at + 3] ?? 0));
  }
  return markers;
}

/** The hand-off of a job to an importer: the staged file (written in `dir`), a signal and a work-file maker that holds every name it gives. */
export interface Handoff {
  readonly request: MediaImportRequest;
  readonly controller: AbortController;
  /** The work files given so far, in order. */
  readonly works: readonly WorkFile[];
}

export interface HandoffOptions {
  readonly format: MediaFormat;
  readonly name?: string;
  /** The kind the staging says the bytes are; a photo by default. */
  readonly kind?: MediaKind;
  /** What the staging says the bytes hash to; the real hash by default. */
  readonly sha256?: string;
  readonly signal?: AbortSignal;
}

export async function handoff(dir: string, bytes: Uint8Array, options: HandoffOptions): Promise<Handoff> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "staged.media");
  await writeFile(path, bytes);
  const controller = new AbortController();
  const works: WorkFile[] = [];
  let next = 0;
  const staged: StagedMedia = {
    stagingId: "staged-00000001",
    kind: options.kind ?? "photo",
    format: options.format,
    bytes: bytes.length,
    sha256: options.sha256 ?? createHash("sha256").update(bytes).digest("hex"),
    path,
    head: bytes.subarray(0, 64 * 1024),
    dispose: async () => undefined,
  };
  const request: MediaImportRequest = {
    staged,
    name: options.name ?? "photo",
    signal: options.signal ?? controller.signal,
    workFile: async () => {
      const workPath = join(dir, `work-${String(++next).padStart(2, "0")}.media`);
      const work: WorkFile = { path: workPath, release: async () => void (await rm(workPath, { force: true })) };
      works.push(work);
      return work;
    },
  };
  return { request, controller, works };
}
