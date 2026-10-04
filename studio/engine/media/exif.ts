// Studio's own EXIF orientation reader (Stage 3, 3f.2). It reads ONE number, IFD0 tag 0x0112, out of bytes the owner picked:
//   - a JPEG's APP1 segment ("Exif\0\0" and a TIFF block),
//   - a PNG's `eXIf` chunk (a TIFF block),
//   - a WebP's `EXIF` chunk (a TIFF block, some writers put the "Exif\0\0" header in front of it).
// jsquash and ffmpeg ignore the orientation of a still, so the photo importer reads it here and turns the pixels itself.
//
// PURE and BOUNDED. It never throws and never reads outside the buffer it was given: every length and offset comes from the bytes and is
// checked against what is left before it is used. Nothing here follows a chain: only IFD0 is read, so an offset that loops on itself
// cannot make it loop, and a JPEG or RIFF walk always moves forward by at least the header it just read. Anything it cannot read (a cut
// header, a wrong magic, a tag of the wrong type, a value that is not 1 to 8) is `1`, upright: a photo is never refused for its metadata.

/** The EXIF orientation values: 1 upright, 2 mirrored, 3 turned 180, 4 mirrored vertically, 5 to 8 the turned quarter turns. */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type ExifContainer = "jpeg" | "png" | "webp";

const UPRIGHT: Orientation = 1;
const ORIENTATION_TAG = 0x0112;
const TYPE_SHORT = 3;
const ENTRY_BYTES = 12;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0];

function orientationOf(value: number): Orientation {
  switch (value) {
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
      return value;
    default:
      return UPRIGHT;
  }
}

const startsWith = (bytes: Uint8Array, at: number, prefix: readonly number[]): boolean => at >= 0 && at + prefix.length <= bytes.length && prefix.every((b, i) => bytes[at + i] === b);
const fourcc = (bytes: Uint8Array, at: number): string => (at + 4 <= bytes.length ? String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0) : "");

/** The orientation in a TIFF block `bytes[start, end)`, or 1. Only IFD0 is read. */
function readTiff(bytes: Uint8Array, start: number, end: number): Orientation {
  if (start < 0 || end > bytes.length || end - start < 8) return UPRIGHT;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return UPRIGHT;
  const little = order === 0x4949;
  if (view.getUint16(2, little) !== 0x002a) return UPRIGHT;
  const ifd = view.getUint32(4, little);
  // IFD0 starts after the 8-byte header (an offset into the header is a loop on it) and its count must fit.
  if (ifd < 8 || ifd + 2 > view.byteLength) return UPRIGHT;
  const count = view.getUint16(ifd, little);
  const first = ifd + 2;
  for (let i = 0; i < count; i++) {
    const at = first + i * ENTRY_BYTES;
    if (at + ENTRY_BYTES > view.byteLength) return UPRIGHT;
    if (view.getUint16(at, little) !== ORIENTATION_TAG) continue;
    if (view.getUint16(at + 2, little) !== TYPE_SHORT || view.getUint32(at + 4, little) !== 1) return UPRIGHT;
    return orientationOf(view.getUint16(at + 8, little));
  }
  return UPRIGHT;
}

function readJpeg(bytes: Uint8Array): Orientation {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return UPRIGHT;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return UPRIGHT;
    const marker = bytes[at + 1] ?? 0;
    // Fill bytes: any run of 0xFF before the marker byte.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Start of scan and end of image: the metadata is behind us. Standalone markers (RSTn, TEM, SOI) carry no length.
    if (marker === 0xda || marker === 0xd9) return UPRIGHT;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    // A segment's length counts its own two bytes, so below 2 it is malformed (it ends inside its own length field): the file is not read on. (The walk would still advance, by the marker's two bytes at least; the point is that nothing after a broken length can be trusted.)
    if (length < 2) return UPRIGHT;
    const bodyStart = at + 4;
    const bodyEnd = at + 2 + length;
    if (bodyEnd > bytes.length) return UPRIGHT;
    if (marker === 0xe1 && startsWith(bytes, bodyStart, EXIF_HEADER)) return readTiff(bytes, bodyStart + EXIF_HEADER.length, bodyEnd);
    at = bodyEnd;
  }
  return UPRIGHT;
}

function readPng(bytes: Uint8Array): Orientation {
  if (!startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return UPRIGHT;
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
    const type = fourcc(bytes, at + 4);
    const bodyStart = at + 8;
    // The body and its 4-byte CRC must be inside the buffer; a length with the top bit set is out of the format's range anyway.
    if (length > 0x7fff_ffff || bodyStart + length + 4 > bytes.length) return UPRIGHT;
    if (type === "eXIf") return readTiff(bytes, bodyStart, bodyStart + length);
    if (type === "IEND") return UPRIGHT;
    at = bodyStart + length + 4;
  }
  return UPRIGHT;
}

function readWebp(bytes: Uint8Array): Orientation {
  if (fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WEBP") return UPRIGHT;
  // The RIFF size is not trusted: only the bytes that are there are walked.
  let at = 12;
  while (at + 8 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + at + 4, 4).getUint32(0, true);
    const bodyStart = at + 8;
    if (bodyStart + length > bytes.length) return UPRIGHT;
    if (fourcc(bytes, at) === "EXIF") {
      const skip = startsWith(bytes, bodyStart, EXIF_HEADER) ? EXIF_HEADER.length : 0;
      return readTiff(bytes, bodyStart + skip, bodyStart + length);
    }
    // Chunks are padded to an even length.
    at = bodyStart + length + (length % 2);
  }
  return UPRIGHT;
}

/** The EXIF orientation of `bytes`, read as `container`; `1` when there is none or it cannot be read. Never throws. */
export function readOrientation(bytes: Uint8Array, container: ExifContainer): Orientation {
  switch (container) {
    case "jpeg":
      return readJpeg(bytes);
    case "png":
      return readPng(bytes);
    case "webp":
      return readWebp(bytes);
  }
}
