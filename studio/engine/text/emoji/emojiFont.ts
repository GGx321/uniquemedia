/**
 * Reads the per-emoji PNG bitmaps out of a CBDT colour bitmap font (Noto Color Emoji), because resvg 2.6.2 draws no
 * variant of it. Pure: bytes in, answers out, no dependency on the rest of the text runtime.
 *
 * - `cmap` format 12 gives a code point its glyph.
 * - A GSUB ligature pass (lookup type 4, or type 7 wrapping it) turns a ZWJ sequence, a skin tone, a flag, a
 *   keycap or a tag sequence into its one glyph. The lookups run in lookup order, not by script and feature:
 *   the property test over the whole emoji-test.txt, checked against HarfBuzz's glyph ids, is what earns that
 *   shortcut for this font.
 * - `CBLC` index formats 1 and 3 with `CBDT` image format 17 (small metrics + PNG) give the bitmap.
 *
 * Contextual lookups (GSUB types 5 and 6) and single or multiple substitutions are skipped, so this reader is
 * STRICTER than HarfBuzz: it may refuse a sequence HarfBuzz would draw, and no sequence tried (every emoji-test.txt
 * entry and ~14 000 damaged ones in the property tests, ~23 000 more in review) is drawn here but not by HarfBuzz. One deliberate agreement: a
 * black flag followed by the tag terminator alone shapes to glyph 1481 in both, and is accepted.
 *
 * It parses the bundled, sha256-pinned font, never user bytes, but it never trusts a byte either. Everything is
 * read and validated ONCE, in `openEmojiFont`, through a reader that checks every offset against its table, and
 * every count is capped, so a truncated or mutated file throws an `EmojiFontError` there, never a `RangeError`
 * and never a long loop. After that, `has`, `glyphId` and `bitmap` touch only validated structures and cannot throw.
 */

export type EmojiFontErrorCode =
  /** Not a TrueType-flavoured sfnt. */
  | "NOT_A_FONT"
  /** A table or a record runs past the end of its container. */
  | "TRUNCATED"
  /** A value is out of range or contradicts another (unsorted, overlapping, glyph id past `maxp`, PNG that disagrees). */
  | "BAD_TABLE"
  /** A count exceeds this reader's cap. */
  | "TOO_LARGE"
  /** A valid font using something this reader does not read (another index or image format). */
  | "UNSUPPORTED";

export class EmojiFontError extends Error {
  readonly code: EmojiFontErrorCode;
  constructor(code: EmojiFontErrorCode, why: string) {
    super(`emoji font: ${why}`);
    this.name = "EmojiFontError";
    this.code = code;
  }
}

export interface EmojiBitmap {
  /** A PNG file, a copy the caller may keep or change. */
  png: Uint8Array;
  /** Pixels, equal to the PNG's own size. */
  width: number;
  height: number;
  /** Pixels from the pen to the left edge (`bearingX`) and from the baseline up to the top edge (`bearingY`), at the strike's ppem. */
  bearingX: number;
  bearingY: number;
  /** Pixels the pen moves after the emoji, at the strike's ppem. */
  advance: number;
}

export interface EmojiFont {
  /** Pixels per em of the strike the bitmaps are drawn for. */
  readonly ppem: number;
  /** The strike's horizontal line metrics in pixels: `ascender` up (positive), `descender` down (negative). */
  readonly ascender: number;
  readonly descender: number;
  /** How many glyphs carry a bitmap. */
  readonly bitmapCount: number;
  /** The one glyph the sequence shapes to, or null when the font has no single glyph with a bitmap for it. */
  glyphId(sequence: string | readonly number[]): number | null;
  /** Whether the font draws the sequence as exactly one bitmap. It says nothing about whether it is an emoji. */
  has(sequence: string | readonly number[]): boolean;
  /** The bitmap for the sequence, or null when `has` would say false. */
  bitmap(sequence: string | readonly number[]): EmojiBitmap | null;
}

/** The longest RGI emoji sequence is 10 code points (a kiss with two skin tones); a subdivision flag is 7. */
const MAX_SEQUENCE = 32;
const MAX_TABLES = 64;
const MAX_STRIKES = 32;
const MAX_INDEX_SUBTABLES = 4096;
const MAX_CMAP_GROUPS = 100_000;
const MAX_LOOKUPS = 512;
const MAX_LOOKUP_SUBTABLES = 256;
const MAX_LIGATURES = 100_000;
/** Coverage entries read plus ligature sets read, over the whole GSUB: what the real font needs is a few thousand. */
const MAX_GSUB_WORK = 1_000_000;
const VS16 = 0xfe0f;
/** "IHDR" as a big-endian u32. */
const IHDR_TAG = 0x49484452;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A window on the file whose every read is checked against the window, so no read can leave its table. */
class Region {
  constructor(
    private readonly view: DataView,
    readonly name: string,
    readonly start: number,
    readonly length: number,
  ) {}

  private check(at: number, size: number): number {
    if (!Number.isInteger(at) || at < 0 || at + size > this.length) throw new EmojiFontError("TRUNCATED", `${this.name}: a read at ${at} (${size} bytes) runs past the ${this.length}-byte table`);
    return this.start + at;
  }

  u8(at: number): number {
    return this.view.getUint8(this.check(at, 1));
  }
  i8(at: number): number {
    return this.view.getInt8(this.check(at, 1));
  }
  u16(at: number): number {
    return this.view.getUint16(this.check(at, 2));
  }
  u32(at: number): number {
    return this.view.getUint32(this.check(at, 4));
  }
  /** Whether `size` bytes at `at` lie inside this table. */
  fits(at: number, size: number): boolean {
    return Number.isInteger(at) && at >= 0 && at + size <= this.length;
  }
}

function bad(name: string, why: string): EmojiFontError {
  return new EmojiFontError("BAD_TABLE", `${name}: ${why}`);
}

interface Directory {
  view: DataView;
  table(tag: string): Region;
}

function readDirectory(bytes: Uint8Array): Directory {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12) throw new EmojiFontError("NOT_A_FONT", "too short to be a font");
  if (view.getUint32(0) !== 0x00010000) throw new EmojiFontError("NOT_A_FONT", "not a TrueType-flavoured sfnt");
  const count = view.getUint16(4);
  if (count > MAX_TABLES) throw new EmojiFontError("TOO_LARGE", `${count} tables`);
  if (12 + 16 * count > view.byteLength) throw new EmojiFontError("TRUNCATED", "the table directory runs past the end of the file");
  const tables = new Map<string, Region>();
  for (let i = 0; i < count; i++) {
    const record = 12 + 16 * i;
    const tag = String.fromCharCode(view.getUint8(record), view.getUint8(record + 1), view.getUint8(record + 2), view.getUint8(record + 3));
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > view.byteLength) throw new EmojiFontError("TRUNCATED", `the ${tag} table runs past the end of the file`);
    if (!tables.has(tag)) tables.set(tag, new Region(view, tag, offset, length));
  }
  return {
    view,
    table(tag) {
      const region = tables.get(tag);
      if (region === undefined) throw new EmojiFontError("NOT_A_FONT", `no ${tag} table`);
      return region;
    },
  };
}

/** A checked lookup from code point to glyph id (0 = none). */
type GlyphLookup = (codePoint: number) => number;

/** cmap format 12: sorted, disjoint groups of (start, end, first glyph), copied out and validated. */
function readCmap(cmap: Region, numGlyphs: number): GlyphLookup {
  const records = cmap.u16(2);
  let subtable = -1;
  for (let i = 0; i < records; i++) {
    const platform = cmap.u16(4 + 8 * i);
    const encoding = cmap.u16(6 + 8 * i);
    const offset = cmap.u32(8 + 8 * i);
    if (!((platform === 3 && encoding === 10) || (platform === 0 && encoding === 4))) continue;
    if (cmap.u16(offset) !== 12) continue;
    subtable = offset;
    break;
  }
  if (subtable < 0) throw new EmojiFontError("UNSUPPORTED", "cmap: no format 12 subtable for full Unicode");
  const groups = cmap.u32(subtable + 12);
  if (groups > MAX_CMAP_GROUPS) throw new EmojiFontError("TOO_LARGE", `cmap: ${groups} groups`);
  if (!cmap.fits(subtable + 16, 12 * groups)) throw new EmojiFontError("TRUNCATED", "cmap: the format 12 groups run past the table");
  const starts = new Uint32Array(groups);
  const ends = new Uint32Array(groups);
  const firsts = new Uint32Array(groups);
  let previousEnd = -1;
  for (let g = 0; g < groups; g++) {
    const start = cmap.u32(subtable + 16 + 12 * g);
    const end = cmap.u32(subtable + 20 + 12 * g);
    const first = cmap.u32(subtable + 24 + 12 * g);
    if (end < start || start <= previousEnd || end > 0x10ffff) throw bad("cmap", "the format 12 groups are not sorted and disjoint");
    if (first + (end - start) >= numGlyphs) throw bad("cmap", "a group maps past the last glyph");
    previousEnd = end;
    starts[g] = start;
    ends[g] = end;
    firsts[g] = first;
  }
  return (codePoint) => {
    let low = 0;
    let high = groups - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const start = starts[mid] ?? 0;
      if (codePoint < start) high = mid - 1;
      else if (codePoint > (ends[mid] ?? 0)) low = mid + 1;
      else return (firsts[mid] ?? 0) + (codePoint - start);
    }
    return 0;
  };
}

/** What one GSUB read may cost in all, however many lookups and subtables point at the same structures. */
interface Budget {
  ligatures: number;
  work: number;
}

function charge(budget: Budget, work: number): void {
  budget.work += work;
  if (budget.work > MAX_GSUB_WORK) throw new EmojiFontError("TOO_LARGE", "GSUB: more work than any emoji font needs");
}

/** One ligature: the glyphs after the first, and the glyph they become. */
interface Ligature {
  rest: readonly number[];
  glyph: number;
}
/** One lookup's ligatures, keyed by first glyph, in the order the font lists them (the first match wins). */
type LigatureStage = Map<number, Ligature[]>;

/** The glyphs a coverage table names, each mapped to its coverage index. Ascending, so the total is bounded by `numGlyphs`. */
function readCoverage(gsub: Region, at: number, numGlyphs: number, budget: Budget): Map<number, number> {
  const coverage = new Map<number, number>();
  const format = gsub.u16(at);
  const count = gsub.u16(at + 2);
  // A range can name 65 535 glyphs in 6 bytes, so ranges are charged by the glyphs they name, before the loop runs.
  if (format === 1) charge(budget, count);
  if (format === 1) {
    let previous = -1;
    for (let i = 0; i < count; i++) {
      const glyph = gsub.u16(at + 4 + 2 * i);
      if (glyph <= previous || glyph >= numGlyphs) throw bad("GSUB", "a coverage glyph array is not ascending or names a missing glyph");
      previous = glyph;
      coverage.set(glyph, i);
    }
  } else if (format === 2) {
    let previous = -1;
    for (let i = 0; i < count; i++) {
      const start = gsub.u16(at + 4 + 6 * i);
      const end = gsub.u16(at + 6 + 6 * i);
      const index = gsub.u16(at + 8 + 6 * i);
      if (end < start || start <= previous || end >= numGlyphs) throw bad("GSUB", "coverage ranges are not ascending and disjoint");
      previous = end;
      charge(budget, end - start + 1);
      for (let glyph = start; glyph <= end; glyph++) coverage.set(glyph, index + glyph - start);
    }
  } else throw bad("GSUB", `coverage format ${format}`);
  return coverage;
}

function readLigatureSubtable(gsub: Region, at: number, numGlyphs: number, stage: LigatureStage, budget: Budget): void {
  if (gsub.u16(at) !== 1) throw bad("GSUB", "a ligature substitution that is not format 1");
  const coverage = readCoverage(gsub, at + gsub.u16(at + 2), numGlyphs, budget);
  const sets = gsub.u16(at + 4);
  for (const [first, index] of coverage) {
    if (index >= sets) throw bad("GSUB", "a covered glyph has no ligature set");
    charge(budget, 1);
    const set = at + gsub.u16(at + 6 + 2 * index);
    const count = gsub.u16(set);
    budget.ligatures += count;
    if (budget.ligatures > MAX_LIGATURES) throw new EmojiFontError("TOO_LARGE", "GSUB: too many ligatures");
    const candidates = stage.get(first) ?? [];
    for (let k = 0; k < count; k++) {
      const ligature = set + gsub.u16(set + 2 + 2 * k);
      const glyph = gsub.u16(ligature);
      const components = gsub.u16(ligature + 2);
      if (glyph >= numGlyphs || components < 1 || components > MAX_SEQUENCE) throw bad("GSUB", "a ligature with a missing glyph or an impossible component count");
      const rest: number[] = [];
      for (let j = 0; j < components - 1; j++) {
        const component = gsub.u16(ligature + 4 + 2 * j);
        if (component >= numGlyphs) throw bad("GSUB", "a ligature component names a missing glyph");
        rest.push(component);
      }
      candidates.push({ rest, glyph });
    }
    stage.set(first, candidates);
  }
}

/** Every ligature lookup, in lookup order. Other lookup types are not needed by this font and are skipped. */
function readLigatureStages(gsub: Region, numGlyphs: number): LigatureStage[] {
  if (gsub.u16(0) !== 1) throw bad("GSUB", "not version 1");
  const lookupList = gsub.u16(8);
  const lookups = gsub.u16(lookupList);
  if (lookups > MAX_LOOKUPS) throw new EmojiFontError("TOO_LARGE", `GSUB: ${lookups} lookups`);
  const stages: LigatureStage[] = [];
  const budget: Budget = { ligatures: 0, work: 0 };
  for (let l = 0; l < lookups; l++) {
    const lookup = lookupList + gsub.u16(lookupList + 2 + 2 * l);
    const type = gsub.u16(lookup);
    const subtables = gsub.u16(lookup + 4);
    if (subtables > MAX_LOOKUP_SUBTABLES) throw new EmojiFontError("TOO_LARGE", `GSUB: ${subtables} subtables in a lookup`);
    if (type !== 4 && type !== 7) continue;
    const stage: LigatureStage = new Map();
    for (let s = 0; s < subtables; s++) {
      let subtable = lookup + gsub.u16(lookup + 6 + 2 * s);
      if (type === 7) {
        if (gsub.u16(subtable) !== 1) throw bad("GSUB", "an extension subtable that is not format 1");
        const inner = gsub.u16(subtable + 2);
        subtable += gsub.u32(subtable + 4);
        if (inner !== 4) continue;
      }
      readLigatureSubtable(gsub, subtable, numGlyphs, stage, budget);
    }
    if (stage.size > 0) stages.push(stage);
  }
  return stages;
}

interface Slot {
  /** Offset of the glyph's data inside CBDT. */
  offset: number;
  length: number;
}

interface Strike {
  ppem: number;
  ascender: number;
  descender: number;
  slots: Map<number, Slot>;
}

/** The strike with the largest ppem: its index subtables, every glyph's slot checked to lie inside CBDT. */
function readStrike(cblc: Region, cbdt: Region, numGlyphs: number): Strike {
  if (cblc.u32(0) !== 0x00030000) throw new EmojiFontError("UNSUPPORTED", "CBLC: not version 3.0");
  const strikes = cblc.u32(4);
  if (strikes < 1) throw new EmojiFontError("UNSUPPORTED", "CBLC: no bitmap strike");
  if (strikes > MAX_STRIKES) throw new EmojiFontError("TOO_LARGE", `CBLC: ${strikes} strikes`);
  let best = -1;
  let bestPpem = -1;
  for (let i = 0; i < strikes; i++) {
    const ppem = cblc.u8(8 + 48 * i + 45);
    if (ppem > bestPpem) {
      best = i;
      bestPpem = ppem;
    }
  }
  const record = 8 + 48 * best;
  const array = cblc.u32(record);
  const subtables = cblc.u32(record + 8);
  if (subtables > MAX_INDEX_SUBTABLES) throw new EmojiFontError("TOO_LARGE", `CBLC: ${subtables} index subtables`);
  if (cbdt.length < 4 || cbdt.u16(0) < 2 || cbdt.u16(0) > 3) throw new EmojiFontError("UNSUPPORTED", "CBDT: unknown version");
  const slots = new Map<number, Slot>();
  let previousLast = -1;
  for (let i = 0; i < subtables; i++) {
    const first = cblc.u16(array + 8 * i);
    const last = cblc.u16(array + 8 * i + 2);
    const subtable = array + cblc.u32(array + 8 * i + 4);
    if (last < first || first <= previousLast || last >= numGlyphs) throw bad("CBLC", "index subtable ranges are not ascending and disjoint, or run past the last glyph");
    previousLast = last;
    const indexFormat = cblc.u16(subtable);
    const imageFormat = cblc.u16(subtable + 2);
    const dataOffset = cblc.u32(subtable + 4);
    if (imageFormat !== 17) throw new EmojiFontError("UNSUPPORTED", `CBLC: image format ${imageFormat}`);
    if (indexFormat !== 1 && indexFormat !== 3) throw new EmojiFontError("UNSUPPORTED", `CBLC: index format ${indexFormat}`);
    const read = indexFormat === 1 ? (n: number) => cblc.u32(subtable + 8 + 4 * n) : (n: number) => cblc.u16(subtable + 8 + 2 * n);
    let from = read(0);
    for (let glyph = first; glyph <= last; glyph++) {
      const to = read(glyph - first + 1);
      if (to < from) throw bad("CBLC", "glyph offsets go backwards");
      // Format 17: smallGlyphMetrics (5) + dataLength (4) + PNG. An empty slot is a glyph without a bitmap.
      if (to > from) {
        if (to - from < 9 || !cbdt.fits(dataOffset + from, to - from)) throw bad("CBLC", "a glyph's bitmap lies outside CBDT");
        slots.set(glyph, { offset: dataOffset + from, length: to - from });
      }
      from = to;
    }
  }
  return { ppem: bestPpem, ascender: cblc.i8(record + 16), descender: cblc.i8(record + 17), slots };
}

/** Checks every glyph's record once, so `bitmap()` afterwards only slices. Returns the PNG's own bounds. */
function checkBitmaps(cbdt: Region, strike: Strike): Map<number, EmojiBitmapRecord> {
  const records = new Map<number, EmojiBitmapRecord>();
  for (const [glyph, slot] of strike.slots) {
    const height = cbdt.u8(slot.offset);
    const width = cbdt.u8(slot.offset + 1);
    const pngLength = cbdt.u32(slot.offset + 5);
    if (pngLength !== slot.length - 9) throw bad("CBDT", "a glyph's data length disagrees with the index");
    const png = slot.offset + 9;
    for (let i = 0; i < PNG_SIGNATURE.length; i++) if (cbdt.u8(png + i) !== PNG_SIGNATURE[i]) throw bad("CBDT", "a glyph's data is not a PNG");
    if (pngLength < 33 || cbdt.u32(png + 8) !== 13 || cbdt.u32(png + 12) !== IHDR_TAG || cbdt.u32(png + 16) !== width || cbdt.u32(png + 20) !== height) throw bad("CBDT", "a PNG's first chunk is not a 13-byte IHDR of the size its metrics state");
    records.set(glyph, { png, pngLength, width, height, bearingX: cbdt.i8(slot.offset + 2), bearingY: cbdt.i8(slot.offset + 3), advance: cbdt.u8(slot.offset + 4) });
  }
  return records;
}

interface EmojiBitmapRecord {
  /** Offset of the PNG inside CBDT. */
  png: number;
  pngLength: number;
  width: number;
  height: number;
  bearingX: number;
  bearingY: number;
  advance: number;
}

function codePointsOf(sequence: string | readonly number[]): number[] | null {
  const points: number[] = [];
  if (typeof sequence === "string") {
    if (sequence.length > 2 * MAX_SEQUENCE) return null;
    for (const character of sequence) {
      const point = character.codePointAt(0);
      if (point === undefined || (point >= 0xd800 && point <= 0xdfff)) return null;
      points.push(point);
    }
  } else {
    if (sequence.length > MAX_SEQUENCE) return null;
    for (const point of sequence) {
      if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) return null;
      points.push(point);
    }
  }
  return points.length === 0 || points.length > MAX_SEQUENCE ? null : points;
}

/** A detached or otherwise unreadable buffer makes `slice` throw a TypeError; the reader's only error is its own. */
function copyOf(input: Uint8Array): Uint8Array {
  try {
    // Not `input.slice()`: on a Node Buffer (what readFile returns) that is a view, not a copy.
    return new Uint8Array(input);
  } catch {
    throw new EmojiFontError("NOT_A_FONT", "the input buffer is detached or unreadable");
  }
}

/**
 * Opens the font. Throws an `EmojiFontError` when the bytes are not a CBDT font this reader can trust, and nothing
 * else. The returned object never throws, and does not depend on `input` after this call returns.
 */
export function openEmojiFont(input: Uint8Array): EmojiFont {
  // The font keeps its own copy (about 1 ms): the caller may transfer, reuse or overwrite its buffer afterwards.
  const bytes = copyOf(input);
  const { table } = readDirectory(bytes);
  const maxp = table("maxp");
  const numGlyphs = maxp.u16(4);
  const glyphOf = readCmap(table("cmap"), numGlyphs);
  const stages = readLigatureStages(table("GSUB"), numGlyphs);
  const cbdt = table("CBDT");
  const strike = readStrike(table("CBLC"), cbdt, numGlyphs);
  const records = checkBitmaps(cbdt, strike);

  // VS16 only asks for the emoji presentation of a glyph the font draws that way anyway, so it is dropped before
  // shaping (HarfBuzz consumes it in normalisation, through cmap 14, before GSUB sees the run).
  const shape = (points: readonly number[]): number | null => {
    let glyphs: number[] = [];
    for (const point of points) {
      if (point === VS16) continue;
      const glyph = glyphOf(point);
      if (glyph === 0) return null;
      glyphs.push(glyph);
    }
    for (const stage of stages) {
      const out: number[] = [];
      for (let i = 0; i < glyphs.length; ) {
        const current = glyphs[i] ?? 0;
        const hit = stage.get(current)?.find((ligature) => ligature.rest.every((glyph, j) => glyphs[i + 1 + j] === glyph));
        if (hit === undefined) {
          out.push(current);
          i++;
        } else {
          out.push(hit.glyph);
          i += 1 + hit.rest.length;
        }
      }
      glyphs = out;
    }
    const only = glyphs.length === 1 ? glyphs[0] : undefined;
    return only !== undefined && records.has(only) ? only : null;
  };
  const glyphId = (sequence: string | readonly number[]): number | null => {
    const points = codePointsOf(sequence);
    return points === null ? null : shape(points);
  };

  return {
    ppem: strike.ppem,
    ascender: strike.ascender,
    descender: strike.descender,
    bitmapCount: records.size,
    glyphId,
    has: (sequence) => glyphId(sequence) !== null,
    bitmap(sequence) {
      const glyph = glyphId(sequence);
      const record = glyph === null ? undefined : records.get(glyph);
      if (record === undefined) return null;
      const start = cbdt.start + record.png;
      return {
        png: bytes.slice(start, start + record.pngLength),
        width: record.width,
        height: record.height,
        bearingX: record.bearingX,
        bearingY: record.bearingY,
        advance: record.advance,
      };
    },
  };
}
