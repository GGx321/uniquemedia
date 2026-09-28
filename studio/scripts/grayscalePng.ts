import { deflateSync } from "node:zlib";

/**
 * A minimal, dependency-free 8-bit grayscale PNG encoder (colour type 0, one
 * IDAT, filter type "None" per row): standards-compliant, so any real PNG
 * decoder (ffmpeg, Chromium) reads it — used instead of round-tripping a
 * pattern through ffmpeg (studio/scripts/distinctPattern.ts) so the image
 * studio/scripts/mockOpenRouter.ts serves is byte-for-byte the same pattern
 * studio/scripts/distinctPattern.test.ts hashes with src/core/pdq, not a
 * lossy re-render of it.
 */

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.alloc(4 + body.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

/** Encodes an 8-bit grayscale bitmap (row-major, one byte per pixel) as a minimal, valid, non-animated PNG. */
export function encodeGrayscalePng(width: number, height: number, gray: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`width and height must be positive integers, got ${width}x${height}`);
  }
  if (gray.length !== width * height) throw new RangeError(`expected ${width * height} grayscale bytes, got ${gray.length}`);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1);
    raw[rowStart] = 0; // filter type: None
    raw.set(gray.subarray(y * width, (y + 1) * width), rowStart + 1);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([Buffer.from(PNG_SIGNATURE), pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))]);
}
