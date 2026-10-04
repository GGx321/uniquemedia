import { box, concat, fullBox, largeBox, u16, u32 } from "../../../music/testing/m4aBuilder";

/**
 * Test-only: builds the smallest MP4 or MOV the video probe reads (`ftyp`, `moov` with tracks down to `stts`, `mdat`), with every field
 * a test may want to break. The samples are not real, so nothing decodes it: a test that needs a picture uses the committed fixtures,
 * and one that needs a hostile or malformed container builds it here. Production code never imports this file.
 */

export { box, concat, fullBox, largeBox, u16, u32 };

/** `concat` for a long list (a rest parameter holds a few hundred thousand arguments at most). */
function concatList(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

const ascii = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const u8 = (...values: number[]): Uint8Array => Uint8Array.from(values);
const word = (value: number): Uint8Array => u32(value >>> 0);

/** A 16.16 fixed-point number. */
const fixed = (value: number): number => Math.round(value * 65536);

export interface ColrSpec {
  /** `nclx` (MP4, with the full-range bit) or `nclc` (QuickTime, without). */
  type: "nclx" | "nclc";
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange?: boolean;
}

export interface DolbySpec {
  /** The box that carries it: `dvcC` for a profile up to 7, `dvvC` above; a reader takes either. */
  box?: "dvcC" | "dvvC";
  profile: number;
  compatibilityId: number;
  elPresent?: boolean;
}

export interface VideoEntrySpec {
  fourcc: string;
  width: number;
  height: number;
  colr?: ColrSpec | readonly ColrSpec[];
  dolby?: DolbySpec | readonly DolbySpec[];
  /** `pasp`: pixel aspect ratio (h, v). */
  pasp?: readonly [number, number];
  /** Boxes appended inside the sample entry after the ones above. */
  extra?: readonly Uint8Array[];
}

/** The display matrices as QuickTime and ISO write them: a, b, c, d in whole numbers (written as 16.16). */
export const MATRIX = {
  r0: [1, 0, 0, 1],
  r90: [0, 1, -1, 0],
  r180: [-1, 0, 0, -1],
  r270: [0, -1, 1, 0],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export interface TrackSpec {
  handler: "vide" | "soun" | "meta" | (string & {});
  /** The sample entry of a video track (a default 1080p `avc1` when absent). */
  entry?: VideoEntrySpec;
  /** `tkhd` width and height in whole pixels (written as 16.16); default: the entry's. */
  tkhdWidth?: number;
  tkhdHeight?: number;
  /** a, b, c, d of the display matrix. Default: no rotation. */
  matrix?: readonly [number, number, number, number];
  /** The whole nine-number matrix as raw 32-bit words, overriding `matrix`. */
  rawMatrix?: readonly number[];
  mdhdTimescale?: number;
  /** `stts` runs `[count, delta]`; default: 30 samples of 1000 ticks. */
  stts?: readonly (readonly [number, number])[];
  /** Override the `stts` box's own entry count (a lie). */
  sttsDeclaredCount?: number;
  /** `dref` entry flags; 1 is self-contained (default one such entry). */
  drefFlags?: readonly number[];
  /** Number of sample entries in `stsd` (the entry repeated). */
  entries?: number;
  /** Write `tkhd` and `mdhd` in their 64-bit form. */
  version1?: boolean;
  noStts?: boolean;
  /** `stsz`'s own sample count (default: what `stts` sums to), or leave `stsz` out. */
  stszCount?: number;
  noStsz?: boolean;
  /** Write the compact `stz2` (16-bit sizes) instead of `stsz`. */
  stz2?: boolean;
  /** Write a compact `stz2` as well as the `stsz`. */
  alsoStz2?: boolean;
  /** Which kind of sample entry to write, whatever the handler says (default: a video entry for `vide`, an audio one otherwise). */
  sampleEntry?: "video" | "audio";
  /** Repeat one box of the track inside its parent. */
  duplicate?: "hdlr" | "stts" | "stsd" | "stsz" | "tkhd";
  noTkhd?: boolean;
  /** Extra boxes at the end of `trak`. */
  trakExtra?: readonly Uint8Array[];
}

export interface Mp4Spec {
  brand?: string;
  tracks?: readonly TrackSpec[];
  mvhdTimescale?: number;
  /** `mvhd` duration in its own timescale; default 30 s at 1000. */
  mvhdDuration?: number;
  mvhdVersion1?: boolean;
  /** Where `moov` is (default: before `mdat`). */
  layout?: "moov-first" | "moov-last" | "no-moov" | "two-moov";
  mdat?: Uint8Array;
  moovExtra?: readonly Uint8Array[];
  topExtra?: readonly Uint8Array[];
  noFtyp?: boolean;
}

export function colrBox(spec: ColrSpec): Uint8Array {
  return box("colr", concat(ascii(spec.type), u16(spec.primaries), u16(spec.transfer), u16(spec.matrix), ...(spec.type === "nclx" ? [u8(spec.fullRange === true ? 0x80 : 0)] : [])));
}

export function dolbyBox(spec: DolbySpec): Uint8Array {
  // Version 1.0, then profile (7 bits), level (6), rpu (1), el (1), bl (1), then the compatibility id in the high nibble.
  const level = 10;
  const profileLevel = (spec.profile << 9) | (level << 3) | (1 << 2) | ((spec.elPresent === true ? 1 : 0) << 1) | 1;
  return box(spec.box ?? "dvvC", concat(u8(1, 0), u16(profileLevel), u8(spec.compatibilityId << 4), new Uint8Array(19)));
}

function isList<T>(value: T | readonly T[]): value is readonly T[] {
  return Array.isArray(value);
}

function many<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return isList(value) ? value : [value];
}

function videoEntry(spec: VideoEntrySpec): Uint8Array {
  return box(
    spec.fourcc,
    concat(
      new Uint8Array(6),
      u16(1),
      new Uint8Array(16),
      u16(spec.width),
      u16(spec.height),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      new Uint8Array(32),
      u16(0x18),
      u16(0xffff),
      ...many(spec.colr).map(colrBox),
      ...many(spec.dolby).map(dolbyBox),
      ...(spec.pasp === undefined ? [] : [box("pasp", concat(u32(spec.pasp[0]), u32(spec.pasp[1])))]),
      ...(spec.extra ?? []),
    ),
  );
}

const audioEntry = (): Uint8Array => box("mp4a", concat(new Uint8Array(6), u16(1), new Uint8Array(8), u16(2), u16(16), u16(0), u16(0), u32(44100 * 65536)));

export const SDR_ENTRY: VideoEntrySpec = { fourcc: "avc1", width: 1920, height: 1080 };

export function trackBox(spec: TrackSpec): Uint8Array {
  const entry = spec.entry ?? SDR_ENTRY;
  const stts = spec.stts ?? [[30, 1000]];
  const v1 = spec.version1 === true;
  const [a = 0, b = 0, c = 0, d = 0] = (spec.matrix ?? MATRIX.r0).map(fixed);
  const words = spec.rawMatrix ?? [a, b, 0, c, d, 0, 0, 0, 0x40000000];
  const tkhdTail = concat(...words.map(word), u32(fixed(spec.tkhdWidth ?? entry.width)), u32(fixed(spec.tkhdHeight ?? entry.height)));
  const tkhd = v1
    ? fullBox("tkhd", 3, concat(new Uint8Array(8), new Uint8Array(8), u32(1), u32(0), new Uint8Array(8), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), tkhdTail), 1)
    : fullBox("tkhd", 3, concat(u32(0), u32(0), u32(1), u32(0), u32(0), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), tkhdTail));
  const timescale = spec.mdhdTimescale ?? 1000;
  const mdhd = v1
    ? fullBox("mdhd", 0, concat(new Uint8Array(8), new Uint8Array(8), u32(timescale), new Uint8Array(8), u16(0x55c4), u16(0)), 1)
    : fullBox("mdhd", 0, concat(u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0)));
  const hdlr = fullBox("hdlr", 0, concat(u32(0), ascii(spec.handler.padEnd(4, " ").slice(0, 4)), new Uint8Array(12), u8(0)));
  const drefFlags = spec.drefFlags ?? [1];
  const dref = fullBox("dref", 0, concat(u32(drefFlags.length), ...drefFlags.map((flags) => fullBox("url ", flags))));
  const sampleEntry = (spec.sampleEntry ?? (spec.handler === "vide" ? "video" : "audio")) === "video" ? videoEntry(entry) : audioEntry();
  const twice = (type: string, one: Uint8Array): Uint8Array => (spec.duplicate === type ? concat(one, one) : one);
  const stsd0 = fullBox("stsd", 0, concat(u32(spec.entries ?? 1), ...Array.from({ length: spec.entries ?? 1 }, () => sampleEntry)));
  const stsd = twice("stsd", stsd0);
  const sttsBox = twice("stts", fullBox("stts", 0, concat(u32(spec.sttsDeclaredCount ?? stts.length), concatList(stts.map(([count, delta]) => concat(u32(count), u32(delta)))))));
  const samples = stts.reduce((sum, [count]) => sum + count, 0);
  const count = spec.stszCount ?? samples;
  const stszBox = twice("stsz", spec.stz2 === true ? fullBox("stz2", 0, concat(u8(0, 0, 0, 16), u32(count))) : fullBox("stsz", 0, concat(u32(0), u32(count))));
  const stbl = box("stbl", concat(stsd, ...(spec.noStts === true ? [] : [sttsBox]), ...(spec.noStsz === true ? [] : [stszBox]), ...(spec.alsoStz2 === true ? [fullBox("stz2", 0, concat(u8(0, 0, 0, 16), u32(count)))] : [])));
  const mdia = box("mdia", concat(mdhd, twice("hdlr", hdlr), box("minf", concat(box("dinf", dref), stbl))));
  return box("trak", concat(...(spec.noTkhd === true ? [] : [twice("tkhd", tkhd)]), mdia, ...(spec.trakExtra ?? [])));
}

export function moovBox(spec: Mp4Spec): Uint8Array {
  const timescale = spec.mvhdTimescale ?? 1000;
  const duration = spec.mvhdDuration ?? 30_000;
  const tail = concat(u32(0x00010000), u16(0x0100), u16(0), new Uint8Array(8), new Uint8Array(36), new Uint8Array(24), u32(2));
  const mvhd =
    spec.mvhdVersion1 === true
      ? fullBox("mvhd", 0, concat(new Uint8Array(8), new Uint8Array(8), u32(timescale), u32(Math.floor(duration / 2 ** 32)), u32(duration >>> 0), tail), 1)
      : fullBox("mvhd", 0, concat(u32(0), u32(0), u32(timescale), u32(duration), tail));
  return box("moov", concat(mvhd, ...(spec.tracks ?? [{ handler: "vide" }]).map(trackBox), ...(spec.moovExtra ?? [])));
}

export function buildMp4(spec: Mp4Spec = {}): Uint8Array {
  const brand = spec.brand ?? "isom";
  const ftyp = spec.noFtyp === true ? new Uint8Array(0) : box("ftyp", concat(ascii(brand), u32(512), ascii(brand), ascii("iso2")));
  const mdat = box("mdat", spec.mdat ?? new Uint8Array(16));
  const moov = moovBox(spec);
  const tail = spec.topExtra ?? [];
  switch (spec.layout ?? "moov-first") {
    case "moov-first":
      return concat(ftyp, moov, mdat, ...tail);
    case "moov-last":
      return concat(ftyp, mdat, moov, ...tail);
    case "two-moov":
      return concat(ftyp, moov, mdat, moov, ...tail);
    case "no-moov":
      return concat(ftyp, mdat, ...tail);
  }
}
