/**
 * A minimal sfnt reader: the `cmap` (does this font have a glyph for a code point, invariant 22: the text
 * fonts cover the allowed charset, so no caption draws tofu) and the few facts the manifest promises about a
 * font (`fontInfo`), and the `hhea` line metrics (`verticalMetrics`). No shaping and no widths: widths come from
 * resvg's own `getBBox()` (plan, Text row).
 *
 * It parses the bundled, sha256-pinned fonts, never user bytes, but it still never trusts an offset:
 * everything a lookup will read is bounds-checked once, at construction, so a truncated or mutated file
 * throws an `Error("sfnt: ...")` there, never a `RangeError` at the first `has()`, and `has()` itself cannot throw.
 */

class SfntError extends Error {
  constructor(why: string) {
    super(`sfnt: ${why}`);
    this.name = "SfntError";
  }
}

interface Directory {
  readonly view: DataView;
  table(tag: string): number | null;
}

function directoryOf(bytes: Uint8Array): Directory {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12) throw new SfntError("too short to be a font");
  const count = view.getUint16(4);
  if (12 + 16 * count > view.byteLength) throw new SfntError("truncated table directory");
  const tables = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const record = 12 + 16 * i;
    const tag = String.fromCharCode(view.getUint8(record), view.getUint8(record + 1), view.getUint8(record + 2), view.getUint8(record + 3));
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > view.byteLength) throw new SfntError(`the ${tag} table runs past the end of the file`);
    if (!tables.has(tag)) tables.set(tag, offset);
  }
  return { view, table: (tag) => tables.get(tag) ?? null };
}

/** A validated lookup from code point to glyph id, or 0. */
type GlyphLookup = (codePoint: number) => number;

/** cmap format 12: sorted groups of (start, end, first glyph). */
function format12(view: DataView, at: number): GlyphLookup {
  if (at + 16 > view.byteLength) throw new SfntError("truncated cmap format 12 header");
  const groups = view.getUint32(at + 12);
  if (at + 16 + 12 * groups > view.byteLength) throw new SfntError("truncated cmap format 12 groups");
  let previousEnd = -1;
  for (let g = 0; g < groups; g++) {
    const start = view.getUint32(at + 16 + 12 * g);
    const end = view.getUint32(at + 20 + 12 * g);
    if (end < start || start <= previousEnd) throw new SfntError("cmap format 12 groups are not sorted and disjoint");
    previousEnd = end;
  }
  return (codePoint) => {
    let low = 0;
    let high = groups - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const start = view.getUint32(at + 16 + 12 * mid);
      const end = view.getUint32(at + 20 + 12 * mid);
      if (codePoint < start) high = mid - 1;
      else if (codePoint > end) low = mid + 1;
      else return view.getUint32(at + 24 + 12 * mid) + (codePoint - start);
    }
    return 0;
  };
}

/** cmap format 4: segments sorted by end code, each with a delta or a glyph-index range. */
function format4(view: DataView, at: number): GlyphLookup {
  if (at + 14 > view.byteLength) throw new SfntError("truncated cmap format 4 header");
  const segmentsX2 = view.getUint16(at + 6);
  const segments = segmentsX2 >> 1;
  const ends = at + 14;
  const starts = ends + segmentsX2 + 2;
  const deltas = starts + segmentsX2;
  const rangeOffsets = deltas + segmentsX2;
  if (segmentsX2 % 2 !== 0 || segments === 0 || rangeOffsets + segmentsX2 > view.byteLength) throw new SfntError("truncated cmap format 4 segments");
  let previousEnd = -1;
  for (let s = 0; s < segments; s++) {
    const end = view.getUint16(ends + 2 * s);
    const start = view.getUint16(starts + 2 * s);
    if (end < start || end <= previousEnd) throw new SfntError("cmap format 4 segments are not sorted");
    previousEnd = end;
    if (view.getUint16(rangeOffsets + 2 * s) !== 0) {
      const last = rangeOffsets + 2 * s + view.getUint16(rangeOffsets + 2 * s) + 2 * (end - start);
      if (last + 2 > view.byteLength) throw new SfntError("cmap format 4 glyph index array runs past the end of the file");
    }
  }
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    let low = 0;
    let high = segments - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (view.getUint16(ends + 2 * mid) < codePoint) low = mid + 1;
      else high = mid;
    }
    const start = view.getUint16(starts + 2 * low);
    if (codePoint < start || codePoint > view.getUint16(ends + 2 * low)) return 0;
    const delta = view.getInt16(deltas + 2 * low);
    const rangeOffset = view.getUint16(rangeOffsets + 2 * low);
    if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
    const glyph = view.getUint16(rangeOffsets + 2 * low + rangeOffset + 2 * (codePoint - start));
    return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
  };
}

/** Full-repertoire encodings first, then BMP-only: (3,10) and (0,4) hold format 12, (3,1) and (0,3) usually format 4. */
const ENCODING_PRIORITY: readonly (readonly [platform: number, encoding: number])[] = [
  [3, 10],
  [0, 4],
  [3, 1],
  [0, 3],
];

/**
 * Answers whether the font has a glyph (not `.notdef`, and one that exists: below `maxp.numGlyphs`) for a code point.
 * Throws an `Error("sfnt: ...")` when the bytes are not a font this reader can trust.
 */
export function cmapCoverage(bytes: Uint8Array): (codePoint: number) => boolean {
  const { view, table } = directoryOf(bytes);
  const cmap = table("cmap");
  const maxp = table("maxp");
  if (cmap === null) throw new SfntError("no cmap table");
  if (maxp === null || maxp + 6 > view.byteLength) throw new SfntError("no maxp table");
  const numGlyphs = view.getUint16(maxp + 4);
  if (cmap + 4 > view.byteLength) throw new SfntError("truncated cmap header");

  const records = view.getUint16(cmap + 2);
  if (cmap + 4 + 8 * records > view.byteLength) throw new SfntError("truncated cmap encoding records");
  const subtables = new Map<string, { offset: number; format: number }>();
  for (let i = 0; i < records; i++) {
    const record = cmap + 4 + 8 * i;
    const offset = cmap + view.getUint32(record + 4);
    if (offset + 2 > view.byteLength) throw new SfntError("a cmap subtable starts past the end of the file");
    subtables.set(`${view.getUint16(record)}/${view.getUint16(record + 2)}`, { offset, format: view.getUint16(offset) });
  }
  for (const [platform, encoding] of ENCODING_PRIORITY) {
    const subtable = subtables.get(`${platform}/${encoding}`);
    if (subtable === undefined) continue;
    const lookup = subtable.format === 12 ? format12(view, subtable.offset) : subtable.format === 4 ? format4(view, subtable.offset) : null;
    if (lookup === null) continue;
    return (codePoint) => {
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return false;
      const glyph = lookup(codePoint);
      return glyph !== 0 && glyph < numGlyphs;
    };
  }
  throw new SfntError("no usable Unicode cmap subtable (format 12 or 4)");
}

export interface FontInfo {
  /** Every family name the font gives (name ids 1 and 16), which is what resvg matches `font-family` against. */
  families: string[];
  /** Name id 4, or "" when absent. */
  fullName: string;
  /** `OS/2.usWeightClass`. */
  weightClass: number;
  /** True while the font still carries an `fvar` table: resvg 2.6.x does not instantiate those. */
  variable: boolean;
}

function decodeName(view: DataView, at: number, length: number, platform: number): string {
  let out = "";
  if (platform === 1) for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(at + i));
  else for (let i = 0; i + 1 < length; i += 2) out += String.fromCharCode(view.getUint16(at + i));
  return out;
}

/** The names, weight class and variable-ness of a font, for the manifest's promises. */
export function fontInfo(bytes: Uint8Array): FontInfo {
  const { view, table } = directoryOf(bytes);
  const name = table("name");
  const os2 = table("OS/2");
  if (name === null || name + 6 > view.byteLength) throw new SfntError("no name table");
  if (os2 === null || os2 + 6 > view.byteLength) throw new SfntError("no OS/2 table");
  const count = view.getUint16(name + 2);
  const storage = name + view.getUint16(name + 4);
  if (name + 6 + 12 * count > view.byteLength) throw new SfntError("truncated name records");
  const families = new Set<string>();
  let fullName = "";
  for (let i = 0; i < count; i++) {
    const record = name + 6 + 12 * i;
    const platform = view.getUint16(record);
    const id = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const at = storage + view.getUint16(record + 10);
    if ((platform !== 1 && platform !== 3) || (id !== 1 && id !== 4 && id !== 16)) continue;
    if (at + length > view.byteLength) throw new SfntError("a name string runs past the end of the file");
    const text = decodeName(view, at, length, platform);
    if (id === 4) fullName = text;
    else families.add(text);
  }
  return { families: [...families], fullName, weightClass: view.getUint16(os2 + 4), variable: table("fvar") !== null };
}

export interface VerticalMetrics {
  unitsPerEm: number;
  /** `hhea.ascender`, above the baseline (positive), in font units. */
  ascender: number;
  /** `hhea.descender`, below the baseline (negative), in font units. */
  descender: number;
}

/**
 * The font's `hhea` line metrics and `head.unitsPerEm`: where the caption layout puts a line's baseline. It is one
 * consistent choice, not what any shaper does, because the layout places every run itself.
 */
export function verticalMetrics(bytes: Uint8Array): VerticalMetrics {
  const { view, table } = directoryOf(bytes);
  const head = table("head");
  const hhea = table("hhea");
  if (head === null || head + 20 > view.byteLength) throw new SfntError("no head table");
  if (hhea === null || hhea + 10 > view.byteLength) throw new SfntError("no hhea table");
  const unitsPerEm = view.getUint16(head + 18);
  const ascender = view.getInt16(hhea + 4);
  const descender = view.getInt16(hhea + 6);
  if (unitsPerEm < 16 || unitsPerEm > 16384) throw new SfntError(`units per em ${unitsPerEm} is out of range`);
  if (ascender <= 0 || descender >= 0) throw new SfntError(`hhea ascender ${ascender} and descender ${descender} are not above and below the baseline`);
  return { unitsPerEm, ascender, descender };
}
