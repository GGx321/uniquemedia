// Studio's OWN reading of an untrusted MP4 or MOV (Stage 3 plan, 3f.3a): a bounded ISO-BMFF box walker that answers what the importer needs
// to decide, from the boxes and nothing else. ffmpeg's text log is never read for a fact: its format differs between the 6.0 build (macOS)
// and the 6.1.1 one (Windows), and it prints strings the file wrote.
//
// What it reads, and where:
// - the container: `ftyp` first, one `moov` (before or after `mdat`), nothing fragmented;
// - the length: `mvhd` and the video track's `mdhd` and `stts` (the longer counts);
// - the picture: the video track's FIRST sample entry (`stsd`): its codec, its size, `colr` (nclx or QuickTime's nclc), `pasp`, and a Dolby
//   Vision `dvcC`/`dvvC`, which is read as the base layer it declares;
// - the rotation: the nine words of `tkhd`'s matrix, which must be a quarter turn and nothing else;
// - the frame rate: `stts`, from which comes the average rate and whether it varies.
//
// What bounds it, because the file is hostile:
// - it never believes a size. Every box is checked against what its parent holds before anything is read for it; a 64-bit size is a BigInt
//   compared with what is left of the file; a size of 0 ("to the end") is honoured at the top level only;
// - it never descends by what the data says. The walk follows a fixed schema (`moov/trak/mdia/minf/stbl/stsd/<entry>`, `minf/dinf/dref`),
//   so a box that contains itself, or a box tree that loops, is simply never entered: its depth is fixed and its box count is capped;
// - `mdat` is never read. The top level is walked by headers (at most `MAX_TOP_LEVEL_BOXES` of them), and `moov` is read in one piece only
//   when it is no larger than `MOOV_MAX_BYTES`;
// - a table (`stts`) is summed, never copied, and the sums are checked against the safe-integer range;
// - a read that returns less than asked is a truncated file, never a throw; a read that throws (the disk) is not swallowed.
//
// The walker is the FIRST gate. The second is ffmpeg run under limits (`videoImporter.ts`): a file that walks clean can still hold garbage
// samples; the walker keeps the obvious out, and decides what the render plan is built from.

/** Where the bytes come from: a file's handle in production, an array in a test. `read` may return fewer bytes than asked only at the end. */
export interface ByteSource {
  readonly size: number;
  read(position: number, length: number): Promise<Uint8Array>;
}

/** A ByteSource over bytes in memory. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.byteLength, read: async (position, length) => bytes.subarray(position, position + length) };
}

/** A camera's `moov` is a few hundred KiB for a 3 minute clip; 16 MiB holds hours of it, and is the most that is ever read in one piece. */
export const MOOV_MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 1000;
/**
 * The light look at a FRAGMENTED file's tracks reads headers only, so it may walk far more of them: a voice memo cut into one-second fragments (`MediaRecorder.start(1000)`) has
 * two boxes a second, and the strict bound above is passed at about eight minutes. 20 000 boxes are ten hours of such a recording, and 16 bytes of header each.
 */
const MAX_TOP_LEVEL_BOXES_LIGHT = 20_000;
const MAX_CHILDREN = 512;
/** Boxes visited inside `moov` (all levels together). */
const MAX_VISITED = 4000;
const MAX_TRACKS = 16;
const MAX_FPS = 1000;
const MIN_FPS = 0.001;
/** The most that is read in one go for a header: a 64-bit box header is 16 bytes. */
const HEADER_BYTES = 16;
/** A visual sample entry's fixed fields (ISO 14496-12, VisualSampleEntry): the boxes inside it start after them. */
const VISUAL_ENTRY_FIXED_BYTES = 78;
/** Rotation is the matrix's a, b, c, d in 16.16; w is 2.30. */
const ONE = 0x10000;
const W_ONE = 0x40000000;

export type ProbeRefusal =
  | "bad-box"
  | "no-ftyp"
  | "no-moov"
  | "several-moov"
  | "moov-too-large"
  | "too-many-boxes"
  | "too-many-tracks"
  | "fragmented"
  | "external-data-reference"
  | "bad-header"
  | "no-video-track"
  | "several-video-tracks"
  | "stray-track"
  | "duplicate-box"
  | "sample-count-mismatch"
  | "unsupported-edit"
  | "hidden-handler"
  | "hidden-track-box"
  | "several-sample-entries"
  | "dimension-mismatch"
  | "unsupported-codec"
  | "unsupported-matrix"
  | "unsupported-colour"
  | "non-square-pixels";

export type VideoCodec = "h264" | "hevc" | "prores";
export type DynamicRange = "sdr" | "pq" | "hlg";

export interface VideoColour {
  /** False when the file said nothing (no `colr`, no Dolby Vision box) and the values are the defaults for its size. */
  readonly tagged: boolean;
  /** ITU-T H.273 codes, with "unspecified" (2) already resolved: 1 BT.709, 5/6 BT.601, 9 BT.2020, 11/12 DCI-P3 / Display P3 (primaries). */
  readonly primaries: number;
  /** 1, 6, 14, 15 (the BT.709 curve and its siblings), 13 (sRGB), 16 (PQ), 18 (HLG). */
  readonly transfer: number;
  /** 1 BT.709, 5/6 BT.601, 9 BT.2020 (non-constant luminance). */
  readonly matrix: number;
  readonly fullRange: boolean;
}

export interface VideoTrackInfo {
  readonly codec: VideoCodec;
  readonly fourcc: string;
  /** The coded picture, in pixels (the sample entry's; the tkhd says the same). */
  readonly width: number;
  readonly height: number;
  /** Degrees CLOCKWISE that the stored picture must be turned to show it upright. */
  readonly rotation: 0 | 90 | 180 | 270;
  readonly dynamicRange: DynamicRange;
  readonly colour: VideoColour;
  /** The Dolby Vision base layer the file declares (profile 8 only), or null. */
  readonly dolbyVision: { readonly profile: number; readonly compatibilityId: number } | null;
  readonly samples: number;
  readonly timescale: number;
  /** The sum of the `stts` runs, in `timescale` ticks: the length of the SAMPLES. */
  readonly durationTicks: number;
  /**
   * The track's edit list, when it has one: ffmpeg honours it, so the picture is the part of the samples it names. Only one media segment
   * (optionally after one empty edit, a delay) is taken. `mediaTime` is where in the samples it starts (the track's timescale), `durationTicks`
   * how long it runs (the MOVIE's timescale, `mvhd`'s). A clip trimmed without re-encoding has one: its samples start at the keyframe before the
   * cut and the edit cuts into them; x264 and x265 write one to make up for the delay B-frames cause.
   */
  readonly edit: { readonly mediaTime: number; readonly durationTicks: number } | null;
  /** How long the picture is: the edit's length when there is an edit, else the samples'. Exact (ticks of its own timescale), never rounded. */
  readonly presentation: { readonly ticks: number; readonly timescale: number };
  /** Samples per second on average, to three decimals; between 0.001 and 1000. */
  readonly sourceFps: number;
  /** The sample lengths differ by more than rounding (the last sample, which a muxer ends on its own terms, is not counted). */
  readonly variableFrameRate: boolean;
}

export interface VideoInfo {
  readonly brand: string;
  /** The longer of `mvhd`'s and the video track's own length, in milliseconds. */
  readonly durationMs: number;
  readonly mvhd: { readonly duration: number; readonly timescale: number };
  readonly video: VideoTrackInfo;
  readonly audioTracks: number;
}

/**
 * What the walker made of a file. A refusal for `no-video-track` also says how many sound tracks the file has (`audioTracks`, 3f.6: the one drop zone routes an
 * audio-only MP4 to the audio importer); no other refusal has the count, since only this one means the whole file was read.
 */
export type VideoProbe =
  | { readonly ok: true; readonly info: VideoInfo }
  | { readonly ok: false; readonly reason: ProbeRefusal; readonly audioTracks?: number };

/** True when the picture (the edit's length, else the samples') is longer than `seconds`: exact, in ticks, never rounded. */
export function longerThan(info: VideoInfo, seconds: number): boolean {
  return info.video.presentation.ticks > seconds * info.video.presentation.timescale;
}

class Refusal extends Error {
  readonly reason: ProbeRefusal;
  /** For `no-video-track` only: how many sound tracks the walker counted. */
  readonly audioTracks: number | undefined;
  constructor(reason: ProbeRefusal, audioTracks?: number) {
    super(reason);
    this.reason = reason;
    this.audioTracks = audioTracks;
  }
}

interface BoxRef {
  readonly type: string;
  /** Offset of the first payload byte, after the (possibly 64-bit) header. */
  readonly body: number;
  /** One past the last byte. */
  readonly end: number;
}

const CODECS: Readonly<Record<string, VideoCodec>> = {
  avc1: "h264",
  avc3: "h264",
  hvc1: "hevc",
  hev1: "hevc",
  apcn: "prores",
  apch: "prores",
  apcs: "prores",
  apco: "prores",
  ap4h: "prores",
};

/**
 * Sample entries that are certainly NOT pictures: sound, timecode and the timed metadata a phone or an action camera writes. A track whose entry
 * is anything else is a video candidate whatever its `hdlr` says, because ffmpeg decides a track's kind by its entry's four characters, not by
 * its handler. (A name missing here only makes a file with that track refused.)
 */
const NON_VIDEO_ENTRIES: ReadonlySet<string> = new Set([
  "mp4a", "ac-3", "ec-3", "alac", "sowt", "twos", "lpcm", "ipcm", "fpcm", ".mp3", "samr", "sawb", "Opus", "fLaC", "in24", "in32", "fl32", "fl64", "raw ", "ulaw", "alaw",
  "mebx", "tmcd", "text", "tx3g", "c608", "c708", "clcp", "gpmd", "camm", "sbtl", "stpp", "wvtt", "priv", "fdsc", "rtmd", "mett", "metx",
  "djmd", "dbgi", "CTMD", "rtp ", "mp4s",
]);

/** Handler subtypes that name a MEDIA type: a track's kind. Data-reference handlers (`alis`, `url `, `rsrc`) and the like name none, and every ordinary MOV has one in `minf`. */
const MEDIA_HANDLER_TYPES: ReadonlySet<string> = new Set(["vide", "soun", "subp", "clcp", "m1a ", "text", "sbtl", "meta"]);
/** The longest an edit's start (`media_time`) may be into the samples: a legal trim starts within one keyframe interval, and this bounds the pre-roll ffmpeg decodes and throws away. */
const MAX_EDIT_START_SECONDS = 30;

const latin1 = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));

/** The box whose header is in `bytes` at `at` (as the file's offset `offset + at`), checked against `limit` (what the parent holds). */
function boxAt(bytes: Uint8Array, view: DataView, at: number, limit: number, base: number, topLevel: boolean): BoxRef {
  const available = limit - at;
  if (available < 8 || at + 8 > bytes.byteLength) throw new Refusal("bad-box");
  const size32 = view.getUint32(at);
  const type = latin1(bytes, at + 4, at + 8);
  if (size32 === 1) {
    if (available < 16 || at + 16 > bytes.byteLength) throw new Refusal("bad-box");
    const large = view.getBigUint64(at + 8);
    if (large < 16n || large > BigInt(available)) throw new Refusal("bad-box");
    return { type, body: base + at + 16, end: base + at + Number(large) };
  }
  if (size32 === 0) {
    if (!topLevel) throw new Refusal("bad-box");
    return { type, body: base + at + 8, end: base + limit };
  }
  if (size32 < 8 || size32 > available) throw new Refusal("bad-box");
  return { type, body: base + at + 8, end: base + at + size32 };
}

/** What one walk of a `moov` has spent: the boxes visited (all levels together), and the lists already made (a list is made, and paid for, once). */
interface Budget {
  visited: number;
  readonly listed: Map<string, BoxRef[]>;
}

/** The boxes directly inside `[start, end)` of `m`, at most `MAX_CHILDREN`; each one counts against the shared visit budget (once per list). */
function childrenOf(m: Uint8Array, view: DataView, start: number, end: number, budget: Budget): BoxRef[] {
  const key = `${start}:${end}`;
  const cached = budget.listed.get(key);
  if (cached !== undefined) return cached;
  const found: BoxRef[] = [];
  for (let at = start; at < end; ) {
    // QuickTime writers end a list with a 32-bit zero, which is not a box (Apple's writer: the end of a video sample entry, on most of the
    // system's own movies); ffmpeg leaves anything shorter than a header alone. All-zero bytes there are the end of the list; anything else is not.
    if (end - at < 8 && m.subarray(at, end).every((byte) => byte === 0)) break;
    if (found.length >= MAX_CHILDREN || ++budget.visited > MAX_VISITED) throw new Refusal("too-many-boxes");
    const box = boxAt(m, view, at, end, 0, false);
    found.push(box);
    at = box.end;
  }
  budget.listed.set(key, found);
  return found;
}

/**
 * The boxes inside `[start, end)` as ffmpeg's `mov_read_default` reads a list it does not check first: a size of 0, or one past the parent, is the
 * rest of the parent; a size under 8 (or less than a header left, as the zero terminator QuickTime ends a `udta` with) ends the list; what came
 * before the end was read, and acted on. Never throws for the shape of the list, only for its length (the same caps as `childrenOf`).
 */
function lenientChildren(m: Uint8Array, view: DataView, start: number, end: number, budget: Budget): BoxRef[] {
  const found: BoxRef[] = [];
  for (let at = start; end - at >= 8; ) {
    if (found.length >= MAX_CHILDREN || ++budget.visited > MAX_VISITED) throw new Refusal("too-many-boxes");
    const left = end - at;
    const size32 = view.getUint32(at);
    const header = size32 === 1 ? 16 : 8;
    if (left < header) break;
    const declared = size32 === 1 ? view.getBigUint64(at + 8) : BigInt(size32);
    const size = declared === 0n || declared > BigInt(left) ? left : Number(declared);
    if (size < header) break;
    found.push({ type: latin1(m, at + 4, at + 8), body: at + header, end: at + size });
    at += size;
  }
  return found;
}

/** The one box of `type` in a parent; a repeat is refused: the walker would read the first and ffmpeg the last (it keeps overwriting). */
function onlyOf(boxes: readonly BoxRef[], type: string): BoxRef | undefined {
  const found = boxes.filter((box) => box.type === type);
  if (found.length > 1) throw new Refusal("duplicate-box");
  return found[0];
}

const payloadLength = (box: BoxRef): number => box.end - box.body;

/** mvhd and mdhd share a layout: version and flags, then creation and modification times, the timescale and the duration. */
function readTimes(m: Uint8Array, view: DataView, box: BoxRef): { timescale: number; duration: number } {
  const version = m[box.body] ?? 0;
  if (version !== 0 && version !== 1) throw new Refusal("bad-header");
  const need = version === 1 ? 4 + 8 + 8 + 4 + 8 : 4 + 4 + 4 + 4 + 4;
  if (payloadLength(box) < need) throw new Refusal("bad-header");
  let timescale: number;
  let duration: number;
  if (version === 1) {
    timescale = view.getUint32(box.body + 20);
    const big = view.getBigUint64(box.body + 24);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Refusal("bad-header");
    duration = Number(big);
  } else {
    timescale = view.getUint32(box.body + 12);
    duration = view.getUint32(box.body + 16);
  }
  if (timescale === 0) throw new Refusal("bad-header");
  return { timescale, duration };
}

function rotationOf(view: DataView, at: number): 0 | 90 | 180 | 270 {
  const a = view.getInt32(at);
  const b = view.getInt32(at + 4);
  const u = view.getInt32(at + 8);
  const c = view.getInt32(at + 12);
  const d = view.getInt32(at + 16);
  const v = view.getInt32(at + 20);
  const w = view.getInt32(at + 32);
  // x and y (the translation) are the player's business and change nothing about which way up the picture is.
  if (u !== 0 || v !== 0 || w !== W_ONE) throw new Refusal("unsupported-matrix");
  if (a === ONE && b === 0 && c === 0 && d === ONE) return 0;
  if (a === 0 && b === ONE && c === -ONE && d === 0) return 90;
  if (a === -ONE && b === 0 && c === 0 && d === -ONE) return 180;
  if (a === 0 && b === -ONE && c === ONE && d === 0) return 270;
  throw new Refusal("unsupported-matrix");
}

/** Width and height of the picture, whole pixels from tkhd's 16.16; null for a fractional size (which no sample entry can match). */
function readTkhd(m: Uint8Array, view: DataView, box: BoxRef): { rotation: 0 | 90 | 180 | 270; width: number | null; height: number | null } {
  const version = m[box.body] ?? 0;
  if (version !== 0 && version !== 1) throw new Refusal("bad-header");
  // Version 0: 4 (version, flags) + 4 + 4 + 4 + 4 + 4 + 8 + 2 + 2 + 2 + 2 = 40 bytes before the matrix; version 1 has three 8-byte times: 52.
  const matrixAt = box.body + (version === 1 ? 52 : 40);
  if (box.end < matrixAt + 36 + 8) throw new Refusal("bad-header");
  const rotation = rotationOf(view, matrixAt);
  const whole = (raw: number): number | null => (raw % ONE === 0 ? raw / ONE : null);
  return { rotation, width: whole(view.getUint32(matrixAt + 36)), height: whole(view.getUint32(matrixAt + 40)) };
}

interface ColrNclx {
  readonly primaries: number;
  readonly transfer: number;
  readonly matrix: number;
  readonly fullRange: boolean;
}

function readColr(m: Uint8Array, view: DataView, boxes: readonly BoxRef[]): ColrNclx | null {
  let found: ColrNclx | null = null;
  for (const box of boxes) {
    if (box.type !== "colr" || payloadLength(box) < 4) continue;
    const type = latin1(m, box.body, box.body + 4);
    // `prof` and `rICC` carry an ICC profile, which this importer does not read; the picture is then judged by its other tags.
    if (type !== "nclx" && type !== "nclc") continue;
    if (payloadLength(box) < (type === "nclx" ? 11 : 10)) throw new Refusal("bad-box");
    if (found !== null) throw new Refusal("unsupported-colour");
    found = {
      primaries: view.getUint16(box.body + 4),
      transfer: view.getUint16(box.body + 6),
      matrix: view.getUint16(box.body + 8),
      fullRange: type === "nclx" && ((m[box.body + 10] ?? 0) & 0x80) !== 0,
    };
  }
  return found;
}

function readDolby(m: Uint8Array, boxes: readonly BoxRef[]): { profile: number; compatibilityId: number; elPresent: boolean } | null {
  const found = boxes.filter((box) => box.type === "dvcC" || box.type === "dvvC");
  if (found.length > 1) throw new Refusal("unsupported-codec");
  const box = found[0];
  if (box === undefined) return null;
  if (payloadLength(box) < 5) throw new Refusal("bad-box");
  // dv_version_major, dv_version_minor, then profile (7 bits), level (6), rpu (1), el (1), bl (1), then the compatibility id (4 bits).
  const high = m[box.body + 2] ?? 0;
  const low = m[box.body + 3] ?? 0;
  return { profile: high >> 1, compatibilityId: (m[box.body + 4] ?? 0) >> 4, elPresent: ((low >> 1) & 1) === 1 };
}

const SDR_TRANSFERS: ReadonlySet<number> = new Set([1, 2, 6, 13, 14, 15]);

/** What the colour tags mean, with the "unspecified" codes settled by the picture's size and the Dolby Vision base layer applied. */
function resolveColour(colr: ColrNclx | null, dolby: { profile: number; compatibilityId: number; elPresent: boolean } | null, width: number, height: number): { colour: VideoColour; range: DynamicRange } {
  const hd = Math.max(width, height) >= 1280;
  let transfer = colr?.transfer ?? 2;
  let primaries = colr?.primaries ?? 2;
  let matrix = colr?.matrix ?? 2;
  if (dolby !== null) {
    // Profile 8 is the one with a base layer a plain decoder shows: 1 is PQ (HDR10), 2 is SDR, 4 is HLG. The file's colr must say the same.
    const base = dolby.compatibilityId === 1 ? 16 : dolby.compatibilityId === 2 ? 1 : dolby.compatibilityId === 4 ? 18 : null;
    if (dolby.profile !== 8 || dolby.elPresent || base === null) throw new Refusal("unsupported-codec");
    if (colr !== null && (base === 1 ? !SDR_TRANSFERS.has(colr.transfer) : colr.transfer !== base)) throw new Refusal("unsupported-colour");
    transfer = base;
    if (colr === null) {
      primaries = base === 1 ? 1 : 9;
      matrix = base === 1 ? 1 : 9;
    }
  }
  if (transfer === 2) transfer = 1;
  if (primaries === 2) primaries = hd ? 1 : 6;
  if (matrix === 2) matrix = hd ? 1 : 6;
  if (![1, 5, 6, 9, 11, 12].includes(primaries)) throw new Refusal("unsupported-colour");
  if (![1, 5, 6, 9].includes(matrix)) throw new Refusal("unsupported-colour");
  if (!SDR_TRANSFERS.has(transfer) && transfer !== 16 && transfer !== 18) throw new Refusal("unsupported-colour");
  return {
    colour: { tagged: colr !== null || dolby !== null, primaries, transfer, matrix, fullRange: colr?.fullRange ?? false },
    range: transfer === 16 ? "pq" : transfer === 18 ? "hlg" : "sdr",
  };
}

/**
 * The track's edit list: none, or one media segment after at most one empty edit. Anything else (two segments, a segment at another speed, a
 * segment of no length, an empty edit that is the whole list) is refused, because what ffmpeg would play of it is not what the walker measured.
 */
function readEdit(m: Uint8Array, view: DataView, edts: BoxRef | undefined, timescale: number, budget: Budget): { mediaTime: number; durationTicks: number } | null {
  if (edts === undefined) return null;
  const elst = onlyOf(childrenOf(m, view, edts.body, edts.end, budget), "elst");
  if (elst === undefined) return null;
  const version = m[elst.body] ?? 0;
  if (version !== 0 && version !== 1) throw new Refusal("unsupported-edit");
  if (payloadLength(elst) < 8) throw new Refusal("bad-box");
  const count = view.getUint32(elst.body + 4);
  const size = version === 1 ? 20 : 12;
  if (count > (payloadLength(elst) - 8) / size) throw new Refusal("bad-box");
  if (count === 0) return null;
  if (count > 2) throw new Refusal("unsupported-edit");
  const entries: { duration: number; mediaTime: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = elst.body + 8 + i * size;
    let duration: number;
    let mediaTime: number;
    let rateAt: number;
    if (version === 1) {
      const wide = view.getBigUint64(at);
      const time = view.getBigInt64(at + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER) || time > BigInt(Number.MAX_SAFE_INTEGER) || time < -1n) throw new Refusal("unsupported-edit");
      duration = Number(wide);
      mediaTime = Number(time);
      rateAt = at + 16;
    } else {
      duration = view.getUint32(at);
      mediaTime = view.getInt32(at + 4);
      rateAt = at + 8;
    }
    // Rate 1.0 only: an integer part of 1 and no fraction.
    if (mediaTime >= 0 && (view.getInt16(rateAt) !== 1 || view.getInt16(rateAt + 2) !== 0)) throw new Refusal("unsupported-edit");
    entries.push({ duration, mediaTime });
  }
  const segment = entries[entries.length - 1];
  const delay = entries.length === 2 ? entries[0] : undefined;
  // The last entry is the picture; a first one, when there is one, is a delay (an empty edit, media time -1) and nothing else.
  if (segment === undefined || segment.mediaTime < 0 || segment.duration === 0 || (delay !== undefined && delay.mediaTime !== -1)) throw new Refusal("unsupported-edit");
  if (segment.mediaTime > MAX_EDIT_START_SECONDS * timescale) throw new Refusal("unsupported-edit");
  return { mediaTime: segment.mediaTime, durationTicks: segment.duration };
}

interface SampleTimes {
  readonly samples: number;
  readonly durationTicks: number;
  readonly variableFrameRate: boolean;
}

function readStts(view: DataView, box: BoxRef): SampleTimes {
  if (payloadLength(box) < 8) throw new Refusal("bad-box");
  const entries = view.getUint32(box.body + 4);
  // The table must be in the box: a count that is larger than what the box holds is a lie, and is never iterated.
  if (entries > (payloadLength(box) - 8) / 8) throw new Refusal("bad-box");
  let samples = 0;
  let durationTicks = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  // The last sample's length is the muxer's choice (often what is left to the end of the track), so it is left out of the spread: each run is
  // folded into the spread when the NEXT one arrives, and the last one, one sample short, after the loop. No array, no spread: a 16 MiB moov
  // holds two million runs, and `Math.min(...runs)` throws long before that.
  let pendingCount = 0;
  let pendingDelta = 0;
  const fold = (count: number, delta: number): void => {
    if (count <= 0) return;
    if (delta < min) min = delta;
    if (delta > max) max = delta;
  };
  for (let i = 0; i < entries; i++) {
    const count = view.getUint32(box.body + 8 + i * 8);
    const delta = view.getUint32(box.body + 12 + i * 8);
    if (count === 0) continue;
    const ticks = count * delta;
    samples += count;
    durationTicks += ticks;
    if (!Number.isSafeInteger(ticks) || !Number.isSafeInteger(durationTicks) || !Number.isSafeInteger(samples)) throw new Refusal("bad-header");
    fold(pendingCount, pendingDelta);
    pendingCount = count;
    pendingDelta = delta;
  }
  if (samples === 0 || durationTicks === 0) throw new Refusal("bad-header");
  fold(pendingCount - 1, pendingDelta);
  // Rounding a 30 fps clip to milliseconds gives 33 and 34: a spread of a tick, or a tenth of the shortest, is not a variable rate.
  return { samples, durationTicks, variableFrameRate: Number.isFinite(min) && max > min && max - min > Math.max(1, min * 0.1) };
}

/**
 * The boxes whose children ffmpeg's mov demuxer reads as a list, wherever they are: in libavformat/mov.c (6.0 and 6.1) `mov_default_parse_table` maps each of these to
 * `mov_read_default` (`wave` to `mov_read_wave`, which descends the same way), and the table is LEVEL-INDEPENDENT, so a box in it is read inside a `trak`, inside `moov`, or
 * at the top of the file alike. `meta` is read from its own `hdlr` (`mov_read_meta`) and is scanned on its own terms (`metaChildren`). The list is the containers of that table
 * that matter to a stream (the ones a track's parts, a handler or a whole `trak` can hide in); the table is long and a box this list lacks is the SECOND layer's business
 * (`videoStreams.ts` asks ffmpeg itself how many video streams there are), not a reason to trust the walker's count.
 * MEASURED on the bundled ffmpeg (a real-ffmpeg test each, `videoProbe.hiding.ffmpeg.test.ts`): `mdia minf stbl dinf edts tref udta sinf schi wave traf mvex` and `meta`. NOT measured:
 * `moof`, `iprp` and `ipco`, which were added DEFENSIVELY from the table (no probe made ffmpeg read a track part in them); the second layer covers them whatever they do, and none
 * of the 293 system videos on a Mac holds one in a track.
 */
const TRAK_CONTAINERS: ReadonlySet<string> = new Set(["mdia", "minf", "stbl", "dinf", "edts", "tref", "udta", "sinf", "schi", "wave", "traf", "mvex", "moof", "iprp", "ipco"]);
/** The lists the walker reads strictly anyway (a malformed box refuses the file); the rest of a track is read the lenient way ffmpeg reads it. */
const STRICT_PATHS: ReadonlySet<string> = new Set(["trak", "trak/mdia", "trak/mdia/minf", "trak/mdia/minf/stbl", "trak/mdia/minf/dinf", "trak/edts"]);
/** Where each box that makes a track's stream may be: the one list the walker reads it from. A copy anywhere else in a `trak` is refused (`hidden-track-box`). */
const STREAM_PART_HOMES: Readonly<Record<string, string | undefined>> = {
  mdhd: "trak/mdia",
  minf: "trak/mdia",
  stbl: "trak/mdia/minf",
  stsd: "trak/mdia/minf/stbl",
};
/** ffmpeg stops at 10 levels of nesting; deeper than this is refused rather than followed. */
const MAX_TRAK_DEPTH = 16;
/** The subtypes of a data handler (`dhlr`'s alias, URL and resource references). */
const DATA_HANDLER_SUBTYPES: ReadonlySet<string> = new Set(["alis", "url ", "rsrc"]);

/**
 * What ffmpeg's `mov_read_meta` reads of a `meta` box: it looks for an `hdlr` tag on a 4-byte step from the start of the payload (while more than 8
 * bytes are left), steps back to that box's size field, and reads the rest of the box as a list from there. Nothing before the tag is read, and
 * with no tag nothing is. Null when it reads nothing.
 */
function metaChildren(m: Uint8Array, view: DataView, box: BoxRef, budget: Budget): BoxRef[] | null {
  for (let k = 0; payloadLength(box) - k > 8; k += 4) {
    const at = box.body + k;
    if (m[at] === 0x68 && m[at + 1] === 0x64 && m[at + 2] === 0x6c && m[at + 3] === 0x72) return lenientChildren(m, view, at - 4, box.end, budget);
  }
  return null;
}

/** An `hdlr` whose subtype names a MEDIA type (the one thing a handler can do to a track): a metadata handler (`mdta`, `mdir`) is not one. */
function isMediaHandler(m: Uint8Array, box: BoxRef): boolean {
  return payloadLength(box) >= 12 && MEDIA_HANDLER_TYPES.has(latin1(m, box.body + 8, box.body + 12));
}

/** A data handler, as every ordinary MOV has one in `minf`: a data subtype, or component type `dhlr` over a subtype that is no media type (ffmpeg reads the SUBTYPE). */
function isDataHandler(m: Uint8Array, box: BoxRef): boolean {
  if (payloadLength(box) < 12) return false;
  const subtype = latin1(m, box.body + 8, box.body + 12);
  return DATA_HANDLER_SUBTYPES.has(subtype) || (latin1(m, box.body + 4, box.body + 8) === "dhlr" && !MEDIA_HANDLER_TYPES.has(subtype));
}

/**
 * ffmpeg parses EVERY `hdlr` it finds in a `trak` and the last one wins, so a track is what the walker read of `mdia/hdlr` only if no other `hdlr`
 * of the track says otherwise. One walk of the WHOLE subtree, in the one visit budget, and one rule: the only `hdlr` a track may have is the
 * one in `mdia` (read by the caller, which refuses a second) and a data handler in `minf`. Any other, wherever it hides (the `trak` itself,
 * `stbl`, `dinf`, `edts`, `tref`, `udta`), is refused whatever it says. The exception is a `meta` box: Apple's writers put per-track metadata in
 * `trak/meta` with an `mdta` handler (a lens model, a focal length), which names no media type and changes nothing about the track, so inside a
 * `meta` box (found the way ffmpeg finds its handler, `metaChildren`) only a MEDIA subtype is refused. Measured on ffmpeg 6.x: an `hdlr` in a
 * sample entry or outside every `trak` changes nothing, so neither is walked (a real-ffmpeg test holds the sample entry on every platform).
 */
function checkHandlers(m: Uint8Array, view: DataView, trak: BoxRef, budget: Budget): void {
  const visit = (kids: readonly BoxRef[], path: string, inMeta: boolean, depth: number): void => {
    if (depth > MAX_TRAK_DEPTH) throw new Refusal("too-many-boxes");
    for (const kid of kids) {
      // The parts that make a STREAM (3f.6 review, H1): ffmpeg's parse table does not look at how deep they are, so `minf/stbl/stsd` directly in a `trak` is a stream that no
      // `mdia` and no `hdlr` introduced (the codec of its sample entry says it is a video). Each is where the walker reads it or nowhere.
      // Judged AFTER what is inside it (a handler hidden in such a box is still told as a hidden handler).
      const home = STREAM_PART_HOMES[kid.type];
      // Not exempt inside `meta` either: a `meta` that holds a track's `mdhd` and `minf` (after an `mdta` handler, which names no media) is a stream like any other.
      const stray = home !== undefined && path !== home;
      if (kid.type === "hdlr") {
        const allowed = inMeta ? !isMediaHandler(m, kid) : path === "trak/mdia" || (path === "trak/mdia/minf" && isDataHandler(m, kid));
        if (!allowed) throw new Refusal("hidden-handler");
      } else if (kid.type === "meta") {
        const inside = metaChildren(m, view, kid, budget);
        if (inside !== null) visit(inside, `${path}/meta`, true, depth + 1);
      } else if (TRAK_CONTAINERS.has(kid.type)) {
        const next = `${path}/${kid.type}`;
        const list = !inMeta && STRICT_PATHS.has(next) ? childrenOf(m, view, kid.body, kid.end, budget) : lenientChildren(m, view, kid.body, kid.end, budget);
        visit(list, next, inMeta, depth + 1);
      }
      if (stray) throw new Refusal("hidden-track-box");
    }
  };
  visit(childrenOf(m, view, trak.body, trak.end, budget), "trak", false, 0);
}

/** Every `dref` entry of a track must be the file itself: a reference to another file is a way to make ffmpeg open one. */
function checkDataReferences(m: Uint8Array, view: DataView, inMinf: readonly BoxRef[], budget: Budget): void {
  const dinf = onlyOf(inMinf, "dinf");
  if (dinf === undefined) return;
  const dref = onlyOf(childrenOf(m, view, dinf.body, dinf.end, budget), "dref");
  if (dref === undefined) return;
  if (payloadLength(dref) < 8) throw new Refusal("bad-box");
  for (const entry of childrenOf(m, view, dref.body + 8, dref.end, budget)) {
    // A data entry is a full box: its flags' low bit says the data is in this very file.
    if (payloadLength(entry) < 4 || ((m[entry.body + 3] ?? 0) & 1) === 0) throw new Refusal("external-data-reference");
  }
}

function readVideoTrack(m: Uint8Array, view: DataView, tkhd: BoxRef | undefined, edts: BoxRef | undefined, mdhd: BoxRef | undefined, tables: readonly BoxRef[] | undefined, movieTimescale: number, budget: Budget): VideoTrackInfo {
  if (tkhd === undefined || mdhd === undefined || tables === undefined) throw new Refusal("bad-header");
  const { rotation, width: tkhdWidth, height: tkhdHeight } = readTkhd(m, view, tkhd);
  const { timescale } = readTimes(m, view, mdhd);
  const stsd = onlyOf(tables, "stsd");
  const stts = onlyOf(tables, "stts");
  if (stsd === undefined || stts === undefined) throw new Refusal("bad-header");

  if (payloadLength(stsd) < 8) throw new Refusal("bad-box");
  const entryCount = view.getUint32(stsd.body + 4);
  if (entryCount === 0) throw new Refusal("bad-box");
  if (entryCount !== 1) throw new Refusal("several-sample-entries");
  const entry = boxAt(m, view, stsd.body + 8, stsd.end, 0, false);
  const codec = CODECS[entry.type];
  if (codec === undefined) throw new Refusal("unsupported-codec");
  if (payloadLength(entry) < VISUAL_ENTRY_FIXED_BYTES) throw new Refusal("bad-box");
  const width = view.getUint16(entry.body + 24);
  const height = view.getUint16(entry.body + 26);
  if (width === 0 || height === 0) throw new Refusal("bad-header");
  if (tkhdWidth !== width || tkhdHeight !== height) throw new Refusal("dimension-mismatch");

  const inside = childrenOf(m, view, entry.body + VISUAL_ENTRY_FIXED_BYTES, entry.end, budget);
  const pasp = onlyOf(inside, "pasp");
  if (pasp !== undefined) {
    if (payloadLength(pasp) < 8) throw new Refusal("bad-box");
    const h = view.getUint32(pasp.body);
    const v = view.getUint32(pasp.body + 4);
    if (h === 0 || v === 0 || h !== v) throw new Refusal("non-square-pixels");
  }
  const dolby = readDolby(m, inside);
  if (dolby !== null && codec !== "hevc") throw new Refusal("unsupported-codec");
  const { colour, range } = resolveColour(readColr(m, view, inside), dolby, width, height);

  const times = readStts(view, stts);
  const edit = readEdit(m, view, edts, timescale, budget);
  // ffmpeg counts the samples of a track from its size table, not from `stts`: a file whose two disagree could be 1 s by the one and 3 h by the other.
  const sizes = onlyOf(tables, "stsz");
  const compact = onlyOf(tables, "stz2");
  if (sizes !== undefined && compact !== undefined) throw new Refusal("duplicate-box");
  const sizeTable = sizes ?? compact;
  if (sizeTable === undefined || payloadLength(sizeTable) < 12) throw new Refusal("bad-header");
  if (view.getUint32(sizeTable.body + 8) !== times.samples) throw new Refusal("sample-count-mismatch");
  const sourceFps = Math.round((times.samples * timescale * 1000) / times.durationTicks) / 1000;
  if (sourceFps > MAX_FPS) throw new Refusal("bad-header");
  return {
    codec,
    fourcc: entry.type,
    width,
    height,
    rotation,
    dynamicRange: range,
    colour,
    dolbyVision: dolby === null ? null : { profile: dolby.profile, compatibilityId: dolby.compatibilityId },
    samples: times.samples,
    timescale,
    durationTicks: times.durationTicks,
    edit,
    presentation: edit === null ? { ticks: times.durationTicks, timescale } : { ticks: edit.durationTicks, timescale: movieTimescale },
    sourceFps: Math.max(MIN_FPS, sourceFps),
    variableFrameRate: times.variableFrameRate,
  };
}

async function readExactly(source: ByteSource, position: number, length: number): Promise<Uint8Array> {
  if (position + length > source.size) throw new Refusal("bad-box");
  const got = await source.read(position, length);
  if (got.byteLength < length) throw new Refusal("bad-box");
  return got.byteLength === length ? got : got.subarray(0, length);
}

interface Movie {
  readonly brand: string;
  readonly m: Uint8Array;
  readonly view: DataView;
  readonly budget: Budget;
  readonly top: readonly BoxRef[];
  readonly traks: readonly BoxRef[];
}

/**
 * The file's boxes down to its tracks: the top level (one `moov`, no `trak` outside it), `moov` read whole (bounded) and its children listed. A FRAGMENTED file (`moof`,
 * `sidx`, `mfra` at the top, `mvex` in `moov`) is refused unless `allowFragments`, which only the light look at the tracks (`soundAndPictureTracks`) says.
 */
async function openMovie(source: ByteSource, allowFragments: boolean): Promise<Movie> {
  if (source.size < 8) throw new Refusal("no-ftyp");
  let moov: BoxRef | undefined;
  let brand = "";
  let boxes = 0;
  for (let at = 0; at < source.size; ) {
    if (++boxes > (allowFragments ? MAX_TOP_LEVEL_BOXES_LIGHT : MAX_TOP_LEVEL_BOXES)) throw new Refusal("too-many-boxes");
    const remaining = source.size - at;
    if (remaining < 8) throw new Refusal("bad-box");
    const header = await readExactly(source, at, Math.min(HEADER_BYTES, remaining));
    // `boxAt` is given the header alone: `limit` is what is left of the file, the offsets are the file's.
    const box = boxAt(header, new DataView(header.buffer, header.byteOffset, header.byteLength), 0, remaining, at, true);
    if (at === 0 && box.type !== "ftyp") throw new Refusal("no-ftyp");
    if (!allowFragments && (box.type === "moof" || box.type === "sidx" || box.type === "mfra")) throw new Refusal("fragmented");
    // ffmpeg reads a `trak` wherever it finds one, so a track outside `moov` is a stream the walker would never judge.
    if (box.type === "trak") throw new Refusal("stray-track");
    if (box.type === "ftyp") {
      if (box.end - box.body < 8 || box.end - box.body > 4096) throw new Refusal("bad-box");
      const ftyp = await readExactly(source, box.body, 4);
      brand = latin1(ftyp, 0, 4);
    }
    if (box.type === "moov") {
      if (moov !== undefined) throw new Refusal("several-moov");
      if (box.end - box.body > MOOV_MAX_BYTES) throw new Refusal("moov-too-large");
      moov = box;
    }
    at = box.end;
  }
  if (moov === undefined) throw new Refusal("no-moov");

  const m = await readExactly(source, moov.body, moov.end - moov.body);
  const view = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const budget: Budget = { visited: 0, listed: new Map() };
  const top = childrenOf(m, view, 0, m.byteLength, budget);
  if (!allowFragments && top.some((box) => box.type === "mvex")) throw new Refusal("fragmented");
  const traks = top.filter((box) => box.type === "trak");
  if (traks.length > MAX_TRACKS) throw new Refusal("too-many-tracks");
  return { brand, m, view, budget, top, traks };
}

/** What the walker reads of a track before it knows what it is: every refusal that does not depend on the kind (hidden handlers, stray stream parts, outside data). */
interface TrackParts {
  readonly parts: readonly BoxRef[];
  readonly inMdia: readonly BoxRef[];
  readonly handler: string;
  readonly tables: readonly BoxRef[] | undefined;
  readonly entryType: string | undefined;
}

/** The parts of one `trak`, or undefined for one with no `mdia` (which makes no stream: `checkHandlers` has refused any stream part it hides elsewhere). */
function readTrackParts(movie: Movie, trak: BoxRef): TrackParts | undefined {
  const { m, view, budget } = movie;
  const parts = childrenOf(m, view, trak.body, trak.end, budget);
  checkHandlers(m, view, trak, budget);
  const mdia = onlyOf(parts, "mdia");
  if (mdia === undefined) return undefined;
  const inMdia = childrenOf(m, view, mdia.body, mdia.end, budget);
  const hdlr = onlyOf(inMdia, "hdlr");
  const minf = onlyOf(inMdia, "minf");
  const handler = hdlr !== undefined && payloadLength(hdlr) >= 12 ? latin1(m, hdlr.body + 8, hdlr.body + 12) : "";
  const inMinf = minf === undefined ? [] : childrenOf(m, view, minf.body, minf.end, budget);
  // `checkHandlers` took the data handler of `minf`; a second one is a repeat (ffmpeg would read the last).
  onlyOf(inMinf, "hdlr");
  checkDataReferences(m, view, inMinf, budget);
  const stbl = onlyOf(inMinf, "stbl");
  const tables = stbl === undefined ? undefined : childrenOf(m, view, stbl.body, stbl.end, budget);
  const stsd = tables === undefined ? undefined : onlyOf(tables, "stsd");
  const entryType = stsd !== undefined && payloadLength(stsd) >= 16 ? latin1(m, stsd.body + 12, stsd.body + 16) : undefined;
  return { parts, inMdia, handler, tables, entryType };
}

/**
 * What a track is: a SOUND track whatever its codec is called (ffmpeg never makes a video stream of a `soun` track: the video tag lookup is skipped once the handler has said
 * audio, and no decoder but the pinned one is opened; the track has no other `hdlr` but a data handler, so a sound handler cannot hide another); a PICTURE (a video candidate) by
 * its handler OR by its sample entry (see NON_VIDEO_ENTRIES); anything else (timecode, metadata, text) `other`.
 */
function trackKind(handler: string, entryType: string | undefined): "sound" | "picture" | "other" {
  if (handler === "soun") return "sound";
  if (handler !== "vide" && (entryType === undefined || NON_VIDEO_ENTRIES.has(entryType))) return "other";
  return "picture";
}

async function walk(source: ByteSource): Promise<VideoInfo> {
  const movie = await openMovie(source, false);
  const { m, view, budget, top, traks, brand } = movie;
  const mvhd = onlyOf(top, "mvhd");
  if (mvhd === undefined) throw new Refusal("bad-header");
  const movieTimes = readTimes(m, view, mvhd);

  let video: VideoTrackInfo | undefined;
  let audioTracks = 0;
  for (const trak of traks) {
    const read = readTrackParts(movie, trak);
    if (read === undefined) continue;
    const { parts, inMdia, handler, tables, entryType } = read;
    const kind = trackKind(handler, entryType);
    if (kind === "sound") audioTracks++;
    if (kind !== "picture") continue;
    // ONE video track only. ffmpeg silently drops a track it cannot use (no samples, a broken table), so with two the stream it maps as the
    // first video could be the one this walker never judged.
    if (video !== undefined) throw new Refusal("several-video-tracks");
    video = readVideoTrack(m, view, onlyOf(parts, "tkhd"), onlyOf(parts, "edts"), onlyOf(inMdia, "mdhd"), tables, movieTimes.timescale, budget);
  }
  if (video === undefined) throw new Refusal("no-video-track", audioTracks);

  return { brand, durationMs: Math.round((video.presentation.ticks * 1000) / video.presentation.timescale), mvhd: movieTimes, video, audioTracks };
}

/**
 * How many SOUND tracks and how many PICTURE tracks (video candidates) a file has, read in a light bounded pass that also takes a FRAGMENTED file (an empty `moov` and `moof`
 * boxes: what Safari's MediaRecorder writes) and judges no length, size or colour: for the one drop zone to send a file with sound and no picture to the audio importer
 * (3f.6 review, M1). It keeps every refusal that does not depend on the kind (hidden handlers, stray stream parts, outside data, too many boxes), and null says the file is
 * not one it can vouch for. Rejects only when `source.read` does.
 */
export async function soundAndPictureTracks(source: ByteSource): Promise<{ readonly sound: number; readonly picture: number } | null> {
  try {
    const movie = await openMovie(source, true);
    let sound = 0;
    let picture = 0;
    for (const trak of movie.traks) {
      const read = readTrackParts(movie, trak);
      if (read === undefined) continue;
      const kind = trackKind(read.handler, read.entryType);
      if (kind === "sound") sound++;
      if (kind === "picture") picture++;
    }
    return { sound, picture };
  } catch (error) {
    if (error instanceof Refusal || error instanceof RangeError) return null;
    throw error;
  }
}

/** Reads the facts of an MP4 or MOV, or says why it is not one this importer takes. Rejects only when `source.read` does. */
export async function probeVideo(source: ByteSource): Promise<VideoProbe> {
  try {
    return { ok: true, info: await walk(source) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason, ...(error.audioTracks === undefined ? {} : { audioTracks: error.audioTracks }) };
    // A read past the end of a buffer the checks above should have prevented is still a malformed file, not a crash.
    if (error instanceof RangeError) return { ok: false, reason: "bad-box" };
    throw error;
  }
}
