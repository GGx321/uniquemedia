import { open, readFile } from "node:fs/promises";

/**
 * Three places in a MOV or MP4 where ffmpeg's muxer signs its work without any
 * flag to stop it — not `-map_metadata -1`, not `bitexact`:
 *
 *  - `ftyp.minor_version`: hardcoded 0x200 for both brands. An iPhone writes 0.
 *  - the vendor field of the `avc1` sample entry: hardcoded `FFMP` in MOV
 *    mode (the muxer writes zeros there for MP4). An iPhone writes zeros, and
 *    ffprobe shows the field as `vendor_id`.
 *  - the compressor name of the `avc1` sample entry: `Lavc<ver> libx264`, or
 *    `Lavc libx264` under `bitexact`. The iphone branch overrides it with
 *    `encoder=H.264` at encode time; the clean branch writes nothing there,
 *    so the muxer's default is blanked here. ffprobe shows it as `encoder`.
 *
 * Each is a fixed-size field at a fixed place in a fixed layout, so they are
 * patched in place after the render, and ONLY where the layout is exactly the
 * one the muxer produces. Anything else is a file this code did not write,
 * and it is left alone: the walker throws on a structure it does not recognise
 * rather than guess at an offset, skips a vendor that is neither `FFMP` nor
 * zero, and skips a compressor name that does not begin with `Lavc`.
 */

/** A field inside a MOV/MP4 file that carries ffmpeg's signature. */
export type MovSignatureField = "ftyp.minor_version" | "stsd.vendor" | "stsd.compressor_name";

/** One field to zero, at an absolute byte offset in the file. Its length is a
 *  property of the field, not of the patch — see `FIELD_LENGTH`. */
export interface MovSignaturePatch {
  field: MovSignatureField;
  offset: number;
}

/** How many bytes each field spans: the two four-byte fields, and the 32-byte
 *  Pascal string (1 length byte + 31) that holds the compressor name. */
const FIELD_LENGTH: Record<MovSignatureField, number> = {
  "ftyp.minor_version": 4,
  "stsd.vendor": 4,
  "stsd.compressor_name": 32,
};

/** `ftyp`: size(4) type(4) major_brand(4) minor_version(4) compatible... */
const FTYP_MAJOR_BRAND_OFFSET = 8;
const FTYP_MINOR_VERSION_OFFSET = 12;
/** `qt  ` is what `-f mov` writes; `isom` is what the MP4 muxer writes. */
const FFMPEG_BRANDS = new Set(["qt  ", "isom"]);

/**
 * QuickTime sample entry: size(4) type(4) reserved(6) data_ref_index(2), then
 * for both the video and the sound description: version(2) revision(2)
 * vendor(4). ffmpeg's `mov_write_video_tag` and `mov_write_audio_tag` write
 * exactly this; only these two entry types are looked at.
 */
const SAMPLE_ENTRY_VENDOR_OFFSET = 20;
const SAMPLE_ENTRIES_WITH_VENDOR = new Set(["avc1", "mp4a"]);
const FFMPEG_VENDOR = "FFMP";

/**
 * The video description continues: temporal quality(4) spatial quality(4)
 * width(2) height(2) horizontal resolution(4) vertical resolution(4)
 * reserved(4) frame count(2), and at +50 the compressor name — a Pascal
 * string in a 32-byte field, so its length byte can say at most 31. Only the
 * video entry has one; the sound description ends before this point.
 */
const SAMPLE_ENTRY_COMPRESSOR_OFFSET = 50;
const COMPRESSOR_FIELD_LENGTH = FIELD_LENGTH["stsd.compressor_name"];
const VIDEO_SAMPLE_ENTRY = "avc1";
const FFMPEG_COMPRESSOR_PREFIX = "Lavc";

/** `stsd` is a full box: version(1) flags(3) entry_count(4) precede the entries. */
const STSD_ENTRIES_OFFSET = 8;

interface Box {
  type: string;
  /** Offset of the box header. */
  start: number;
  /** Offset of the first payload byte, after the (possibly 64-bit) header. */
  body: number;
  /** One past the last byte of the box. */
  end: number;
}

const latin1 = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

const isZero = (bytes: Uint8Array, start: number, end: number): boolean =>
  bytes.subarray(start, end).every((b) => b === 0);

/** Walks the boxes laid out between `start` and `end`, reading headers only. */
function* boxesIn(bytes: Uint8Array, start: number, end: number): Generator<Box> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;
  while (at < end) {
    if (at + 8 > end) {
      throw new Error(`MOV box header at byte ${at} runs past the end of its parent`);
    }
    let size = view.getUint32(at);
    const type = latin1(bytes, at + 4, at + 8);
    let body = at + 8;
    if (size === 1) {
      // 64-bit `largesize` follows the type.
      if (at + 16 > end) {
        throw new Error(`MOV box '${type}' at byte ${at} runs past the end of its parent`);
      }
      size = Number(view.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = end - at; // extends to the end of the parent
    }
    if (size < body - at || at + size > end) {
      throw new Error(`MOV box '${type}' at byte ${at} (size ${size}) runs past the end of its parent`);
    }
    yield { type, start: at, body, end: at + size };
    at += size;
  }
}

function childrenOf(bytes: Uint8Array, parent: Box, type: string): Box[] {
  const found: Box[] = [];
  for (const b of boxesIn(bytes, parent.body, parent.end)) if (b.type === type) found.push(b);
  return found;
}

/** Follows `path` down from `from`, first child of each type; undefined when a step is missing. */
function descend(bytes: Uint8Array, from: Box, path: string[]): Box | undefined {
  let at: Box | undefined = from;
  for (const type of path) {
    at = at && childrenOf(bytes, at, type)[0];
    if (!at) return undefined;
  }
  return at;
}

/**
 * Plans the patch: the absolute offsets of every signature field that still
 * carries ffmpeg's value. Throws when the file is not laid out the way the
 * muxer lays out a `qt  ` or an `isom` file — see the module comment for why
 * that is a refusal and not a best effort.
 */
export function findMovSignatureFields(bytes: Uint8Array): MovSignaturePatch[] {
  const top = [...boxesIn(bytes, 0, bytes.length)];
  const ftyp = top[0];
  if (!ftyp || ftyp.type !== "ftyp" || ftyp.end < FTYP_MINOR_VERSION_OFFSET + 4) {
    throw new Error("MOV does not start with a ftyp box; refusing to patch it");
  }
  const major = latin1(bytes, FTYP_MAJOR_BRAND_OFFSET, FTYP_MAJOR_BRAND_OFFSET + 4);
  if (!FFMPEG_BRANDS.has(major)) {
    throw new Error(
      `MOV major brand is '${major}', expected one of ${[...FFMPEG_BRANDS].map((b) => `'${b}'`).join(", ")}; refusing to patch it`
    );
  }
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Error("MOV has no moov box; refusing to patch it");

  const patches: MovSignaturePatch[] = [];
  if (!isZero(bytes, FTYP_MINOR_VERSION_OFFSET, FTYP_MINOR_VERSION_OFFSET + 4)) {
    patches.push({ field: "ftyp.minor_version", offset: FTYP_MINOR_VERSION_OFFSET });
  }

  for (const trak of childrenOf(bytes, moov, "trak")) {
    const stsd = descend(bytes, trak, ["mdia", "minf", "stbl", "stsd"]);
    if (!stsd) continue;
    for (const entry of boxesIn(bytes, stsd.body + STSD_ENTRIES_OFFSET, stsd.end)) {
      if (!SAMPLE_ENTRIES_WITH_VENDOR.has(entry.type)) continue;
      const at = entry.start + SAMPLE_ENTRY_VENDOR_OFFSET;
      if (at + 4 > entry.end) {
        throw new Error(`MOV sample entry '${entry.type}' at byte ${entry.start} is too short to hold a vendor field`);
      }
      if (latin1(bytes, at, at + 4) === FFMPEG_VENDOR) {
        patches.push({ field: "stsd.vendor", offset: at });
      }
      if (entry.type !== VIDEO_SAMPLE_ENTRY) continue;
      const nameAt = entry.start + SAMPLE_ENTRY_COMPRESSOR_OFFSET;
      if (nameAt + COMPRESSOR_FIELD_LENGTH > entry.end) {
        throw new Error(`MOV sample entry '${entry.type}' at byte ${entry.start} is too short to hold a compressor name`);
      }
      const nameLength = bytes[nameAt];
      if (nameLength >= COMPRESSOR_FIELD_LENGTH) {
        throw new Error(`MOV sample entry '${entry.type}' at byte ${entry.start} has a compressor name of ${nameLength} bytes, over the 31 its field holds`);
      }
      if (latin1(bytes, nameAt + 1, nameAt + 1 + nameLength).startsWith(FFMPEG_COMPRESSOR_PREFIX)) {
        patches.push({ field: "stsd.compressor_name", offset: nameAt });
      }
    }
  }
  return patches;
}

/**
 * Zeroes ffmpeg's signature fields in `path` in place and reports what it
 * touched. The whole file is read to walk it — it is at most the 50 MB the
 * encode is capped to, and exiftool has just streamed all of it anyway — but
 * the write is one field's worth of bytes at its offset, never a rewrite.
 */
export async function scrubMovSignature(path: string): Promise<MovSignaturePatch[]> {
  const patches = findMovSignatureFields(await readFile(path));
  if (patches.length === 0) return patches;
  const handle = await open(path, "r+");
  try {
    for (const p of patches) {
      const zeros = new Uint8Array(FIELD_LENGTH[p.field]);
      await handle.write(zeros, 0, zeros.length, p.offset);
    }
  } finally {
    await handle.close();
  }
  return patches;
}
