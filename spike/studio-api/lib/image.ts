import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { P } from "./config";

export type MediaType = "image/png" | "image/jpeg" | "image/webp";

export function sniffMediaType(b: Uint8Array): MediaType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  return null;
}

export function extFor(mediaType: MediaType): string {
  return mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : "webp";
}

function ascii(b: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...b.subarray(at, at + len));
}
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/** Pixel size from the container header: PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X. Null when unknown. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const type = sniffMediaType(b);
  if (type === "image/png") {
    if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (type === "image/jpeg") return jpegSize(b);
  if (type === "image/webp") return webpSize(b);
  return null;
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i++; // fill bytes
      marker = b[i + 1];
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    if (i + 3 >= b.length) return null;
    const len = u16be(b, i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 8 >= b.length) return null;
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // 3-byte frame tag, then start code 9d 01 2a, then 14-bit dimensions.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

// ---------- ffmpeg ----------

function ffmpegBin(): string {
  if (!ffmpegPath) throw new Error("ffmpeg-static resolved no binary for this platform");
  return ffmpegPath;
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), ["-hide_banner", "-loglevel", "error", ...args]);
    const err: Buffer[] = [];
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`))
    );
  });
}

/**
 * Downscale to at most `maxSide` px on the long side as JPEG (~q90), cached in
 * out/refs/ under a content hash so a changed source never reuses a stale copy.
 */
export async function downscaledJpeg(src: string, maxSide: number): Promise<string> {
  const bytes = await readFile(src);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const name = `${basename(src, extname(src))}-${hash}-${maxSide}.jpg`;
  const dest = join(P.refs, name);
  if (existsSync(dest)) return dest;
  await mkdir(P.refs, { recursive: true });
  const tmp = join(P.refs, `.${name}.${process.pid}.tmp.jpg`);
  await runFfmpeg([
    "-y",
    "-i", src,
    "-vf", `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
    "-frames:v", "1",
    "-pix_fmt", "yuvj420p",
    "-q:v", "3",
    tmp,
  ]);
  await rename(tmp, dest);
  return dest;
}

export async function jpegDataUrl(path: string): Promise<string> {
  const bytes = await readFile(path);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}
