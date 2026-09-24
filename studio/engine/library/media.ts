/** The only image formats the library stores or serves, keyed by file extension. */
export const IMAGE_EXTENSIONS = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

export type ImageExtension = keyof typeof IMAGE_EXTENSIONS;
export type ImageMediaType = (typeof IMAGE_EXTENSIONS)[ImageExtension];

export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export function isImageExtension(ext: string): ext is ImageExtension {
  return Object.hasOwn(IMAGE_EXTENSIONS, ext);
}

/** The image format a byte buffer really is, from its magic number. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}

export function extensionFor(mediaType: ImageMediaType): ImageExtension {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

export interface ImageSize {
  width: number;
  height: number;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/** The byte at `at`; 0 past the end, so a short header reads as a zero size and is refused. */
function byteAt(bytes: Uint8Array, at: number): number {
  return bytes[at] ?? 0;
}

function u16be(bytes: Uint8Array, at: number): number {
  return (byteAt(bytes, at) << 8) | byteAt(bytes, at + 1);
}

function u16le(bytes: Uint8Array, at: number): number {
  return byteAt(bytes, at) | (byteAt(bytes, at + 1) << 8);
}

function u24le(bytes: Uint8Array, at: number): number {
  return byteAt(bytes, at) | (byteAt(bytes, at + 1) << 8) | (byteAt(bytes, at + 2) << 16);
}

function u32be(bytes: Uint8Array, at: number): number {
  return byteAt(bytes, at) * 0x1000000 + ((byteAt(bytes, at + 1) << 16) | (byteAt(bytes, at + 2) << 8) | byteAt(bytes, at + 3));
}

function positive(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  return positive(u32be(bytes, 16), u32be(bytes, 20));
}

/** Walks the JPEG segments to the first start-of-frame marker. */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 3 < bytes.length) {
    if (byteAt(bytes, i) !== 0xff) return null;
    let marker = byteAt(bytes, i + 1);
    // Fill bytes: any number of 0xff before the marker.
    while (marker === 0xff && i + 2 < bytes.length) {
      i++;
      marker = byteAt(bytes, i + 1);
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    // End of image or start of scan before any frame header.
    if (marker === 0xd9 || marker === 0xda) return null;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (i + 8 >= bytes.length) return null;
      return positive(u16be(bytes, i + 7), u16be(bytes, i + 5));
    }
    i += 2 + u16be(bytes, i + 2);
  }
  return null;
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    // A 3-byte frame tag, the start code 9d 01 2a, then 14-bit dimensions.
    if (byteAt(bytes, 23) !== 0x9d || byteAt(bytes, 24) !== 0x01 || byteAt(bytes, 25) !== 0x2a) return null;
    return positive(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (byteAt(bytes, 20) !== 0x2f) return null;
    const bits = (byteAt(bytes, 21) | (byteAt(bytes, 22) << 8) | (byteAt(bytes, 23) << 16) | (byteAt(bytes, 24) << 24)) >>> 0;
    return positive((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") return positive(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  return null;
}

/** Pixel size read from the container header (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X); null when it cannot be read. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  switch (sniffImageMediaType(bytes)) {
    case "image/png":
      return pngSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    case null:
      return null;
  }
}

function u32le(bytes: Uint8Array, at: number): number {
  return (byteAt(bytes, at) | (byteAt(bytes, at + 1) << 8) | (byteAt(bytes, at + 2) << 16) | (byteAt(bytes, at + 3) << 24)) >>> 0;
}

/** An APNG declares its animation (acTL) before the first image data. */
function isAnimatedPng(bytes: Uint8Array): boolean {
  for (let at = 8; at + 8 <= bytes.length; ) {
    const type = ascii(bytes, at + 4, 4);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    at += 12 + u32be(bytes, at);
  }
  return false;
}

/** An animated WebP sets the VP8X animation flag, and carries ANIM/ANMF chunks. */
function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (ascii(bytes, 12, 4) === "VP8X" && (byteAt(bytes, 20) & 0x02) !== 0) return true;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const type = ascii(bytes, at, 4);
    if (type === "ANIM" || type === "ANMF") return true;
    const size = u32le(bytes, at + 4);
    at += 8 + size + (size % 2);
  }
  return false;
}

/**
 * Whether the image has more than one frame: an APNG, or an animated WebP.
 * The age check sees the frame a decoder picks, which need not be the one a
 * viewer shows, so an animated image is never judged or stored.
 */
export function isAnimatedImage(bytes: Uint8Array): boolean {
  switch (sniffImageMediaType(bytes)) {
    case "image/png":
      return isAnimatedPng(bytes);
    case "image/webp":
      return isAnimatedWebp(bytes);
    case "image/jpeg":
    case null:
      return false;
  }
}
