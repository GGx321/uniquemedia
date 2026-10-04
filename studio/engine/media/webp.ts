// What a WebP's own header says (Stage 3, 3f.2): its size and whether it animates. Read BEFORE ffmpeg is started, so an animated file and a
// file whose header claims too many pixels are turned away without a child process. Pure and bounded by the buffer: the RIFF size is not
// trusted, every chunk length is checked against the bytes that are there, and the walk moves forward by at least a chunk header.

export interface WebpInfo {
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
}

const VP8X_ANIMATION_FLAG = 0x02;

const fourcc = (bytes: Uint8Array, at: number): string => (at + 4 <= bytes.length ? String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0) : "");
const u16le = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u24le = (bytes: Uint8Array, at: number): number => u16le(bytes, at) | ((bytes[at + 2] ?? 0) << 16);

interface Size {
  width: number;
  height: number;
}

/** A lossy keyframe's header: 3 bytes of frame tag, the start code 9D 01 2A, then two 14-bit sizes. */
function lossySize(bytes: Uint8Array, at: number, length: number): Size | null {
  if (length < 10 || bytes[at + 3] !== 0x9d || bytes[at + 4] !== 0x01 || bytes[at + 5] !== 0x2a) return null;
  const width = u16le(bytes, at + 6) & 0x3fff;
  const height = u16le(bytes, at + 8) & 0x3fff;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** A lossless header: the signature 0x2F, then `width - 1` and `height - 1` as 14 bits each. */
function losslessSize(bytes: Uint8Array, at: number, length: number): Size | null {
  if (length < 5 || bytes[at] !== 0x2f) return null;
  const bits = ((bytes[at + 1] ?? 0) | ((bytes[at + 2] ?? 0) << 8) | ((bytes[at + 3] ?? 0) << 16) | ((bytes[at + 4] ?? 0) << 24)) >>> 0;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/** The size and animation of a WebP, or null when the bytes are not a WebP whose size can be read. Never throws. */
export function webpInfo(bytes: Uint8Array): WebpInfo | null {
  if (fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WEBP") return null;
  let canvas: Size | null = null;
  let image: Size | null = null;
  let animated = false;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const type = fourcc(bytes, at);
    const length = new DataView(bytes.buffer, bytes.byteOffset + at + 4, 4).getUint32(0, true);
    const body = at + 8;
    if (body + length > bytes.length) break;
    if (type === "ANIM" || type === "ANMF") animated = true;
    else if (type === "VP8X" && length >= 10 && canvas === null) {
      if (((bytes[body] ?? 0) & VP8X_ANIMATION_FLAG) !== 0) animated = true;
      canvas = { width: u24le(bytes, body + 4) + 1, height: u24le(bytes, body + 7) + 1 };
    } else if (type === "VP8 " && image === null) image = lossySize(bytes, body, length);
    else if (type === "VP8L" && image === null) image = losslessSize(bytes, body, length);
    // Chunks are padded to an even length.
    at = body + length + (length % 2);
  }
  // The bigger of the two, side by side: ffmpeg decodes at the BITSTREAM's size whatever the canvas says, and a canvas can claim less.
  const size = canvas === null ? image : image === null ? canvas : { width: Math.max(canvas.width, image.width), height: Math.max(canvas.height, image.height) };
  return size === null ? null : { width: size.width, height: size.height, animated };
}
