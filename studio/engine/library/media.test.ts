import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { imageSize, isAnimatedImage } from "./media";
import { JPEG_HEADER_ONLY, PNG_1X1, WEBP_HEADER_ONLY } from "./testing/helpers";

// Real images at a known size, made by the bundled ffmpeg (as studio/node's tests do).
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-media-size-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function render(name: string, width: number, height: number, codecArgs: string[] = []): Uint8Array {
  const path = join(dir, name);
  const r = spawnSync(ffmpegPath(), ["-y", "-f", "lavfi", "-i", `mandelbrot=size=${width}x${height}`, "-frames:v", "1", ...codecArgs, path]);
  if (r.status !== 0) throw new Error(`ffmpeg could not render ${name}: ${r.stderr.toString()}`);
  return new Uint8Array(readFileSync(path));
}

describe("imageSize", () => {
  test("reads a PNG's size from its IHDR", () => {
    expect(imageSize(render("a.png", 6, 8))).toEqual({ width: 6, height: 8 });
    expect(imageSize(PNG_1X1)).toEqual({ width: 1, height: 1 });
  });

  test("reads a JPEG's size from its SOF marker, past the APP segments before it", () => {
    expect(imageSize(render("a.jpg", 864, 1152))).toEqual({ width: 864, height: 1152 });
  });

  test("reads a lossy (VP8) and a lossless (VP8L) WebP's size", () => {
    expect(imageSize(render("lossy.webp", 30, 40, ["-c:v", "libwebp", "-lossless", "0"]))).toEqual({ width: 30, height: 40 });
    expect(imageSize(render("lossless.webp", 30, 40, ["-c:v", "libwebp", "-lossless", "1"]))).toEqual({ width: 30, height: 40 });
  });

  test("reads an extended (VP8X) WebP's canvas size", () => {
    const header = [..."RIFF"].map((c) => c.charCodeAt(0)).concat([0x16, 0, 0, 0], [..."WEBPVP8X"].map((c) => c.charCodeAt(0)));
    // chunk size 10, flags, 3 reserved bytes, then width-1 and height-1 as 24-bit little endian.
    const vp8x = [10, 0, 0, 0, 0x10, 0, 0, 0, 863 & 0xff, 863 >> 8, 0, 1151 & 0xff, 1151 >> 8, 0];
    expect(imageSize(Uint8Array.from([...header, ...vp8x]))).toEqual({ width: 864, height: 1152 });
  });

  test("is null for bytes that are not an image or whose header is cut short", () => {
    expect(imageSize(new Uint8Array())).toBeNull();
    expect(imageSize(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
    expect(imageSize(JPEG_HEADER_ONLY)).toBeNull();
    expect(imageSize(WEBP_HEADER_ONLY)).toBeNull();
    expect(imageSize(PNG_1X1.subarray(0, 20))).toBeNull();
  });

  test("is null for a header that claims a zero size", () => {
    const zero = Uint8Array.from(PNG_1X1);
    zero.set([0, 0, 0, 0], 16);
    expect(imageSize(zero)).toBeNull();
  });
});

describe("isAnimatedImage", () => {
  function animation(name: string, format: string, codecArgs: string[]): Uint8Array {
    const path = join(dir, name);
    const r = spawnSync(ffmpegPath(), ["-y", "-f", "lavfi", "-i", "mandelbrot=size=30x40:rate=5", "-frames:v", "3", ...codecArgs, "-f", format, path]);
    if (r.status !== 0) throw new Error(`ffmpeg could not render ${name}: ${r.stderr.toString()}`);
    return new Uint8Array(readFileSync(path));
  }

  test("an animated PNG (an acTL chunk) is animated; a still PNG is not", () => {
    expect(isAnimatedImage(animation("anim.png", "apng", ["-plays", "0"]))).toBe(true);
    expect(isAnimatedImage(render("still.png", 30, 40))).toBe(false);
    expect(isAnimatedImage(PNG_1X1)).toBe(false);
  });

  test("an animated WebP (the VP8X animation flag and an ANIM chunk) is animated; still WebPs are not", () => {
    expect(isAnimatedImage(animation("anim.webp", "webp", ["-c:v", "libwebp", "-loop", "0"]))).toBe(true);
    expect(isAnimatedImage(render("still-lossy.webp", 30, 40, ["-c:v", "libwebp", "-lossless", "0"]))).toBe(false);
    expect(isAnimatedImage(render("still-lossless.webp", 30, 40, ["-c:v", "libwebp", "-lossless", "1"]))).toBe(false);
  });

  test("a WebP whose VP8X header sets the animation flag is animated, even without its frames", () => {
    const header = [..."RIFF"].map((c) => c.charCodeAt(0)).concat([0x16, 0, 0, 0], [..."WEBPVP8X"].map((c) => c.charCodeAt(0)));
    const vp8x = [10, 0, 0, 0, 0x02, 0, 0, 0, 29, 0, 0, 39, 0, 0];
    expect(isAnimatedImage(Uint8Array.from([...header, ...vp8x]))).toBe(true);
  });

  test("a JPEG and bytes that are not an image are not animated", () => {
    expect(isAnimatedImage(render("still.jpg", 30, 40))).toBe(false);
    expect(isAnimatedImage(Uint8Array.from([1, 2, 3]))).toBe(false);
  });
});
