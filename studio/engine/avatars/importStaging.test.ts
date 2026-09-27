import { describe, expect, test } from "bun:test";
import { JPEG_HEADER_ONLY, PNG_1X1 } from "../library/testing/helpers";
import { MAX_SOURCE_PIXELS } from "../../node/downscale";
import { checkImportPhoto } from "./importStaging";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6c: design constraint 2 — the engine validates the imported image (media
// checks, not animated, a readable size) before anything is downscaled or
// paid for. Pure and synchronous: no ffmpeg here (that is the caller's job,
// once the checks below already passed).

function animatedWebp(): Uint8Array {
  const header = [..."RIFF"].map((c) => c.charCodeAt(0)).concat([0x16, 0, 0, 0], [..."WEBPVP8X"].map((c) => c.charCodeAt(0)));
  const vp8x = [10, 0, 0, 0, 0x02, 0, 0, 0, 29, 0, 0, 39, 0, 0]; // animation flag set
  return Uint8Array.from([...header, ...vp8x]);
}

/** A minimal PNG (signature + a bare IHDR) declaring `width`×`height` — no real pixel data, since imageSize() only reads the header. */
function pngWithSize(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([..."IHDR"].map((c) => c.charCodeAt(0)), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("checkImportPhoto", () => {
  test("accepts a still PNG, with its media type and size", () => {
    expect(checkImportPhoto(PNG_1X1)).toEqual({ ok: true, info: { mediaType: "image/png", width: 1, height: 1 } });
  });

  test("rejects bytes that are not a known image format", () => {
    expect(checkImportPhoto(Uint8Array.from([1, 2, 3, 4]))).toEqual({ ok: false, reason: "not-an-image" });
  });

  test("rejects an animated image", () => {
    expect(checkImportPhoto(animatedWebp())).toEqual({ ok: false, reason: "animated" });
  });

  test("rejects an image whose header is cut short: the format sniffs, but the size cannot be read", () => {
    expect(checkImportPhoto(JPEG_HEADER_ONLY)).toEqual({ ok: false, reason: "unreadable-size" });
  });

  test("rejects an empty buffer", () => {
    expect(checkImportPhoto(new Uint8Array())).toEqual({ ok: false, reason: "not-an-image" });
  });

  // M4: refused for free, by the header's own declared size, before ffmpeg
  // is ever spawned to (eventually) refuse it the expensive way.
  test("rejects an image whose declared size is above MAX_SOURCE_PIXELS", () => {
    const width = 5_000;
    const height = 4_000; // 20_000_000 > MAX_SOURCE_PIXELS (16_777_216)
    expect(width * height).toBeGreaterThan(MAX_SOURCE_PIXELS);
    expect(checkImportPhoto(pngWithSize(width, height))).toEqual({ ok: false, reason: "too-many-pixels" });
  });

  test("accepts an image exactly at MAX_SOURCE_PIXELS (4096×4096)", () => {
    expect(4096 * 4096).toBe(MAX_SOURCE_PIXELS);
    expect(checkImportPhoto(pngWithSize(4096, 4096))).toEqual({ ok: true, info: { mediaType: "image/png", width: 4096, height: 4096 } });
  });
});
