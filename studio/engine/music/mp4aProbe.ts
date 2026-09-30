// A bounded ISO-BMFF box walker for one purpose (invariant 31, acceptance): does this untrusted file hold exactly one
// AAC audio stream (`mp4a`, AAC-LC or HE-AAC) and nothing else? It never believes a size: every one is checked against
// what its parent holds before anything is read for it, and a 64-bit size is compared as a BigInt. The media data
// (`mdat`) is never read. Descent follows a fixed schema, never the data: `moov/trak/mdia/minf/stbl/stsd/mp4a/esds` and
// `minf/dinf/dref`, so the depth is fixed at nine whatever the file claims, and the number of boxes visited is capped.
//
// This is the FIRST gate. The bounded decode (`decodeCheck.ts`) is the second: a file that walks clean can still hold
// garbage samples, and a file that decodes can still carry a video stream or a reference to another file, which is
// why both exist.

/** An audio-only `moov` is a few KiB to a few hundred; past this it is not one of ours. */
export const MOOV_MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 200;
const MAX_CHILDREN = 512;
const MAX_TRACKS = 8;
const MAX_VISITED = 4000;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 96000;
/** AAC-LC, SBR (HE-AAC) and SBR+PS (HE-AACv2): what the render's decode and resample step is built for (3c.5). */
const ACCEPTED_OBJECT_TYPES: ReadonlySet<number> = new Set([2, 5, 29]);
const MPEG4_AUDIO = 0x40;

export type ProbeRefusal =
  | "bad-box"
  | "no-ftyp"
  | "no-moov"
  | "several-moov"
  | "moov-too-large"
  | "too-many-boxes"
  | "too-many-tracks"
  | "no-audio-track"
  | "several-audio-tracks"
  | "has-video"
  | "not-mp4a"
  | "esds-unreadable"
  | "not-aac"
  | "unsupported-profile"
  | "unsupported-format"
  | "external-data-reference";

export interface Mp4AudioInfo {
  readonly codec: "mp4a";
  /** 2 AAC-LC, 5 SBR (HE-AAC), 29 SBR+PS (HE-AACv2). */
  readonly audioObjectType: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** From `mdhd`; null when the header says none. The decode is what proves the length, this is only its claim. */
  readonly durationMs: number | null;
}

export type Mp4Probe = { readonly ok: true; readonly info: Mp4AudioInfo } | { readonly ok: false; readonly reason: ProbeRefusal };

class Refusal extends Error {
  readonly reason: ProbeRefusal;
  constructor(reason: ProbeRefusal) {
    super(reason);
    this.reason = reason;
  }
}

interface BoxRef {
  readonly type: string;
  /** Offset of the first payload byte, after the (possibly 64-bit) header. */
  readonly body: number;
  /** One past the last byte. */
  readonly end: number;
}

const latin1 = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));

/** The box whose header starts at `at`, checked against `limit` (what the parent holds). A size of 0 means "to the end" and is honoured only at the top level. */
function readBox(bytes: Uint8Array, view: DataView, at: number, limit: number, topLevel: boolean): BoxRef {
  const available = limit - at;
  if (available < 8) throw new Refusal("bad-box");
  const size32 = view.getUint32(at);
  const type = latin1(bytes, at + 4, at + 8);
  if (size32 === 1) {
    if (available < 16) throw new Refusal("bad-box");
    const large = view.getBigUint64(at + 8);
    if (large < 16n || large > BigInt(available)) throw new Refusal("bad-box");
    return { type, body: at + 16, end: at + Number(large) };
  }
  if (size32 === 0) {
    if (!topLevel) throw new Refusal("bad-box");
    return { type, body: at + 8, end: limit };
  }
  if (size32 < 8 || size32 > available) throw new Refusal("bad-box");
  return { type, body: at + 8, end: at + size32 };
}

/** The boxes directly inside `[start, end)`, at most `max` of them; each is counted against the shared visit budget. */
function childrenOf(bytes: Uint8Array, view: DataView, start: number, end: number, budget: { visited: number }, max: number = MAX_CHILDREN): BoxRef[] {
  const found: BoxRef[] = [];
  for (let at = start; at < end; ) {
    if (found.length >= max || ++budget.visited > MAX_VISITED) throw new Refusal("too-many-boxes");
    const box = readBox(bytes, view, at, end, false);
    found.push(box);
    at = box.end;
  }
  return found;
}

const firstOf = (boxes: readonly BoxRef[], type: string): BoxRef | undefined => boxes.find((box) => box.type === type);

/** The bits of an MPEG-4 descriptor's length: one to four bytes of seven bits, the high bit saying another follows. */
function descriptorAt(bytes: Uint8Array, at: number, limit: number): { tag: number; body: number; end: number } {
  if (at + 2 > limit) throw new Refusal("esds-unreadable");
  const tag = bytes[at] ?? 0;
  let length = 0;
  let cursor = at + 1;
  for (let i = 0; i < 4; i++) {
    if (cursor >= limit) throw new Refusal("esds-unreadable");
    const byte = bytes[cursor++] ?? 0;
    length = (length << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
    if (i === 3) throw new Refusal("esds-unreadable");
  }
  if (cursor + length > limit) throw new Refusal("esds-unreadable");
  return { tag, body: cursor, end: cursor + length };
}

/** The objectTypeIndication and the AudioSpecificConfig's object type from an `esds` payload (after its version and flags). */
function readEsds(bytes: Uint8Array, start: number, end: number): { oti: number; audioObjectType: number } {
  const es = descriptorAt(bytes, start, end);
  if (es.tag !== 0x03) throw new Refusal("esds-unreadable");
  // ES_ID (2), then the flags byte, whose bits say whether a dependency, a URL and an OCR id follow.
  let cursor = es.body + 3;
  if (cursor > es.end) throw new Refusal("esds-unreadable");
  const flags = bytes[es.body + 2] ?? 0;
  if ((flags & 0x80) !== 0) cursor += 2;
  if ((flags & 0x40) !== 0) {
    if (cursor >= es.end) throw new Refusal("esds-unreadable");
    cursor += 1 + (bytes[cursor] ?? 0);
  }
  if ((flags & 0x20) !== 0) cursor += 2;
  const config = descriptorAt(bytes, cursor, es.end);
  if (config.tag !== 0x04 || config.end - config.body < 13) throw new Refusal("esds-unreadable");
  const oti = bytes[config.body] ?? 0;
  const info = descriptorAt(bytes, config.body + 13, config.end);
  if (info.tag !== 0x05 || info.end - info.body < 2) throw new Refusal("esds-unreadable");
  // AudioSpecificConfig: five bits of object type, or 31 and six more.
  const first = bytes[info.body] ?? 0;
  let audioObjectType = first >> 3;
  if (audioObjectType === 31) audioObjectType = 32 + ((((first & 0x07) << 3) | ((bytes[info.body + 1] ?? 0) >> 5)) & 0x3f);
  return { oti, audioObjectType };
}

interface TrackFacts {
  handler: string;
  entryType: string | null;
  audio: { channels: number; sampleRate: number; oti: number; audioObjectType: number } | null;
  durationMs: number | null;
}

function readTrack(bytes: Uint8Array, view: DataView, trak: BoxRef, budget: { visited: number }): TrackFacts {
  const mdia = firstOf(childrenOf(bytes, view, trak.body, trak.end, budget), "mdia");
  if (mdia === undefined) throw new Refusal("no-audio-track");
  const inMdia = childrenOf(bytes, view, mdia.body, mdia.end, budget);
  const hdlr = firstOf(inMdia, "hdlr");
  if (hdlr === undefined || hdlr.end - hdlr.body < 12) throw new Refusal("no-audio-track");
  const handler = latin1(bytes, hdlr.body + 8, hdlr.body + 12);
  const facts: TrackFacts = { handler, entryType: null, audio: null, durationMs: null };
  if (handler !== "soun") return facts;

  const mdhd = firstOf(inMdia, "mdhd");
  if (mdhd !== undefined && mdhd.end - mdhd.body >= 24) {
    const version = bytes[mdhd.body] ?? 0;
    const timescale = version === 1 ? (mdhd.end - mdhd.body >= 32 ? view.getUint32(mdhd.body + 20) : 0) : view.getUint32(mdhd.body + 12);
    const duration = version === 1 ? Number(view.getBigUint64(mdhd.body + 24)) : view.getUint32(mdhd.body + 16);
    if (timescale > 0 && Number.isFinite(duration)) facts.durationMs = Math.round((duration * 1000) / timescale);
  }

  const minf = firstOf(inMdia, "minf");
  if (minf === undefined) throw new Refusal("not-mp4a");
  const inMinf = childrenOf(bytes, view, minf.body, minf.end, budget);
  // A data reference that is not self-contained (flag 1 unset) makes a demuxer open ANOTHER file or URL for the samples.
  const dinf = firstOf(inMinf, "dinf");
  const dref = dinf === undefined ? undefined : firstOf(childrenOf(bytes, view, dinf.body, dinf.end, budget), "dref");
  if (dref !== undefined) {
    if (dref.end - dref.body < 8) throw new Refusal("bad-box");
    for (const entry of childrenOf(bytes, view, dref.body + 8, dref.end, budget)) {
      if (entry.end - entry.body < 4 || ((bytes[entry.body + 3] ?? 0) & 1) === 0) throw new Refusal("external-data-reference");
    }
  }
  const stbl = firstOf(inMinf, "stbl");
  if (stbl === undefined) throw new Refusal("not-mp4a");
  const stsd = firstOf(childrenOf(bytes, view, stbl.body, stbl.end, budget), "stsd");
  if (stsd === undefined || stsd.end - stsd.body < 8) throw new Refusal("not-mp4a");
  // One sample entry, exactly: a claim of more is a lie or a container Studio does not read.
  if (view.getUint32(stsd.body + 4) !== 1) throw new Refusal("bad-box");
  const entry = readBox(bytes, view, stsd.body + 8, stsd.end, false);
  facts.entryType = entry.type;
  if (entry.type !== "mp4a") return facts;

  // AudioSampleEntry: 6 reserved, 2 data reference index, 8 reserved, then channels, sample size, 2 + 2 reserved and the
  // sample rate as 16.16 fixed point, 28 bytes in all; the child boxes (`esds`) follow.
  if (entry.end - entry.body < 28) throw new Refusal("bad-box");
  const channels = view.getUint16(entry.body + 16);
  const entryRate = view.getUint16(entry.body + 24);
  const esds = firstOf(childrenOf(bytes, view, entry.body + 28, entry.end, budget), "esds");
  if (esds === undefined || esds.end - esds.body < 4) throw new Refusal("esds-unreadable");
  const { oti, audioObjectType } = readEsds(bytes, esds.body + 4, esds.end);
  facts.audio = { channels, sampleRate: entryRate, oti, audioObjectType };
  return facts;
}

function walk(bytes: Uint8Array): Mp4AudioInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 16) throw new Refusal("bad-box");
  const budget = { visited: 0 };
  let moov: BoxRef | null = null;
  let boxes = 0;
  for (let at = 0; at < bytes.byteLength; ) {
    if (++boxes > MAX_TOP_LEVEL_BOXES) throw new Refusal("too-many-boxes");
    const box = readBox(bytes, view, at, bytes.byteLength, true);
    if (boxes === 1 && box.type !== "ftyp") throw new Refusal("no-ftyp");
    if (box.type === "moov") {
      if (moov !== null) throw new Refusal("several-moov");
      moov = box;
    }
    at = box.end;
  }
  if (moov === null) throw new Refusal("no-moov");
  if (moov.end - moov.body > MOOV_MAX_BYTES) throw new Refusal("moov-too-large");

  const tracks: TrackFacts[] = [];
  const traks = childrenOf(bytes, view, moov.body, moov.end, budget).filter((child) => child.type === "trak");
  // Counted before any is read: a file of a hundred tracks is refused for that, not for what the first one lacks.
  if (traks.length > MAX_TRACKS) throw new Refusal("too-many-tracks");
  for (const trak of traks) tracks.push(readTrack(bytes, view, trak, budget));
  const audio = tracks.filter((track) => track.handler === "soun");
  if (audio.length === 0) throw new Refusal("no-audio-track");
  if (tracks.some((track) => track.handler === "vide")) throw new Refusal("has-video");
  if (audio.length > 1) throw new Refusal("several-audio-tracks");
  const only = audio[0];
  if (only === undefined || only.entryType !== "mp4a" || only.audio === null) throw new Refusal("not-mp4a");
  const { channels, sampleRate, oti, audioObjectType } = only.audio;
  if (oti !== MPEG4_AUDIO) throw new Refusal("not-aac");
  if (!ACCEPTED_OBJECT_TYPES.has(audioObjectType)) throw new Refusal("unsupported-profile");
  if (channels < 1 || channels > 2 || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) throw new Refusal("unsupported-format");
  return { codec: "mp4a", audioObjectType, sampleRate, channels, durationMs: only.durationMs };
}

/** Reads the container of `bytes` and says whether it holds one AAC audio stream, or why it does not. Never throws. */
export function probeMp4Audio(bytes: Uint8Array): Mp4Probe {
  try {
    return { ok: true, info: walk(bytes) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason };
    // A RangeError from a read past the end that a check missed is still a refusal, never a crash.
    return { ok: false, reason: "bad-box" };
  }
}
