import { latin1Bytes as latin1 } from "./reader";
import type { Needle } from "./scan";
import type { VerifyReasonCode } from "./types";

// Invariant 14, as data: what the engine's MP4 may carry (plan Metadata row,
// A4). Everything here was measured on a real ffmpeg 6.0 render
// (`render.pass2.ffmpeg.test.ts`); the ffmpeg version strings are matched by
// shape because Windows bundles 6.1.1.

/** Boxes refused wherever they appear, each with the code that names it. `uuid` is refined by its payload (see `forbiddenCode`). */
const FORBIDDEN_BOXES: ReadonlyMap<string, VerifyReasonCode> = new Map([
  ["uuid", "UUID_BOX"],
  ["XMP_", "XMP_BOX"],
  ["jumb", "PROVENANCE_BOX"],
  ["c2pa", "PROVENANCE_BOX"],
  ["chpl", "CHAPTER_BOX"],
  ["Exif", "EXIF_BOX"],
  ["©xyz", "LOCATION_BOX"],
  ["loci", "LOCATION_BOX"],
  ["gps ", "LOCATION_BOX"],
  ["GPS ", "LOCATION_BOX"],
  ["©day", "DATE_BOX"],
]);

/** The XMP packet's UUID, BE7ACFCB-97A9-42E8-9C71-999491E3AFAC, as it starts a `uuid` box's payload. */
const XMP_UUID = Uint8Array.from([0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac]);
export const UUID_PAYLOAD_HEAD_BYTES = 16;

/** The UUID of a C2PA manifest store in a `uuid` box, D8FEC3D6-1B0E-483C-9297-5828877EC481. */
const C2PA_UUID = Uint8Array.from([0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81]);

const startsWith = (head: Uint8Array, id: Uint8Array): boolean => head.length >= id.length && id.every((b, i) => head[i] === b);

/** The reason for a box that may never appear, or undefined when the type is not on the list. `payloadHead` is the first 16 bytes after the header. */
export function forbiddenCode(type: string, payloadHead: Uint8Array): VerifyReasonCode | undefined {
  const code = FORBIDDEN_BOXES.get(type);
  if (code !== "UUID_BOX") return code;
  if (startsWith(payloadHead, XMP_UUID)) return "XMP_BOX";
  if (startsWith(payloadHead, C2PA_UUID)) return "PROVENANCE_BOX";
  return "UUID_BOX";
}

/** `ftyp`: what `-f mp4` writes (major `isom`; `isom`, `iso2`, `avc1`, `mp41` compatible). The minor version is not pinned. */
export const ALLOWED_MAJOR_BRAND = "isom";
export const ALLOWED_COMPATIBLE_BRANDS: ReadonlySet<string> = new Set(["isom", "iso2", "avc1", "mp41"]);

/** The container's `encoder` (`ilst/©too`): `Lavf` and a version, whatever the build. */
export const ENCODER_TAG = /^Lavf\d+\.\d+\.\d+$/;
/** The video sample entry's compressor name (the stream `encoder`). */
export const COMPRESSOR_NAME = /^Lavc\d+\.\d+\.\d+ libx264$/;
/** `hdlr` names, by handler type. */
export const HANDLER_NAMES: ReadonlyMap<string, string> = new Map([
  ["vide", "VideoHandler"],
  ["soun", "SoundHandler"],
]);
/** ffmpeg writes `mdir` as the handler of the `meta` box that holds `ilst`. */
export const META_HANDLER_TYPE = "mdir";
/** ISO 639-2/T "und", packed as three 5-bit letters, in `mdhd`. */
export const LANGUAGE_UND = 0x55c4;

/**
 * Strings that mark a photo's own metadata, searched in the WHOLE file
 * including the media data. Each is long enough that a chance match in a few
 * dozen MB of H.264 is impossible (2^-64 or less per position). The
 * caller's own strings (the source photos' Artist, Copyright) are added to
 * these.
 */
export const BUILTIN_MARKERS: readonly Needle[] = [
  { label: "xmp-namespace", bytes: latin1("http://ns.adobe.com/") },
  { label: "xmpmeta", bytes: latin1("<x:xmpmeta") },
  { label: "xpacket", bytes: latin1("<?xpacket") },
  { label: "exif-little-endian", bytes: latin1("Exif\u0000\u0000II*\u0000") },
  { label: "exif-big-endian", bytes: latin1("Exif\u0000\u0000MM\u0000*") },
  { label: "tiff-little-endian", bytes: latin1("II*\u0000\u0008\u0000\u0000\u0000") },
  { label: "tiff-big-endian", bytes: latin1("MM\u0000*\u0000\u0000\u0000\u0008") },
  { label: "c2pa-urn", bytes: latin1("urn:c2pa") },
  // The JUMBF content type of a C2PA manifest store, 63327061-0011-0010-8000-00AA00389B71
  // (c2pa-rs: CAI_BLOCK_UUID = "6332706100110010800000AA00389B71").
  { label: "c2pa-jumbf-type", bytes: Uint8Array.from([0x63, 0x32, 0x70, 0x61, 0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]) },
  { label: "icc-profile", bytes: latin1("ICC_PROFILE\u0000") },
];
