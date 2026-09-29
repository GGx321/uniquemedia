import { ALLOWED_COMPATIBLE_BRANDS, ALLOWED_MAJOR_BRAND, COMPRESSOR_NAME, ENCODER_TAG, HANDLER_NAMES, LANGUAGE_UND, META_HANDLER_TYPE } from "./allowlist";
import type { Findings, Mp4Box } from "./boxes";
import { latin1, u16, u32, u64, u8 } from "./reader";

// The checks that read inside `moov`: the metadata allowlist (invariant 14)
// for what the box walk cannot see. The walk knows box TYPES; these know that
// a box holds only the bytes the engine writes, because text hides in the
// reserved fields of a header and in the bytes after a leaf as easily as in a
// box of its own. So every fixed field and every leaf size is pinned to what
// a real ffmpeg 6.0 render holds, and a last safety net looks for text in what
// is left. All of it works on the moov buffer and reports by code; none of it
// throws, whatever the file holds.

export const kids = (box: Mp4Box, type: string): Mp4Box[] => box.children.filter((c) => c.type === type);
const unreadable = (findings: Findings, box: Mp4Box, what: string): void =>
  findings.add("STRUCTURE_UNRECOGNISED", `${box.type} is too short or has a layout this verifier does not know: ${what}`, box.path);
const notCanonical = (findings: Findings, box: Mp4Box, what: string): void => findings.add("FIELD_NOT_CANONICAL", `${box.type}: ${what}`, box.path);
const sizeOf = (box: Mp4Box): number => box.end - box.start;

/** Pins the box's size to one of `sizes`; true when it is. */
function sizeIs(findings: Findings, box: Mp4Box, ...sizes: number[]): boolean {
  if (sizes.includes(sizeOf(box))) return true;
  notCanonical(findings, box, `size is ${sizeOf(box)}, expected ${sizes.join(" or ")}`);
  return false;
}

/** Pins `bytes[box.start + from, box.start + to)` to zero. */
function zeroed(findings: Findings, bytes: Uint8Array, box: Mp4Box, from: number, to: number, what: string): void {
  if (bytes.subarray(box.start + from, box.start + to).some((b) => b !== 0)) notCanonical(findings, box, `${what} must be zero`);
}

/** Pins the bytes at `box.start + from` to `expected`. */
function equals(findings: Findings, bytes: Uint8Array, box: Mp4Box, from: number, expected: readonly number[], what: string): void {
  const got = bytes.subarray(box.start + from, box.start + from + expected.length);
  if (got.length !== expected.length || expected.some((b, i) => got[i] !== b)) notCanonical(findings, box, `${what} is not the value the engine writes`);
}

// ---------------------------------------------------------------------------
// Headers: times and fixed fields
// ---------------------------------------------------------------------------

/** `mvhd`, `tkhd` and `mdhd` (versions 0 and 1) lead with version and flags, then creation and modification time. */
function checkTimes(bytes: Uint8Array, box: Mp4Box, findings: Findings): void {
  const version = u8(bytes, box.body);
  const wide = version === 1;
  if (version !== 0 && !wide) return unreadable(findings, box, `version ${version}`);
  const at = box.body + 4;
  const step = wide ? 8 : 4;
  const created = wide ? u64(bytes, at) : u32(bytes, at);
  const modified = wide ? u64(bytes, at + step) : u32(bytes, at + step);
  if (created === undefined || modified === undefined) return unreadable(findings, box, "no room for the timestamps");
  if (created !== 0) findings.add("NONZERO_TIMESTAMP", `${box.type} creation time is ${created}, expected 0`, box.path);
  if (modified !== 0) findings.add("NONZERO_TIMESTAMP", `${box.type} modification time is ${modified}, expected 0`, box.path);
}

const word = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
/** The identity transform, nine 32-bit words: 1.0, 0, 0 / 0, 1.0, 0 / 0, 0, 1.0 in 16.16 and 2.30 fixed point. */
const UNITY_MATRIX = [...word(0x10000), ...word(0), ...word(0), ...word(0), ...word(0x10000), ...word(0), ...word(0), ...word(0), ...word(0x40000000)];

/** `mvhd`: 108 bytes (version 0) or 120 (version 1); the fields after the times are the engine's constants. Offsets below are for version 0; a version-1 box is pinned by size only. */
function checkMvhd(bytes: Uint8Array, box: Mp4Box, findings: Findings): void {
  if (!sizeIs(findings, box, 108, 120) || u8(bytes, box.body) !== 0) return;
  equals(findings, bytes, box, 28, [0, 1, 0, 0], "the rate");
  equals(findings, bytes, box, 32, [1, 0], "the volume");
  zeroed(findings, bytes, box, 34, 44, "the reserved bytes");
  equals(findings, bytes, box, 44, UNITY_MATRIX, "the matrix");
  zeroed(findings, bytes, box, 80, 104, "the pre_defined bytes");
}

/** `tkhd`: 92 or 104 bytes; the reserved fields are zero. The matrix (a rotation) and the volume are not pinned. */
function checkTkhd(bytes: Uint8Array, box: Mp4Box, findings: Findings): void {
  if (!sizeIs(findings, box, 92, 104) || u8(bytes, box.body) !== 0) return;
  zeroed(findings, bytes, box, 24, 28, "the first reserved field");
  zeroed(findings, bytes, box, 32, 40, "the second reserved field");
  zeroed(findings, bytes, box, 40, 42, "the layer");
  zeroed(findings, bytes, box, 46, 48, "the third reserved field");
}

/** `mdhd`: 32 or 44 bytes, language `und`, the last field zero. */
function checkMdhd(bytes: Uint8Array, box: Mp4Box, findings: Findings): void {
  checkTimes(bytes, box, findings);
  if (!sizeIs(findings, box, 32, 44)) return;
  const version = u8(bytes, box.body);
  const language = u16(bytes, box.body + (version === 1 ? 32 : 20));
  if (language !== undefined && language !== LANGUAGE_UND) {
    findings.add("METADATA_VALUE_NOT_ALLOWED", `mdhd language is 0x${language.toString(16)}, expected und (0x55c4)`, box.path);
  }
  if (version === 0) zeroed(findings, bytes, box, 30, 32, "the pre_defined field");
}

/** `vmhd` is 20 bytes (flags 1, graphics mode and opcolor zero); `smhd` is 16 (balance and reserved zero). */
function checkMediaHeader(bytes: Uint8Array, box: Mp4Box, findings: Findings): void {
  if (box.type === "vmhd") {
    if (!sizeIs(findings, box, 20)) return;
    equals(findings, bytes, box, 8, [0, 0, 0, 1], "the version and flags");
    zeroed(findings, bytes, box, 12, 20, "the graphics mode and opcolor");
  } else {
    if (!sizeIs(findings, box, 16)) return;
    zeroed(findings, bytes, box, 8, 16, "the version, flags, balance and reserved bytes");
  }
}

/** `elst`: version and flags, an entry count, then 12 bytes (version 0) or 20 (version 1) per entry, and nothing else. */
function checkElst(bytes: Uint8Array, box: Mp4Box, findings: Findings): void {
  const version = u8(bytes, box.body);
  const count = u32(bytes, box.body + 4);
  if ((version !== 0 && version !== 1) || count === undefined) return unreadable(findings, box, "no readable entry count");
  sizeIs(findings, box, 16 + count * (version === 1 ? 20 : 12));
}

/** `dref`: version and flags zero, one entry, and that entry is the 12 bytes of a self-contained `url `. */
function checkDref(bytes: Uint8Array, box: Mp4Box, findings: Findings): void {
  equals(findings, bytes, box, 8, [0, 0, 0, 0], "the version and flags");
  if (u32(bytes, box.body + 4) !== 1 || box.children.length !== 1) notCanonical(findings, box, "does not hold exactly one entry");
  for (const url of kids(box, "url ")) {
    if (sizeOf(url) !== 12) notCanonical(findings, url, `size is ${sizeOf(url)}, expected 12`);
    else if (u32(bytes, url.body) !== 1) notCanonical(findings, url, "flags are not 1 (self-contained)");
  }
}

// ---------------------------------------------------------------------------
// Sample tables: the sizes their counts imply
// ---------------------------------------------------------------------------

/** Every table's size follows from its own entry count; a byte more is a place to hide something. */
function checkTable(bytes: Uint8Array, box: Mp4Box, findings: Findings): void {
  const count = u32(bytes, box.body + 4);
  const perEntry = { stts: 8, stss: 4, ctts: 8, stsc: 12, stco: 4 }[box.type];
  if (perEntry !== undefined) {
    if (count === undefined) return unreadable(findings, box, "no entry count");
    sizeIs(findings, box, 16 + count * perEntry);
  } else if (box.type === "stsz") {
    const uniform = u32(bytes, box.body + 4);
    const samples = u32(bytes, box.body + 8);
    if (uniform === undefined || samples === undefined) return unreadable(findings, box, "no sample count");
    sizeIs(findings, box, uniform === 0 ? 20 + samples * 4 : 20);
  } else if (box.type === "sgpd") {
    // The AAC roll-recovery group: version 1, `roll`, default length 2, one entry, roll distance -1. All constant.
    if (sizeIs(findings, box, 26)) equals(findings, bytes, box, 8, [1, 0, 0, 0, 0x72, 0x6f, 0x6c, 0x6c, 0, 0, 0, 2, 0, 0, 0, 1, 0xff, 0xff], "the roll group description");
  } else if (box.type === "sbgp") {
    // `roll`, one run; the run's sample count (bytes 20-23) is the audio frame count and varies, the rest is constant.
    if (!sizeIs(findings, box, 28)) return;
    equals(findings, bytes, box, 8, [0, 0, 0, 0, 0x72, 0x6f, 0x6c, 0x6c, 0, 0, 0, 1], "the roll sample-to-group header");
    equals(findings, bytes, box, 24, [0, 0, 0, 1], "the group description index");
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** The most a handler name may be, and the most an encoder value: the real ones are 13 and 12 bytes. Longer is refused without being decoded. */
const HANDLER_NAME_MAX_BYTES = 64;
const ENCODER_VALUE_MAX_BYTES = 32;

interface Handler {
  readonly type: string;
  /** The name region (after the 12 reserved bytes) as text, or undefined when it is over the cap and was not decoded. */
  readonly nameRegion: string | undefined;
}

/** `hdlr`: version and flags, pre_defined, handler type, 12 reserved bytes, then a NUL-terminated name. */
export function readHandler(bytes: Uint8Array, box: Mp4Box, findings: Findings): Handler | undefined {
  if (box.end - box.body < 24) {
    unreadable(findings, box, "no room for a handler type");
    return undefined;
  }
  const nameBytes = box.end - (box.body + 24);
  if (nameBytes > HANDLER_NAME_MAX_BYTES) {
    findings.add("METADATA_VALUE_NOT_ALLOWED", `hdlr name is ${nameBytes} bytes, over the ${HANDLER_NAME_MAX_BYTES}-byte cap`, box.path);
    return { type: latin1(bytes, box.body + 8, box.body + 12), nameRegion: undefined };
  }
  return { type: latin1(bytes, box.body + 8, box.body + 12), nameRegion: latin1(bytes, box.body + 24, box.end) };
}

/** A track's `hdlr`: name exactly `VideoHandler` or `SoundHandler` and one NUL, the reserved bytes zero. */
function checkTrackHandler(bytes: Uint8Array, hdlr: Mp4Box, findings: Findings): void {
  const handler = readHandler(bytes, hdlr, findings);
  if (!handler) return;
  zeroed(findings, bytes, hdlr, 8, 16, "the version, flags and pre_defined");
  zeroed(findings, bytes, hdlr, 20, 32, "the reserved bytes");
  const expected = HANDLER_NAMES.get(handler.type);
  if (expected !== undefined && handler.nameRegion !== undefined && handler.nameRegion !== `${expected}\u0000`) {
    findings.add("METADATA_VALUE_NOT_ALLOWED", `hdlr name is ${findings.describe(handler.nameRegion)}, expected ${expected}`, hdlr.path);
  }
}

/** The `meta` box's `hdlr`: type `mdir`, the reserved bytes `appl` and eight zeros, an empty (NUL) name, 33 bytes in all. */
function checkMetaHandler(bytes: Uint8Array, hdlr: Mp4Box, findings: Findings): void {
  const handler = readHandler(bytes, hdlr, findings);
  if (!handler) return;
  if (handler.type !== META_HANDLER_TYPE) findings.add("METADATA_VALUE_NOT_ALLOWED", `meta hdlr type is ${findings.describe(handler.type)}, expected ${META_HANDLER_TYPE}`, hdlr.path);
  if (!sizeIs(findings, hdlr, 33)) return;
  zeroed(findings, bytes, hdlr, 8, 16, "the version, flags and pre_defined");
  equals(findings, bytes, hdlr, 20, [0x61, 0x70, 0x70, 0x6c, 0, 0, 0, 0, 0, 0, 0, 0, 0], "the reserved bytes and name");
}

// ---------------------------------------------------------------------------
// Sample entries
// ---------------------------------------------------------------------------

/** The 32-byte visual entry, after its 8-byte header: reserved, index 1, then constants up to the compressor name (Pascal string in 32 bytes), depth 24 and -1. */
function checkVideoEntry(bytes: Uint8Array, entry: Mp4Box, findings: Findings): void {
  if (sizeOf(entry) < 86) return;
  zeroed(findings, bytes, entry, 8, 14, "the reserved bytes");
  equals(findings, bytes, entry, 14, [0, 1], "the data reference index");
  zeroed(findings, bytes, entry, 16, 32, "the version, revision, vendor and quality fields");
  equals(findings, bytes, entry, 36, [0, 0x48, 0, 0, 0, 0x48, 0, 0], "the resolution");
  zeroed(findings, bytes, entry, 44, 48, "the reserved field");
  equals(findings, bytes, entry, 48, [0, 1], "the frame count");
  equals(findings, bytes, entry, 82, [0, 0x18, 0xff, 0xff], "the depth and pre_defined");
  const length = u8(bytes, entry.start + 50);
  if (length === undefined || length > 31) return unreadable(findings, entry, "no room for a compressor name");
  const name = latin1(bytes, entry.start + 51, entry.start + 51 + length);
  if (!COMPRESSOR_NAME.test(name)) {
    findings.add("METADATA_VALUE_NOT_ALLOWED", `the video compressor name is ${findings.describe(name)}, expected Lavc<version> libx264`, entry.path);
  }
  // The name field is 32 bytes; what follows the name inside it is zero.
  zeroed(findings, bytes, entry, 51 + length, 82, "the padding after the compressor name");
  checkEntryChildren(bytes, entry, findings);
}

/** The sound entry (version 0): reserved, index 1, version, revision, vendor zero, then channels, sample size, reserved. */
function checkSoundEntry(bytes: Uint8Array, entry: Mp4Box, findings: Findings): void {
  if (sizeOf(entry) < 36) return;
  zeroed(findings, bytes, entry, 8, 14, "the reserved bytes");
  equals(findings, bytes, entry, 14, [0, 1], "the data reference index");
  zeroed(findings, bytes, entry, 16, 24, "the version, revision and vendor");
  equals(findings, bytes, entry, 26, [0, 16], "the sample size");
  zeroed(findings, bytes, entry, 28, 32, "the pre_defined and reserved fields");
  checkEntryChildren(bytes, entry, findings);
}

/** The exact sizes of the boxes inside an entry, and `avcC` to the byte. */
function checkEntryChildren(bytes: Uint8Array, entry: Mp4Box, findings: Findings): void {
  const sizes: Record<string, number> = { colr: 19, pasp: 16, btrt: 20 };
  for (const child of entry.children) {
    const expected = sizes[child.type];
    if (expected !== undefined) sizeIs(findings, child, expected);
    if (child.type === "avcC") checkAvcC(bytes, child, findings);
  }
}

/**
 * `avcC`: version 1, profile, compatibility, level, NAL length size, the SPS
 * list, the PPS list and, for the High profiles, the four extension bytes and
 * their SPS extensions. Its size must be exactly what those counts imply.
 */
function checkAvcC(bytes: Uint8Array, box: Mp4Box, findings: Findings): void {
  let at = box.body + 5;
  const profile = u8(bytes, box.body + 1);
  const readList = (count: number): boolean => {
    for (let i = 0; i < count; i++) {
      const length = u16(bytes, at);
      if (length === undefined) return false;
      at += 2 + length;
      if (at > box.end) return false;
    }
    return true;
  };
  const numSps = u8(bytes, at);
  const spsOk = numSps !== undefined && (at++, readList(numSps & 0x1f));
  const numPps = spsOk ? u8(bytes, at) : undefined;
  const ppsOk = numPps !== undefined && (at++, readList(numPps));
  const high = profile === 100 || profile === 110 || profile === 122 || profile === 144;
  const withoutExtension = at;
  let extensionOk = false;
  if (ppsOk && high && at + 4 <= box.end) {
    const numExt = u8(bytes, at + 3);
    at += 4;
    extensionOk = numExt !== undefined && readList(numExt);
  }
  const consistent = ppsOk && (at === box.end || (!extensionOk && withoutExtension === box.end));
  if (u8(bytes, box.body) !== 1 || !consistent) notCanonical(findings, box, "its length is not what its SPS and PPS counts imply");
}

/** The first sample entry of a track's `stsd`. */
function checkSampleEntry(bytes: Uint8Array, stsd: Mp4Box, findings: Findings): void {
  const entry = stsd.children[0];
  if (!entry) return unreadable(findings, stsd, "there is no sample entry");
  const vendor = bytes.subarray(entry.start + 20, entry.start + 24);
  if (vendor.length === 4 && vendor.some((b) => b !== 0)) {
    findings.add("METADATA_VALUE_NOT_ALLOWED", `${entry.type} vendor is ${findings.describe(latin1(bytes, entry.start + 20, entry.start + 24))}, expected four zero bytes`, entry.path);
  }
  if (entry.type === "avc1") checkVideoEntry(bytes, entry, findings);
  if (entry.type === "mp4a") checkSoundEntry(bytes, entry, findings);
}

// ---------------------------------------------------------------------------
// udta / meta / ilst
// ---------------------------------------------------------------------------

/** `meta` under `udta`: an `mdir` handler and one `ilst`, whose only item is the encoder tag. */
function checkMeta(bytes: Uint8Array, meta: Mp4Box, findings: Findings): void {
  for (const hdlr of kids(meta, "hdlr")) checkMetaHandler(bytes, hdlr, findings);
  for (const ilst of kids(meta, "ilst")) {
    const items = ilst.children.filter((c) => c.type === "©too");
    if (items.length > 1) findings.add("DUPLICATE_BOX", "the encoder tag appears more than once", ilst.path);
    for (const item of items) checkEncoderItem(bytes, item, findings);
  }
}

/** `©too`: exactly one `data` box (UTF-8 type 1, locale 0, then the text) holding `Lavf<version>`, and nothing after it. */
function checkEncoderItem(bytes: Uint8Array, item: Mp4Box, findings: Findings): void {
  const data = item.children.filter((c) => c.type === "data");
  const only = data.length === 1 ? data[0] : undefined;
  if (!only || only.end - only.body < 8 || only.end !== item.end) {
    return void findings.add("METADATA_VALUE_NOT_ALLOWED", "the encoder tag does not hold exactly one data box", item.path);
  }
  if (u32(bytes, only.body) !== 1) findings.add("METADATA_VALUE_NOT_ALLOWED", "the encoder tag's data type is not 1 (UTF-8)", item.path);
  if (u32(bytes, only.body + 4) !== 0) findings.add("METADATA_VALUE_NOT_ALLOWED", "the encoder tag's locale is not 0", item.path);
  const length = only.end - (only.body + 8);
  if (length > ENCODER_VALUE_MAX_BYTES) return void findings.add("METADATA_VALUE_NOT_ALLOWED", `the encoder tag is ${length} bytes, over the ${ENCODER_VALUE_MAX_BYTES}-byte cap`, item.path);
  const value = latin1(bytes, only.body + 8, only.end);
  if (!ENCODER_TAG.test(value)) {
    findings.add("METADATA_VALUE_NOT_ALLOWED", `the encoder tag is ${findings.describe(value)}, expected Lavf<version>`, item.path);
  }
}

// ---------------------------------------------------------------------------
// The whole
// ---------------------------------------------------------------------------

function checkTrack(bytes: Uint8Array, trak: Mp4Box, findings: Findings): void {
  for (const tkhd of kids(trak, "tkhd")) {
    checkTimes(bytes, tkhd, findings);
    checkTkhd(bytes, tkhd, findings);
  }
  for (const elst of kids(kids(trak, "edts")[0] ?? trak, "elst")) checkElst(bytes, elst, findings);
  const mdia = kids(trak, "mdia")[0];
  if (!mdia) return;
  for (const mdhd of kids(mdia, "mdhd")) checkMdhd(bytes, mdhd, findings);
  for (const hdlr of kids(mdia, "hdlr")) checkTrackHandler(bytes, hdlr, findings);
  const minf = kids(mdia, "minf")[0];
  if (!minf) return;
  for (const header of [...kids(minf, "vmhd"), ...kids(minf, "smhd")]) checkMediaHeader(bytes, header, findings);
  for (const dref of kids(kids(minf, "dinf")[0] ?? minf, "dref")) checkDref(bytes, dref, findings);
  const stbl = kids(minf, "stbl")[0];
  if (!stbl) return;
  for (const table of stbl.children) checkTable(bytes, table, findings);
  const stsd = kids(stbl, "stsd")[0];
  if (stsd) checkSampleEntry(bytes, stsd, findings);
}

/** The shortest printable run the safety net reports. Random video-configuration bytes reach it with probability about 1e-7 per position. */
export const PRINTABLE_RUN_MIN = 16;

/**
 * The safety net: printable ASCII in `moov` for 16 bytes or more that is not the
 * compressor name. The numeric tables start with zero bytes and the real file
 * has no such run, so a longer one is text somebody put in a place the pinned
 * checks do not cover (a sample-group table, an SPS).
 */
function checkPrintableRuns(bytes: Uint8Array, findings: Findings): void {
  let runStart = -1;
  const flush = (end: number): void => {
    if (runStart >= 0 && end - runStart >= PRINTABLE_RUN_MIN && !COMPRESSOR_NAME.test(latin1(bytes, runStart, end))) {
      findings.add("TEXT_IN_INDEX", `${end - runStart} printable bytes at offset ${runStart} of moov`, "moov");
    }
    runStart = -1;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    if (b >= 0x20 && b <= 0x7e) {
      if (runStart < 0) runStart = i;
    } else flush(i);
  }
  flush(bytes.length);
}

/** Checks everything inside `moov` that the box walk did not: times, names, tag values, fixed fields, leaf sizes, stray text. */
export function checkMoov(bytes: Uint8Array, moovChildren: readonly Mp4Box[], findings: Findings): void {
  for (const box of moovChildren) {
    if (box.type === "mvhd") {
      checkTimes(bytes, box, findings);
      checkMvhd(bytes, box, findings);
    }
    if (box.type === "trak") checkTrack(bytes, box, findings);
    if (box.type === "udta") for (const meta of kids(box, "meta")) checkMeta(bytes, meta, findings);
  }
  checkPrintableRuns(bytes, findings);
}

/** `ftyp`: major brand, minor version (not pinned), then compatible brands to the end. `box` is the whole box, header included. */
export function checkFtyp(box: Uint8Array, headerLength: number, findings: Findings): void {
  const body = headerLength;
  if (box.length < body + 8 || (box.length - body - 8) % 4 !== 0) {
    findings.add("FTYP_BRAND_NOT_ALLOWED", "ftyp is too short or does not end on a brand boundary", "ftyp");
    return;
  }
  const major = latin1(box, body, body + 4);
  if (major !== ALLOWED_MAJOR_BRAND) findings.add("FTYP_BRAND_NOT_ALLOWED", `major brand is ${findings.describe(major)}, expected ${ALLOWED_MAJOR_BRAND}`, "ftyp");
  for (let at = body + 8; at < box.length; at += 4) {
    const brand = latin1(box, at, at + 4);
    if (!ALLOWED_COMPATIBLE_BRANDS.has(brand)) findings.add("FTYP_BRAND_NOT_ALLOWED", `compatible brand ${findings.describe(brand)} is not allowed`, "ftyp");
  }
}
