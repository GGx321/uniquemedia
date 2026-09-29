import { ALLOWED_COMPATIBLE_BRANDS, ALLOWED_MAJOR_BRAND, COMPRESSOR_NAME, ENCODER_TAG, HANDLER_NAMES, LANGUAGE_UND, META_HANDLER_TYPE } from "./allowlist";
import type { Findings, Mp4Box } from "./boxes";
import { latin1, u16, u32, u64, u8 } from "./reader";

// The checks that read inside `moov`: the metadata allowlist (invariant 14)
// for what the box walk cannot see, the box types alone. All of them work on
// the moov buffer and report by code; none throws.

export const kids = (box: Mp4Box, type: string): Mp4Box[] => box.children.filter((c) => c.type === type);
const unreadable = (findings: Findings, box: Mp4Box, what: string): void =>
  findings.add("STRUCTURE_UNRECOGNISED", `${box.type} is too short or has a layout this verifier does not know: ${what}`, box.path);

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

interface Handler {
  readonly type: string;
  /** The name with its trailing NULs removed. */
  readonly name: string;
}

/** `hdlr`: version and flags, pre_defined, handler type, 12 reserved bytes, then a NUL-terminated name. */
export function readHandler(bytes: Uint8Array, box: Mp4Box, findings: Findings): Handler | undefined {
  if (box.end - box.body < 24) {
    unreadable(findings, box, "no room for a handler type");
    return undefined;
  }
  return { type: latin1(bytes, box.body + 8, box.body + 12), name: latin1(bytes, box.body + 24, box.end).replace(/\u0000+$/, "") };
}

/** A track's `hdlr` and `mdhd`; returns the handler type. */
function checkMedia(bytes: Uint8Array, mdia: Mp4Box, findings: Findings): string | undefined {
  for (const mdhd of kids(mdia, "mdhd")) {
    checkTimes(bytes, mdhd, findings);
    const version = u8(bytes, mdhd.body);
    const language = u16(bytes, mdhd.body + (version === 1 ? 32 : 20));
    if (language !== undefined && language !== LANGUAGE_UND) {
      findings.add("METADATA_VALUE_NOT_ALLOWED", `mdhd language is 0x${language.toString(16)}, expected und (0x55c4)`, mdhd.path);
    }
  }
  const hdlr = kids(mdia, "hdlr")[0];
  const handler = hdlr && readHandler(bytes, hdlr, findings);
  if (!hdlr || !handler) return undefined;
  const expected = HANDLER_NAMES.get(handler.type);
  if (expected !== undefined && handler.name !== expected) {
    findings.add("METADATA_VALUE_NOT_ALLOWED", `hdlr name is ${JSON.stringify(handler.name)}, expected ${expected}`, hdlr.path);
  }
  return handler.type;
}

/**
 * The first sample entry of a track's `stsd`: the vendor field must be zeros
 * (an iPhone's, and ffmpeg's MP4 muxer's), and a video entry's compressor
 * name must be x264's.
 */
function checkSampleEntry(bytes: Uint8Array, stsd: Mp4Box, findings: Findings): void {
  const entry = stsd.children[0];
  if (!entry) return unreadable(findings, stsd, "there is no sample entry");
  const vendor = bytes.subarray(entry.start + 20, entry.start + 24);
  if (vendor.length === 4 && vendor.some((b) => b !== 0)) {
    findings.add("METADATA_VALUE_NOT_ALLOWED", `${entry.type} vendor is ${JSON.stringify(latin1(bytes, entry.start + 20, entry.start + 24))}, expected four zero bytes`, entry.path);
  }
  if (entry.type !== "avc1") return;
  const at = entry.start + 50;
  const length = u8(bytes, at);
  if (length === undefined || length > 31 || at + 32 > entry.end) return unreadable(findings, entry, "no room for a compressor name");
  const name = latin1(bytes, at + 1, at + 1 + length);
  if (!COMPRESSOR_NAME.test(name)) {
    findings.add("METADATA_VALUE_NOT_ALLOWED", `the video compressor name is ${JSON.stringify(name)}, expected Lavc<version> libx264`, entry.path);
  }
}

function checkTrack(bytes: Uint8Array, trak: Mp4Box, findings: Findings): void {
  for (const tkhd of kids(trak, "tkhd")) checkTimes(bytes, tkhd, findings);
  const mdia = kids(trak, "mdia")[0];
  if (!mdia) return;
  checkMedia(bytes, mdia, findings);
  const stbl = kids(kids(mdia, "minf")[0] ?? mdia, "stbl")[0];
  const stsd = stbl && kids(stbl, "stsd")[0];
  if (stsd) checkSampleEntry(bytes, stsd, findings);
}

/** `meta` under `udta`: an `mdir` handler with no name, and `ilst` items. */
function checkMeta(bytes: Uint8Array, meta: Mp4Box, findings: Findings): void {
  for (const hdlr of kids(meta, "hdlr")) {
    const handler = readHandler(bytes, hdlr, findings);
    if (handler && (handler.type !== META_HANDLER_TYPE || handler.name !== "")) {
      findings.add("METADATA_VALUE_NOT_ALLOWED", `meta hdlr is ${JSON.stringify(handler)}, expected ${META_HANDLER_TYPE} with no name`, hdlr.path);
    }
  }
  for (const ilst of kids(meta, "ilst")) {
    for (const item of ilst.children.filter((c) => c.type === "©too")) checkEncoderItem(bytes, item, findings);
  }
}

/** `©too`: one `data` box (type indicator, locale, then the text) holding `Lavf<version>`. */
function checkEncoderItem(bytes: Uint8Array, item: Mp4Box, findings: Findings): void {
  const data = item.children.filter((c) => c.type === "data");
  const only = data.length === 1 ? data[0] : undefined;
  if (!only || only.end - only.body < 8) return void findings.add("METADATA_VALUE_NOT_ALLOWED", "the encoder tag does not hold exactly one data box", item.path);
  const value = latin1(bytes, only.body + 8, only.end);
  if (!ENCODER_TAG.test(value)) {
    findings.add("METADATA_VALUE_NOT_ALLOWED", `the encoder tag is ${JSON.stringify(value)}, expected Lavf<version>`, item.path);
  }
}

/** Checks everything inside `moov` that the box walk did not: times, names, tag values. */
export function checkMoov(bytes: Uint8Array, moovChildren: readonly Mp4Box[], findings: Findings): void {
  for (const box of moovChildren) {
    if (box.type === "mvhd") checkTimes(bytes, box, findings);
    if (box.type === "trak") checkTrack(bytes, box, findings);
    if (box.type === "udta") for (const meta of kids(box, "meta")) checkMeta(bytes, meta, findings);
  }
}

/** `ftyp`: major brand, minor version (not pinned), then compatible brands to the end. `box` is the whole box, header included. */
export function checkFtyp(box: Uint8Array, headerLength: number, findings: Findings): void {
  const body = headerLength;
  if (box.length < body + 8 || (box.length - body - 8) % 4 !== 0) {
    findings.add("FTYP_BRAND_NOT_ALLOWED", "ftyp is too short or does not end on a brand boundary", "ftyp");
    return;
  }
  const major = latin1(box, body, body + 4);
  if (major !== ALLOWED_MAJOR_BRAND) findings.add("FTYP_BRAND_NOT_ALLOWED", `major brand is ${JSON.stringify(major)}, expected ${ALLOWED_MAJOR_BRAND}`, "ftyp");
  for (let at = body + 8; at < box.length; at += 4) {
    const brand = latin1(box, at, at + 4);
    if (!ALLOWED_COMPATIBLE_BRANDS.has(brand)) findings.add("FTYP_BRAND_NOT_ALLOWED", `compatible brand ${JSON.stringify(brand)} is not allowed`, "ftyp");
  }
}
