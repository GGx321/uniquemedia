import type { FileHandle } from "node:fs/promises";
import { forbiddenCode, UUID_PAYLOAD_HEAD_BYTES } from "./allowlist";
import { VerifyIoError, type VerifyReason, type VerifyReasonCode } from "./types";

// A bounded, defensive ISO-BMFF box walker for the output verifier. It never
// believes a box size: every size is checked against what its parent (or the
// file) really holds before anything is read for it, a 64-bit `largesize` is
// compared as a BigInt, and a size of 0 ("to the end") is honoured only where
// the format allows it. The media data is never loaded: the top level is
// walked by reading 16-byte headers at offsets, and only `ftyp` and `moov`
// (the index, a few KiB for a minute of video) are read whole.
//
// Descent follows a fixed schema, never the data: a box is opened only when
// its type is a known container at its known place. The depth of the walk is
// therefore at most the schema's depth (9), whatever the file claims.

/** `moov` for a minute of 30 fps video is about 100 KiB. Anything over this is not one of ours. */
export const MOOV_MAX_BYTES = 16 * 1024 * 1024;
/** The most boxes examined inside `moov`, and at the top level. The real file has about 50. */
export const MAX_NESTED_BOXES = 10_000;
export const MAX_TOP_LEVEL_BOXES = 1_000;

export interface Mp4Box {
  readonly type: string;
  /** `moov/trak/mdia`, ... (types only, no indexes). */
  readonly path: string;
  /** Offset of the box header, in the buffer (or file) it was found in. */
  readonly start: number;
  /** Offset of the first payload byte, after the (possibly 64-bit) header. */
  readonly body: number;
  /** One past the last byte. */
  readonly end: number;
  /** The boxes inside, for a container the schema opened; empty otherwise. */
  readonly children: readonly Mp4Box[];
}

/** Collects the reasons found, in order, without repeating one. */
export class Findings {
  private readonly seen = new Set<string>();
  readonly list: VerifyReason[] = [];

  add(code: VerifyReasonCode, message: string, path?: string): void {
    const key = `${code}\u0000${path ?? ""}\u0000${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push(path === undefined ? { code, message } : { code, message, path });
  }
}

// ---------------------------------------------------------------------------
// Header decoding
// ---------------------------------------------------------------------------

export type Header =
  | { readonly kind: "box"; readonly type: string; readonly size: number; readonly headerLength: number; readonly zeroSize: boolean }
  | { readonly kind: "out_of_bounds"; readonly type: string }
  | { readonly kind: "bad_size"; readonly type: string; readonly size: number };

const latin1 = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));

/**
 * Decodes the box header at the start of `head` (at least the first 16 bytes
 * of what follows, fewer at the very end). `available` is how many bytes the
 * parent has left from this box's start: the box may not claim more.
 */
export function decodeHeader(head: Uint8Array, available: number): Header {
  if (available < 8 || head.length < 8) return { kind: "out_of_bounds", type: head.length >= 8 ? latin1(head, 4, 4) : "????" };
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const type = latin1(head, 4, 4);
  const size32 = view.getUint32(0);
  if (size32 === 1) {
    if (available < 16 || head.length < 16) return { kind: "out_of_bounds", type };
    const large = view.getBigUint64(8);
    if (large > BigInt(available)) return { kind: "out_of_bounds", type };
    const size = Number(large);
    return size < 16 ? { kind: "bad_size", type, size } : { kind: "box", type, size, headerLength: 16, zeroSize: false };
  }
  if (size32 === 0) return { kind: "box", type, size: available, headerLength: 8, zeroSize: true };
  if (size32 < 8) return { kind: "bad_size", type, size: size32 };
  if (size32 > available) return { kind: "out_of_bounds", type };
  return { kind: "box", type, size: size32, headerLength: 8, zeroSize: false };
}

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

/**
 * Where a box may appear and what it may hold. `strict` nodes are the places
 * metadata can live or that a file with extra content would extend: a type
 * not in `allowed` there is refused. The sample tables and the sample entries
 * are not strict: they hold no free-form content, and the way ffmpeg versions
 * differ (`sdtp`, `cslg`, `btrt`, `pasp`) is exactly there. Forbidden types
 * are refused at every level either way.
 */
export interface SchemaNode {
  readonly strict: boolean;
  readonly allowed: ReadonlySet<string>;
  /** Types the walker opens, and whether four bytes of version and flags precede their children. */
  readonly containers: ReadonlyMap<string, { readonly fullBox: boolean; readonly node: SchemaNode }>;
  /** The code for a type a strict node does not allow. */
  readonly unknownCode: VerifyReasonCode;
}

const set = (...types: string[]): ReadonlySet<string> => new Set(types);
const node = (
  strict: boolean,
  allowed: ReadonlySet<string>,
  containers: ReadonlyMap<string, { fullBox: boolean; node: SchemaNode }> = new Map(),
  unknownCode: VerifyReasonCode = "UNKNOWN_BOX"
): SchemaNode => ({ strict, allowed, containers, unknownCode });

const DATA_ITEM = node(true, set("data"));
const ILST = node(true, set("©too"), new Map([["©too", { fullBox: false, node: DATA_ITEM }]]), "METADATA_KEY_NOT_ALLOWED");
const META = node(true, set("hdlr", "ilst"), new Map([["ilst", { fullBox: false, node: ILST }]]));
const UDTA = node(true, set("meta"), new Map([["meta", { fullBox: true, node: META }]]));
const STBL = node(false, set("stsd", "stts", "stss", "ctts", "stsc", "stsz", "stco", "co64", "sgpd", "sbgp", "sdtp", "cslg", "stps"));
const DINF = node(false, set("dref"));
const MINF = node(true, set("vmhd", "smhd", "dinf", "stbl"), new Map([["dinf", { fullBox: false, node: DINF }], ["stbl", { fullBox: false, node: STBL }]]));
const MDIA = node(true, set("mdhd", "hdlr", "minf"), new Map([["minf", { fullBox: false, node: MINF }]]));
const EDTS = node(true, set("elst"));
const TRAK = node(true, set("tkhd", "edts", "mdia"), new Map([["edts", { fullBox: false, node: EDTS }], ["mdia", { fullBox: false, node: MDIA }]]));
export const MOOV_SCHEMA = node(true, set("mvhd", "trak", "udta"), new Map([["trak", { fullBox: false, node: TRAK }], ["udta", { fullBox: false, node: UDTA }]]));

/** The only boxes the file's top level may hold. */
export const TOP_LEVEL_ALLOWED = set("ftyp", "moov", "free", "mdat");

// ---------------------------------------------------------------------------
// Walking a buffer (moov)
// ---------------------------------------------------------------------------

interface Walk {
  readonly bytes: Uint8Array;
  readonly findings: Findings;
  count: number;
}

/**
 * Walks the boxes of `bytes[from, to)` against `schema`. Reports each problem
 * once and stops walking a parent whose next header cannot be trusted; the
 * boxes found before it are still returned.
 */
export function walkNested(bytes: Uint8Array, from: number, to: number, parentPath: string, schema: SchemaNode, findings: Findings): Mp4Box[] {
  return walkRegion({ bytes, findings, count: 0 }, from, to, parentPath, schema);
}

function walkRegion(w: Walk, from: number, to: number, parentPath: string, schema: SchemaNode): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let at = from;
  while (at < to) {
    if (++w.count > MAX_NESTED_BOXES) {
      w.findings.add("TOO_MANY_BOXES", `more than ${MAX_NESTED_BOXES} boxes inside moov`, parentPath);
      break;
    }
    const header = decodeHeader(w.bytes.subarray(at, Math.min(at + 16, to)), to - at);
    if (header.kind === "out_of_bounds") {
      w.findings.add("BOX_OUT_OF_BOUNDS", `box '${header.type}' at byte ${at} claims more than '${parentPath}' holds`, parentPath);
      break;
    }
    if (header.kind === "bad_size") {
      w.findings.add("BOX_BAD_SIZE", `box '${header.type}' at byte ${at} has size ${header.size}, smaller than its own header`, parentPath);
      break;
    }
    const path = `${parentPath}/${header.type}`;
    if (header.zeroSize) w.findings.add("BOX_ZERO_SIZE", `box '${header.type}' at byte ${at} has size 0, which is only valid for a last top-level mdat`, path);
    const end = at + header.size;
    const known = schema.containers.get(header.type);
    let children: Mp4Box[] = [];
    const forbidden = forbiddenCode(header.type, w.bytes.subarray(at + header.headerLength, Math.min(end, at + header.headerLength + UUID_PAYLOAD_HEAD_BYTES)));
    if (forbidden) {
      w.findings.add(forbidden, `box '${header.type}' at byte ${at} is never allowed`, path);
    } else if (known && !header.zeroSize) {
      children = walkRegion(w, at + header.headerLength + (known.fullBox ? 4 : 0), end, path, known.node);
    } else if (!schema.allowed.has(header.type) && schema.strict) {
      w.findings.add(schema.unknownCode, `box '${header.type}' is not allowed in '${parentPath}'`, path);
    }
    boxes.push({ type: header.type, path, start: at, body: at + header.headerLength, end, children });
    at = end;
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/** Reads up to `length` bytes at `position`; fewer only at the end of the file. */
export async function readAt(handle: FileHandle, path: string, position: number, length: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  let got = 0;
  try {
    while (got < length) {
      const { bytesRead } = await handle.read(buffer, got, length - got, position + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
  } catch (cause) {
    throw new VerifyIoError("read_failed", path, { cause });
  }
  return buffer.subarray(0, got);
}

export interface TopBox {
  readonly type: string;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

/**
 * Walks the top level of a file of `size` bytes by header reads only. The
 * walk stops at the first header that cannot be trusted; what came before it
 * is returned.
 */
export async function walkTopLevel(handle: FileHandle, path: string, size: number, findings: Findings): Promise<TopBox[]> {
  const boxes: TopBox[] = [];
  let at = 0;
  while (at < size) {
    if (boxes.length >= MAX_TOP_LEVEL_BOXES) {
      findings.add("TOO_MANY_BOXES", `more than ${MAX_TOP_LEVEL_BOXES} top-level boxes`);
      break;
    }
    const header = decodeHeader(await readAt(handle, path, at, Math.min(16, size - at)), size - at);
    if (header.kind === "out_of_bounds") {
      findings.add("FILE_TRUNCATED", `box '${header.type}' at byte ${at} claims more than the file holds (${size} bytes)`, header.type);
      break;
    }
    if (header.kind === "bad_size") {
      findings.add("BOX_BAD_SIZE", `box '${header.type}' at byte ${at} has size ${header.size}, smaller than its own header`, header.type);
      break;
    }
    if (header.zeroSize && header.type !== "mdat") {
      findings.add("BOX_ZERO_SIZE", `top-level box '${header.type}' at byte ${at} has size 0, which is only valid for the last mdat`, header.type);
    }
    boxes.push({ type: header.type, start: at, body: at + header.headerLength, end: at + header.size });
    at += header.size;
  }
  return boxes;
}
