import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { openRegularNoFollow, type OpenRegularOptions } from "../library/openRegular";
import { BUILTIN_MARKERS, forbiddenCode, UUID_PAYLOAD_HEAD_BYTES } from "../verify/allowlist";
import { Findings, MOOV_MAX_BYTES, readAt, walkNested, walkTopLevel, type Mp4Box, type SchemaNode, type TopBox } from "../verify/boxes";
import { kids } from "../verify/checks";
import { checkMediaData } from "../verify/media";
import { latin1, quote, u16, u32, u64, u8 } from "../verify/reader";
import { scanForNeedles } from "../verify/scan";
import type { VerifyReasonCode } from "../verify";
import { ENGINE_SIGNATURE_STRINGS } from "../videos/forbiddenStrings";

// Stage 5, 5b.1, S5.V4c (plan s5b1 I5.58; owner Q-C, 2026-10-13): what an exported clip says about itself, checked on the file before it is committed. A hard boundary:
// - STRIPPED: every tag of the source and every signature of the tools. No item in `ilst`, no `keys`, no `loci`, no `©xyz`, no XMP, EXIF or C2PA, empty handler names, a compressor
//   name of one space, and no x264 SEI in the coded pictures;
// - WRITTEN: only `creation_time` (the real export time, in `mvhd`, `tkhd` and `mdhd`) and the BT.709 `colr`;
// - NEVER WRITTEN by any code path: a device make or model, GPS or any place, «shot on», a camera field, an «AI» claim. Nothing here can add one; this only refuses.
//
// It has ITS OWN allowlist, on the render verifier's primitives (the bounded box walker, the reader, the chunk tiling and the streaming search): the render's (invariant 14) wants zero
// times, the «VideoHandler» name and «Lavc… libx264», exactly what this profile must not carry, so neither `allowlist.ts` nor `checks.ts` changes (a test pins both, and that the render
// verifier still refuses a clip export).
//
// AS MEASURED on the bundled ffmpeg-static 6.0: the mp4 muxer always writes `udta/meta` (an `mdir` handler and an `ilst`) even when the list is empty. That empty skeleton holds no
// tag and is allowed; one item in it, or any other box beside it, is refused.
//
// STRINGS are searched OUTSIDE `mdat` only: a short word («GPS», «x-ai») occurs in megabytes of coded video by chance (the render verifier needs at least 6 bytes for a whole-file search,
// `MIN_FORBIDDEN_STRING_BYTES`). Inside `mdat` the pictures are walked NAL unit by NAL unit (the `avcC` length size), once the index is shown to tile `mdat` exactly, and a NAL of type 6
// (SEI, where x264 writes its version and options) is refused. The long markers of photo metadata (XMP, EXIF, C2PA) are searched in the whole file, as the render's are.

/** Why an export was refused: the walker's codes (the render verifier's own), and the codes of this profile's rules. */
export type ClipExportReasonCode =
  | VerifyReasonCode
  | "CREATION_TIME_WRONG"
  | "HANDLER_NAME_NOT_EMPTY"
  | "COMPRESSOR_NAME_NOT_BLANK"
  | "SEI_FOUND"
  | "NAL_WALK_FAILED"
  | "FORBIDDEN_TEXT"
  | "TAG_PRESENT";

export interface ClipExportReason {
  readonly code: ClipExportReasonCode;
  /** For the log: box paths and counts, at most 32 escaped characters of any file value. */
  readonly message: string;
  readonly path?: string;
}

export interface ClipExportVerdict {
  readonly ok: boolean;
  readonly reasons: readonly ClipExportReason[];
  /** sha256 (lowercase hex) of the whole file, from the verifier's own read; null when it did not read every byte. */
  readonly sha256: string | null;
  /** The size the handle reported. */
  readonly bytes: number;
}

export interface ClipExportExpected {
  /** The export time the argv wrote as `creation_time`. */
  readonly createdAt: Date;
  /** How far the file's times may be from it; 2 s (ffmpeg keeps whole seconds). */
  readonly toleranceMs?: number;
}

export interface ClipExportVerifyOptions {
  /** Refuse (as `FILE_TOO_LARGE`) a file above this many bytes. */
  readonly maxBytes?: number;
  /** How the file is opened (a test plays Windows' missing no-follow flag). */
  readonly open?: OpenRegularOptions;
}

/** A 10 s clip at the 12 Mbit/s cap is about 15 MB with its VBV burst; 128 MiB bounds the whole-file read eight times over. */
export const MAX_EXPORT_BYTES = 128 * 1024 * 1024;

const DEFAULT_TOLERANCE_MS = 2_000;
/** Seconds from 1904-01-01 (the MP4 epoch) to 1970-01-01. */
const MP4_EPOCH_OFFSET_S = 2_082_844_800;
/** A 10 s clip at 30 fps has a few hundred NAL units; anything past this is not one of ours. */
const MAX_NAL_UNITS = 100_000;
/** The shortest printable run in `moov` that is text somebody put there (the render's safety net, `checks.ts`). Our compressor name is one byte. */
const PRINTABLE_RUN_MIN = 16;
const H264_HIGH_PROFILE = 100;
const SEI_NAL_TYPE = 6;

/**
 * The words that may never appear outside the coded pictures, compared without letter case: the text the render's tools write (`ENGINE_SIGNATURE_STRINGS`), the providers, the
 * muxer and encoder signatures, and the device and place words. Not a filter of what is WRITTEN (nothing writes them): a net for what a source or a tool might carry through.
 */
export const CLIP_EXPORT_FORBIDDEN_TEXT: readonly string[] = [
  ...new Set(
    [...ENGINE_SIGNATURE_STRINGS, "Kling", "kwaivgi", "x-ai", "grok", "OpenRouter", "Lavf", "Lavc", "x264", "Apple", "iPhone", "GPS", "©xyz", "shot on"].map((word) => word.toLowerCase()),
  ),
];

// ---------------------------------------------------------------------------
// The allowlist: one video track and the empty metadata skeleton
// ---------------------------------------------------------------------------

const set = (...types: string[]): ReadonlySet<string> => new Set(types);
const node = (
  allowed: ReadonlySet<string>,
  containers: ReadonlyMap<string, { readonly prefix: number; readonly node: SchemaNode }> = new Map(),
  unknownCode: VerifyReasonCode = "UNKNOWN_BOX",
  repeatable: ReadonlySet<string> = new Set(),
): SchemaNode => ({ strict: true, allowed, containers, unknownCode, repeatable });
const inside = (prefix: number, child: SchemaNode): { prefix: number; node: SchemaNode } => ({ prefix, node: child });

/** `ilst` may hold no item at all: every one is a tag. */
const ILST = node(set(), new Map(), "METADATA_KEY_NOT_ALLOWED");
/** `meta` (a full box) holds the `mdir` handler and the empty `ilst`; no `keys` (QuickTime-style tags). */
const META = node(set("hdlr", "ilst"), new Map([["ilst", inside(0, ILST)]]));
const UDTA = node(set("meta"), new Map([["meta", inside(4, META)]]));
/** The video sample entry (78 fixed bytes after its header): the decoder configuration, the colour, the pixel aspect, the bit rates. */
const AVC1 = node(set("avcC", "colr", "pasp", "btrt"));
const STSD = node(set("avc1"), new Map([["avc1", inside(78, AVC1)]]));
const DREF = node(set("url "));
const STBL = node(set("stsd", "stts", "stss", "ctts", "stsc", "stsz", "stco"), new Map([["stsd", inside(8, STSD)]]));
const DINF = node(set("dref"), new Map([["dref", inside(8, DREF)]]));
const MINF = node(set("vmhd", "dinf", "stbl"), new Map([["dinf", inside(0, DINF)], ["stbl", inside(0, STBL)]]));
const MDIA = node(set("mdhd", "hdlr", "minf"), new Map([["minf", inside(0, MINF)]]));
const EDTS = node(set("elst"));
const TRAK = node(set("tkhd", "edts", "mdia"), new Map([["edts", inside(0, EDTS)], ["mdia", inside(0, MDIA)]]));
const MOOV = node(set("mvhd", "trak", "udta"), new Map([["trak", inside(0, TRAK)], ["udta", inside(0, UDTA)]]), "UNKNOWN_BOX", set("trak"));

const TOP_LEVEL = set("ftyp", "free", "moov", "mdat");
const MAJOR_BRAND = "isom";
const COMPATIBLE_BRANDS = set("isom", "iso2", "avc1", "mp41");
const FTYP_MAX_BYTES = 1024;
const FREE_MAX_BYTES = 64 * 1024;

/** The reasons of this profile's own rules, beside the walker's `Findings`. */
class Reasons {
  readonly list: ClipExportReason[] = [];
  add(code: ClipExportReasonCode, message: string, path?: string): void {
    if (this.list.some((r) => r.code === code && r.message === message && r.path === path)) return;
    this.list.push(path === undefined ? { code, message } : { code, message, path });
  }
}

// ---------------------------------------------------------------------------
// The checks inside moov
// ---------------------------------------------------------------------------

/** `mvhd`, `tkhd`, `mdhd`: the creation and modification times are both the export time (the only time the profile writes). */
function checkTimes(bytes: Uint8Array, box: Mp4Box, expectedS: number, toleranceS: number, reasons: Reasons): void {
  const version = u8(bytes, box.body);
  const wide = version === 1;
  if (version !== 0 && !wide) return reasons.add("STRUCTURE_UNRECOGNISED", `${box.type} has version ${version}`, box.path);
  const created = wide ? u64(bytes, box.body + 4) : u32(bytes, box.body + 4);
  const modified = wide ? u64(bytes, box.body + 12) : u32(bytes, box.body + 8);
  if (created === undefined || modified === undefined) return reasons.add("STRUCTURE_UNRECOGNISED", `${box.type} has no room for its times`, box.path);
  for (const [what, value] of [["creation", created], ["modification", modified]] as const) {
    if (!(Math.abs(value - MP4_EPOCH_OFFSET_S - expectedS) <= toleranceS)) reasons.add("CREATION_TIME_WRONG", `${box.type} ${what} time is not the export time`, box.path);
  }
}

/** A handler's name region (after its 24 fixed bytes) is empty or one NUL; a handler of `meta` is `mdir`, a track's `vide`. */
function checkHandler(bytes: Uint8Array, hdlr: Mp4Box, type: string, reasons: Reasons): void {
  if (hdlr.end - hdlr.body < 24) return reasons.add("STRUCTURE_UNRECOGNISED", "hdlr has no room for a handler type", hdlr.path);
  const handlerType = latin1(bytes, hdlr.body + 8, hdlr.body + 12);
  if (handlerType !== type) reasons.add(type === "vide" ? "UNEXPECTED_TRACKS" : "METADATA_VALUE_NOT_ALLOWED", `hdlr type is ${quote(handlerType)}, expected ${type}`, hdlr.path);
  const name = latin1(bytes, hdlr.body + 24, hdlr.end);
  if (name !== "" && name !== "\u0000") reasons.add("HANDLER_NAME_NOT_EMPTY", `hdlr name is ${quote(name)}, expected an empty one`, hdlr.path);
  // The version, flags and pre_defined are zero; the reserved bytes are zero (a track's) or `appl` and zeros (the iTunes metadata handler's).
  if (bytes.subarray(hdlr.body, hdlr.body + 8).some((b) => b !== 0)) reasons.add("FIELD_NOT_CANONICAL", "hdlr version, flags or pre_defined are not zero", hdlr.path);
  const reserved = latin1(bytes, hdlr.body + 12, hdlr.body + 24);
  if (reserved !== "\u0000".repeat(12) && reserved !== `appl${"\u0000".repeat(8)}`) reasons.add("FIELD_NOT_CANONICAL", "hdlr reserved bytes are not the muxer's", hdlr.path);
}

/** The sample entry's compressor name (a Pascal string in 32 bytes at offset 50): exactly one space, the rest zero; the vendor zero. */
function checkCompressor(bytes: Uint8Array, entry: Mp4Box, reasons: Reasons): void {
  if (entry.end - entry.start < 86) return reasons.add("STRUCTURE_UNRECOGNISED", "the video sample entry is too short", entry.path);
  const length = u8(bytes, entry.start + 50) ?? 0;
  const name = latin1(bytes, entry.start + 51, entry.start + 51 + Math.min(31, length));
  const padding = bytes.subarray(entry.start + 51 + Math.min(31, length), entry.start + 82);
  if (name !== " " || padding.some((b) => b !== 0)) reasons.add("COMPRESSOR_NAME_NOT_BLANK", `the compressor name is ${quote(name)}, expected one space`, entry.path);
  if (bytes.subarray(entry.start + 20, entry.start + 24).some((b) => b !== 0)) reasons.add("METADATA_VALUE_NOT_ALLOWED", "the video sample entry names a vendor", entry.path);
}

/** `colr` is `nclx` BT.709 primaries, transfer and matrix, limited range: the tags the argv wrote. */
function checkColour(bytes: Uint8Array, entry: Mp4Box, reasons: Reasons): void {
  const colr = kids(entry, "colr")[0];
  if (colr === undefined) return reasons.add("COLOUR_TAG_WRONG", "the video has no colr", entry.path);
  const kind = latin1(bytes, colr.body, colr.body + 4);
  const tags = [u16(bytes, colr.body + 4), u16(bytes, colr.body + 6), u16(bytes, colr.body + 8)];
  const full = ((u8(bytes, colr.body + 10) ?? 0x80) & 0x80) !== 0;
  if (colr.end - colr.start !== 19 || kind !== "nclx" || tags.some((tag) => tag !== 1) || full) reasons.add("COLOUR_TAG_WRONG", "colr is not BT.709 limited range (nclx 1/1/1)", colr.path);
}

/** The NAL length size from `avcC` (1, 2 or 4), or null; the profile must be High. */
function avcConfig(bytes: Uint8Array, entry: Mp4Box, reasons: Reasons): number | null {
  const avcC = kids(entry, "avcC")[0];
  if (avcC === undefined) {
    reasons.add("VIDEO_FORMAT_WRONG", "the video has no avcC", entry.path);
    return null;
  }
  const version = u8(bytes, avcC.body);
  const profile = u8(bytes, avcC.body + 1);
  const lengthSize = ((u8(bytes, avcC.body + 4) ?? 0) & 0x03) + 1;
  if (version !== 1 || lengthSize === 3) {
    reasons.add("STRUCTURE_UNRECOGNISED", "avcC is not a version-1 configuration with a usable NAL length size", avcC.path);
    return null;
  }
  if (profile !== H264_HIGH_PROFILE) reasons.add("VIDEO_FORMAT_WRONG", `the H.264 profile is ${profile}, expected High (100)`, avcC.path);
  return lengthSize;
}

/** `dref` holds one self-contained `url ` of 12 bytes: a `url ` with a location is a place for text. */
function checkDref(bytes: Uint8Array, dref: Mp4Box, reasons: Reasons): void {
  const urls = kids(dref, "url ");
  if (u32(bytes, dref.body + 4) !== 1 || dref.children.length !== 1 || urls.length !== 1) return reasons.add("FIELD_NOT_CANONICAL", "dref does not hold exactly one entry", dref.path);
  for (const url of urls) if (url.end - url.start !== 12 || u32(bytes, url.body) !== 1) reasons.add("FIELD_NOT_CANONICAL", "the data reference is not one self-contained url", url.path);
}

/** Printable ASCII in `moov` for 16 bytes or more: text somebody put in a place the pinned checks do not cover. */
function checkPrintableRuns(bytes: Uint8Array, reasons: Reasons): void {
  let start = -1;
  const flush = (end: number): void => {
    if (start >= 0 && end - start >= PRINTABLE_RUN_MIN) reasons.add("TEXT_IN_INDEX", `${end - start} printable bytes at offset ${start} of moov`, "moov");
    start = -1;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    if (b >= 0x20 && b <= 0x7e) {
      if (start < 0) start = i;
    } else flush(i);
  }
  flush(bytes.length);
}

interface MoovFacts {
  /** The NAL length size of the one video track, or null when it cannot be read. */
  readonly lengthSize: number | null;
}

function checkMoov(bytes: Uint8Array, children: readonly Mp4Box[], expected: ClipExportExpected, reasons: Reasons): MoovFacts {
  const expectedS = Math.floor(expected.createdAt.getTime() / 1000);
  const toleranceS = (expected.toleranceMs ?? DEFAULT_TOLERANCE_MS) / 1000;
  for (const mvhd of children.filter((c) => c.type === "mvhd")) checkTimes(bytes, mvhd, expectedS, toleranceS, reasons);
  if (!children.some((c) => c.type === "mvhd")) reasons.add("MISSING_BOX", "moov has no mvhd", "moov");

  // udta: the empty skeleton only (the walker refuses any other box in it); an item in ilst is a tag.
  for (const udta of children.filter((c) => c.type === "udta")) {
    for (const meta of kids(udta, "meta")) {
      for (const hdlr of kids(meta, "hdlr")) checkHandler(bytes, hdlr, "mdir", reasons);
      for (const ilst of kids(meta, "ilst")) if (ilst.end - ilst.body > 0) reasons.add("TAG_PRESENT", `ilst holds ${ilst.children.length || "some"} item(s); the export carries no tag`, ilst.path);
    }
  }

  const tracks = children.filter((c) => c.type === "trak");
  if (tracks.length === 0) reasons.add("MISSING_TRACK", "the file has no track", "moov");
  if (tracks.length > 1) reasons.add("UNEXPECTED_TRACKS", `the file has ${tracks.length} tracks; an export is one video track`, "moov");
  let lengthSize: number | null = null;
  for (const trak of tracks) {
    for (const tkhd of kids(trak, "tkhd")) checkTimes(bytes, tkhd, expectedS, toleranceS, reasons);
    const mdia = kids(trak, "mdia")[0];
    if (mdia === undefined) continue;
    for (const mdhd of kids(mdia, "mdhd")) checkTimes(bytes, mdhd, expectedS, toleranceS, reasons);
    for (const hdlr of kids(mdia, "hdlr")) checkHandler(bytes, hdlr, "vide", reasons);
    const minf = kids(mdia, "minf")[0];
    if (minf === undefined) continue;
    for (const dref of kids(kids(minf, "dinf")[0] ?? minf, "dref")) checkDref(bytes, dref, reasons);
    const entry = kids(kids(kids(minf, "stbl")[0] ?? minf, "stsd")[0] ?? minf, "avc1")[0];
    if (entry === undefined) {
      reasons.add("VIDEO_FORMAT_WRONG", "the track's sample entry is not avc1", trak.path);
      continue;
    }
    checkCompressor(bytes, entry, reasons);
    checkColour(bytes, entry, reasons);
    if (tracks.length === 1) lengthSize = avcConfig(bytes, entry, reasons);
  }
  checkPrintableRuns(bytes, reasons);
  return { lengthSize };
}

// ---------------------------------------------------------------------------
// The top level, the coded pictures, the strings
// ---------------------------------------------------------------------------

/** ftyp first, one each of ftyp, moov and mdat, at most one free (empty), the index before the media data, and nothing else. */
async function checkTopLevel(handle: FileHandle, path: string, top: readonly TopBox[], findings: Findings): Promise<void> {
  for (const type of ["ftyp", "moov", "mdat"]) {
    const count = top.filter((b) => b.type === type).length;
    if (count === 0) findings.add("MISSING_BOX", `the file has no '${type}' box`, type);
    if (count > 1) findings.add("DUPLICATE_BOX", `the file has ${count} '${type}' boxes`, type);
  }
  if (top.filter((b) => b.type === "free").length > 1) findings.add("DUPLICATE_BOX", "the file has more than one 'free' box", "free");
  if (top[0] !== undefined && top[0].type !== "ftyp") findings.add("FTYP_NOT_FIRST", "ftyp is not the first box", "ftyp");
  const moovAt = top.find((b) => b.type === "moov")?.start;
  const mdatAt = top.find((b) => b.type === "mdat")?.start;
  if (moovAt !== undefined && mdatAt !== undefined && moovAt > mdatAt) findings.add("NOT_FASTSTART", "moov comes after mdat", "moov");
  for (const box of top) {
    const head = box.type === "uuid" ? await readAt(handle, path, box.body, Math.min(UUID_PAYLOAD_HEAD_BYTES, box.end - box.body)) : new Uint8Array(0);
    const forbidden = forbiddenCode(box.type, head);
    if (forbidden !== undefined) findings.add(forbidden, `top-level box ${quote(box.type)} is never allowed`, box.type);
    else if (!TOP_LEVEL.has(box.type)) findings.add("UNKNOWN_BOX", `top-level box ${quote(box.type)} is not allowed`, box.type);
    else if (box.type === "free") {
      const length = box.end - box.body;
      const payload = length > FREE_MAX_BYTES ? undefined : await readAt(handle, path, box.body, length);
      if (payload === undefined || payload.some((b) => b !== 0)) findings.add("FREE_BOX_NOT_EMPTY", `the free box holds ${length} bytes that are not all zero`, "free");
    }
  }
}

/** `ftyp`: major `isom`, the compatible brands ffmpeg's mp4 muxer writes. */
function checkFtyp(box: Uint8Array, headerLength: number, findings: Findings): void {
  if (box.length < headerLength + 8 || (box.length - headerLength - 8) % 4 !== 0) return findings.add("FTYP_BRAND_NOT_ALLOWED", "ftyp does not end on a brand boundary", "ftyp");
  const major = latin1(box, headerLength, headerLength + 4);
  if (major !== MAJOR_BRAND) findings.add("FTYP_BRAND_NOT_ALLOWED", `major brand is ${quote(major)}, expected ${MAJOR_BRAND}`, "ftyp");
  for (let at = headerLength + 8; at < box.length; at += 4) {
    const brand = latin1(box, at, at + 4);
    if (!COMPATIBLE_BRANDS.has(brand)) findings.add("FTYP_BRAND_NOT_ALLOWED", `compatible brand ${quote(brand)} is not allowed`, "ftyp");
  }
}

/** Walks `mdat` as the sequence of length-prefixed NAL units the index says it is; a NAL of type 6 (SEI) is refused. */
async function walkNalUnits(handle: FileHandle, path: string, mdat: TopBox, lengthSize: number, reasons: Reasons): Promise<void> {
  let at = mdat.body;
  for (let units = 0; at < mdat.end; units++) {
    if (units >= MAX_NAL_UNITS) return reasons.add("NAL_WALK_FAILED", `more than ${MAX_NAL_UNITS} NAL units`, "mdat");
    const head = await readAt(handle, path, at, lengthSize + 1);
    if (head.length < lengthSize + 1) return reasons.add("NAL_WALK_FAILED", `a NAL unit at byte ${at} is cut off`, "mdat");
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + (head[i] ?? 0);
    if (length === 0 || at + lengthSize + length > mdat.end) return reasons.add("NAL_WALK_FAILED", `the NAL unit at byte ${at} claims ${length} bytes`, "mdat");
    if (((head[lengthSize] ?? 0) & 0x1f) === SEI_NAL_TYPE) return reasons.add("SEI_FOUND", `an SEI NAL unit at byte ${at}`, "mdat");
    at += lengthSize + length;
  }
}

/** The bytes of every top-level box but `mdat` (each bounded): where a tag, a name or a note could be. */
async function bytesOutsideMdat(handle: FileHandle, path: string, top: readonly TopBox[]): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for (const box of top) {
    if (box.type === "mdat") continue;
    parts.push(await readAt(handle, path, box.start, Math.min(box.end - box.start, MOOV_MAX_BYTES)));
  }
  return parts;
}

function checkForbiddenText(parts: readonly Uint8Array[], reasons: Reasons): void {
  for (const part of parts) {
    const text = Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString("latin1").toLowerCase();
    for (const word of CLIP_EXPORT_FORBIDDEN_TEXT) {
      const at = text.indexOf(word);
      // The word is named by its place in the list, never quoted from the file.
      if (at >= 0) reasons.add("FORBIDDEN_TEXT", `forbidden word #${CLIP_EXPORT_FORBIDDEN_TEXT.indexOf(word)} outside the coded pictures`);
    }
  }
}

/** Judges an exported clip against I5.58 and hashes it in the same read. Throws only when the file cannot be opened or read (a `VerifyIoError`-like failure of the disk). */
export async function verifyClipExport(path: string, expected: ClipExportExpected, options: ClipExportVerifyOptions = {}): Promise<ClipExportVerdict> {
  const findings = new Findings();
  const reasons = new Reasons();
  const handle = await openRegularNoFollow(path, options.open ?? {});
  try {
    const info = await handle.stat();
    const size = info.size;
    if (!info.isFile()) {
      findings.add("STRUCTURE_UNRECOGNISED", "not a regular file");
      return { ok: false, reasons: findings.list, sha256: null, bytes: size };
    }
    if (size > (options.maxBytes ?? MAX_EXPORT_BYTES)) {
      findings.add("FILE_TOO_LARGE", `${size} bytes is over the cap`);
      return { ok: false, reasons: findings.list, sha256: null, bytes: size };
    }
    const top = await walkTopLevel(handle, path, size, findings);
    await checkTopLevel(handle, path, top, findings);
    const ftyp = top.find((b) => b.type === "ftyp");
    if (ftyp !== undefined) {
      if (ftyp.end - ftyp.start > FTYP_MAX_BYTES) findings.add("FTYP_BRAND_NOT_ALLOWED", "ftyp is over its cap", "ftyp");
      else checkFtyp(await readAt(handle, path, ftyp.start, ftyp.end - ftyp.start), ftyp.body - ftyp.start, findings);
    }
    const moov = top.find((b) => b.type === "moov");
    const mdat = top.find((b) => b.type === "mdat");
    if (moov !== undefined) {
      if (moov.end - moov.start > MOOV_MAX_BYTES) findings.add("BOX_TOO_LARGE", "moov is over its cap", "moov");
      else {
        const bytes = await readAt(handle, path, moov.start, moov.end - moov.start);
        const children = walkNested(bytes, moov.body - moov.start, bytes.length, "moov", MOOV, findings);
        const facts = checkMoov(bytes, children, expected, reasons);
        if (mdat !== undefined) {
          const before = findings.list.length;
          checkMediaData(bytes, children, mdat, findings);
          const tiled = !findings.list.slice(before).some((r) => r.code === "MEDIA_DATA_MISMATCH");
          // The pictures are walked only once the index is shown to tile mdat exactly: then mdat is nothing but the samples, each a run of NAL units.
          if (tiled && facts.lengthSize !== null) await walkNalUnits(handle, path, mdat, facts.lengthSize, reasons);
        }
      }
    }
    checkForbiddenText(await bytesOutsideMdat(handle, path, top), reasons);

    const hash = createHash("sha256");
    let hashed = 0;
    const hits = await scanForNeedles(handle, path, size, BUILTIN_MARKERS, undefined, (chunk) => {
      hash.update(chunk);
      hashed += chunk.length;
    });
    for (const hit of hits) findings.add("SOURCE_METADATA_STRING", `photo-metadata marker '${hit.label}' found at byte ${hit.offset}`);
    const all: ClipExportReason[] = [...findings.list, ...reasons.list];
    return { ok: all.length === 0, reasons: all, sha256: hashed === size ? hash.digest("hex") : null, bytes: size };
  } finally {
    await handle.close();
  }
}
