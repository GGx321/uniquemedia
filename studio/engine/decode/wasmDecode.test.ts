import { describe, expect, test } from "bun:test";
import { createWasmImageDecoder, MAX_DECODE_PIXELS, type DecodeBackend } from "./wasmDecode";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Security review, T7b section A: the engine decodes candidate/master images
// itself now (a WASM JPEG/PNG decoder), instead of round-tripping the bytes
// to Electron's main process. This file pins the pure wrapper's own rules —
// the allow-list, the pixel cap, the post-decode checks and the "every
// failure is systemic" contract (A.4) — against a fake DecodeBackend; the
// real backend (real @jsquash decode, real WASM) is exercised by
// face/parity.test.ts against fixtures and the committed reference hashes
// (captured once from Electron's nativeImage before that decode path was
// removed — parity.test.ts never talks to Electron at run time).

const JPEG_MAGIC = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1);
// A minimal, real 1x1 JPEG (SOF0 baseline) so imageSize() reads a real header.
// prettier-ignore
const JPEG_1X1 = Uint8Array.of(
  0xff,0xd8,0xff,0xdb,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,0x07,0x07,
  0x07,0x09,0x09,0x08,0x0a,0x0c,0x14,0x0d,0x0c,0x0b,0x0b,0x0c,0x19,0x12,0x13,0x0f,
  0x14,0x1d,0x1a,0x1f,0x1e,0x1d,0x1a,0x1c,0x1c,0x20,0x24,0x2e,0x27,0x20,0x22,0x2c,
  0x23,0x1c,0x1c,0x28,0x37,0x29,0x2c,0x30,0x31,0x34,0x34,0x34,0x1f,0x27,0x39,0x3d,
  0x38,0x32,0x3c,0x2e,0x33,0x34,0x32,0xff,0xc0,0x00,0x0b,0x08,0x00,0x01,0x00,0x01,
  0x01,0x01,0x11,0x00,0xff,0xc4,0x00,0x1f,0x00,0x00,0x01,0x05,0x01,0x01,0x01,0x01,
  0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,0x05,0x06,
  0x07,0x08,0x09,0x0a,0x0b,0xff,0xc4,0x00,0xb5,0x10,0x00,0x02,0x01,0x03,0x03,0x02,
  0x04,0x03,0x05,0x05,0x04,0x04,0x00,0x00,0x01,0x7d,0x01,0x02,0x03,0x00,0x04,0x11,
  0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,0x22,0x71,0x14,0x32,0x81,0x91,
  0xa1,0x08,0x23,0x42,0xb1,0xc1,0x15,0x52,0xd1,0xf0,0x24,0x33,0x62,0x72,0x82,0x09,
  0x0a,0x16,0x17,0x18,0x19,0x1a,0x25,0x26,0x27,0x28,0x29,0x2a,0x34,0x35,0x36,0x37,
  0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,0x49,0x4a,0x53,0x54,0x55,0x56,0x57,
  0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6a,0x73,0x74,0x75,0x76,0x77,
  0x78,0x79,0x7a,0x83,0x84,0x85,0x86,0x87,0x88,0x89,0x8a,0x92,0x93,0x94,0x95,0x96,
  0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,
  0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,0xc4,0xc5,0xc6,0xc7,0xc8,0xc9,0xca,0xd2,
  0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,0xe1,0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,
  0xe9,0xea,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9,0xfa,0xff,0xda,0x00,0x08,
  0x01,0x01,0x00,0x00,0x3f,0x00,0xd2,0xcf,0x20,0xff,0xd9,
);
const PNG_1X1 = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
);
const WEBP_MAGIC = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);

const RGBA_1X1 = new Uint8Array([255, 0, 0, 255]);

function fakeBackend(overrides: Partial<DecodeBackend> = {}): DecodeBackend {
  return {
    decodeJpeg: async () => ({ width: 1, height: 1, data: RGBA_1X1 }),
    decodePng: async () => ({ width: 1, height: 1, data: RGBA_1X1 }),
    ...overrides,
  };
}

describe("createWasmImageDecoder", () => {
  test("decodes a JPEG through decodeJpeg and tags the output rgba", async () => {
    const decode = createWasmImageDecoder(fakeBackend());
    const image = await decode(JPEG_1X1, new AbortController().signal);
    expect(image).toEqual({ format: "rgba", width: 1, height: 1, data: RGBA_1X1 });
  });

  test("decodes a PNG through decodePng", async () => {
    const decode = createWasmImageDecoder(fakeBackend());
    const image = await decode(PNG_1X1, new AbortController().signal);
    expect(image.format).toBe("rgba");
  });

  test("rejects unsupported formats (e.g. WebP) — systemic, not a per-photo problem", async () => {
    const decode = createWasmImageDecoder(fakeBackend());
    await expect(decode(WEBP_MAGIC, new AbortController().signal)).rejects.toThrow(/unsupported/i);
  });

  test("rejects unrecognized bytes", async () => {
    const decode = createWasmImageDecoder(fakeBackend());
    await expect(decode(Uint8Array.of(1, 2, 3, 4), new AbortController().signal)).rejects.toThrow(/unsupported/i);
  });

  /** Patches JPEG_1X1's own SOF0 (0xff 0xc0) width/height fields to `w`x`h`, for a crafted-header test. */
  function jpegWithHeaderSize(w: number, h: number): Uint8Array {
    const out = Uint8Array.from(JPEG_1X1);
    let sofAt = -1;
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i] === 0xff && out[i + 1] === 0xc0) {
        sofAt = i;
        break;
      }
    }
    if (sofAt < 0) throw new Error("unreachable: JPEG_1X1 always has an SOF0 marker");
    out[sofAt + 5] = (h >> 8) & 0xff;
    out[sofAt + 6] = h & 0xff;
    out[sofAt + 7] = (w >> 8) & 0xff;
    out[sofAt + 8] = w & 0xff;
    return out;
  }

  test("rejects a header whose pixel count exceeds MAX_DECODE_PIXELS, before ever calling the backend", async () => {
    let called = false;
    const decode = createWasmImageDecoder(
      fakeBackend({
        decodeJpeg: async () => {
          called = true;
          return { width: 1, height: 1, data: RGBA_1X1 };
        },
      }),
    );
    // A crafted JPEG header claiming 5000x5000 (25M px > the 16.7M cap).
    const huge = jpegWithHeaderSize(5000, 5000);

    await expect(decode(huge, new AbortController().signal)).rejects.toThrow(new RegExp(`${MAX_DECODE_PIXELS}`));
    expect(called).toBe(false);
  });

  // 3f.2: the own-photo importer takes camera pictures, so it asks for a higher cap of its own; the default (the face gate's) is unchanged.
  test("a decoder built with its own maxPixels accepts a header over the default cap and refuses one over its own, before the backend", async () => {
    let calls = 0;
    const decode = createWasmImageDecoder(fakeBackend({ decodeJpeg: async () => ((calls++), { width: 5000, height: 5000, data: new Uint8Array(5000 * 5000 * 4) }) }), { maxPixels: 25_000_000 });

    expect((await decode(jpegWithHeaderSize(5000, 5000), new AbortController().signal)).width).toBe(5000);
    await expect(decode(jpegWithHeaderSize(5001, 5000), new AbortController().signal)).rejects.toThrow(/25000000/);
    expect(calls).toBe(1);
  });

  test("a decoder built without options keeps the default cap", async () => {
    const decode = createWasmImageDecoder(fakeBackend({}));
    await expect(decode(jpegWithHeaderSize(5000, 5000), new AbortController().signal)).rejects.toThrow(new RegExp(`${MAX_DECODE_PIXELS}`));
  });

  // N9: the exact boundary, both sides — MAX_DECODE_PIXELS = 16_777_216 = 4096x4096 exactly.
  test("N9: accepts a JPEG header at exactly MAX_DECODE_PIXELS (4096x4096)", async () => {
    const atCap = jpegWithHeaderSize(4096, 4096);
    const decode = createWasmImageDecoder(fakeBackend({ decodeJpeg: async () => ({ width: 4096, height: 4096, data: new Uint8Array(4096 * 4096 * 4) }) }));

    const image = await decode(atCap, new AbortController().signal);

    expect(image.width).toBe(4096);
    expect(image.height).toBe(4096);
  });

  test("N9: refuses a JPEG header one pixel row over MAX_DECODE_PIXELS (4097x4096)", async () => {
    const overCap = jpegWithHeaderSize(4097, 4096);
    let called = false;
    const decode = createWasmImageDecoder(fakeBackend({ decodeJpeg: async () => ((called = true), { width: 4097, height: 4096, data: new Uint8Array(0) }) }));

    await expect(decode(overCap, new AbortController().signal)).rejects.toThrow(new RegExp(`${MAX_DECODE_PIXELS}`));
    expect(called).toBe(false);
  });

  test("N9: accepts a PNG header at exactly MAX_DECODE_PIXELS (4096x4096)", async () => {
    // PNG_1X1 with its IHDR width/height patched to 4096x4096 (both big-endian u32 at fixed offsets).
    const png = Uint8Array.from(PNG_1X1);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    view.setUint32(16, 4096); // IHDR width
    view.setUint32(20, 4096); // IHDR height
    const decode = createWasmImageDecoder(fakeBackend({ decodePng: async () => ({ width: 4096, height: 4096, data: new Uint8Array(4096 * 4096 * 4) }) }));

    const image = await decode(png, new AbortController().signal);

    expect(image.width).toBe(4096);
    expect(image.height).toBe(4096);
  });

  test("N9: refuses a PNG header one pixel row over MAX_DECODE_PIXELS (4096x4097)", async () => {
    const png = Uint8Array.from(PNG_1X1);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    view.setUint32(16, 4096);
    view.setUint32(20, 4097);
    let called = false;
    const decode = createWasmImageDecoder(fakeBackend({ decodePng: async () => ((called = true), { width: 4096, height: 4097, data: new Uint8Array(0) }) }));

    await expect(decode(png, new AbortController().signal)).rejects.toThrow(new RegExp(`${MAX_DECODE_PIXELS}`));
    expect(called).toBe(false);
  });

  test("rejects when the backend's decoded size disagrees with the header (systemic — never trust the decoder blindly)", async () => {
    const decode = createWasmImageDecoder(fakeBackend({ decodeJpeg: async () => ({ width: 2, height: 2, data: new Uint8Array(16) }) }));
    await expect(decode(JPEG_1X1, new AbortController().signal)).rejects.toThrow(/does not match/);
  });

  test("rejects when the decoded byte length disagrees with width*height*4", async () => {
    const decode = createWasmImageDecoder(fakeBackend({ decodeJpeg: async () => ({ width: 1, height: 1, data: new Uint8Array(3) }) }));
    await expect(decode(JPEG_1X1, new AbortController().signal)).rejects.toThrow(/byte/);
  });

  test("a decode that throws propagates uncaught (systemic, never turned into a retry verdict here)", async () => {
    const decode = createWasmImageDecoder(fakeBackend({ decodeJpeg: async () => { throw new Error("mozjpeg: corrupt JPEG data"); } }));
    await expect(decode(JPEG_1X1, new AbortController().signal)).rejects.toThrow(/corrupt JPEG/);
  });

  test("an already-aborted signal rejects immediately, without calling the backend", async () => {
    let called = false;
    const decode = createWasmImageDecoder(fakeBackend({ decodeJpeg: async () => { called = true; return { width: 1, height: 1, data: RGBA_1X1 }; } }));
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    await expect(decode(JPEG_1X1, controller.signal)).rejects.toThrow("run cancelled");
    expect(called).toBe(false);
  });

  test("JPEG magic bytes alone (no valid header past them) are rejected as unreadable, not passed to the backend", async () => {
    const decode = createWasmImageDecoder(fakeBackend());
    await expect(decode(JPEG_MAGIC, new AbortController().signal)).rejects.toThrow(/header/);
  });
});
