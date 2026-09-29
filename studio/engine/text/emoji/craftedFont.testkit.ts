// Tiny hostile fonts for the reader's bounds tests: only `maxp`, `cmap` and a `GSUB` the caller shapes. They stop
// being fonts after GSUB (no CBDT), which is fine: GSUB is read before CBDT, so what a test asserts is what
// `openEmojiFont` says about the GSUB.

class Bytes {
  readonly data: number[] = [];
  u8(value: number): void {
    this.data.push(value & 0xff);
  }
  u16(value: number): void {
    this.u8(value >> 8);
    this.u8(value);
  }
  u32(value: number): void {
    this.u16(value >>> 16);
    this.u16(value & 0xffff);
  }
  tag(name: string): void {
    for (const character of name) this.u8(character.charCodeAt(0));
  }
}

export interface CraftedGsub {
  /** Lookups in the lookup list, all pointing at the same lookup table. */
  lookups: number;
  /** Subtables in that lookup, all pointing at the same ligature subtable. */
  subtables: number;
  /** Single-glyph ranges in the coverage table (glyphs 0..n-1, each range's coverage index 0). */
  coverageGlyphs: number;
  /** How many ligature offsets the one ligature set lists. They all point at one ligature. */
  ligatures: number;
  /** That ligature's componentCount (1 = no further components). */
  components: number;
}

/**
 * GSUB v1: one lookup table (type 4) shared by every entry of the lookup list, one ligature subtable shared by every
 * subtable entry, one ligature set.
 */
function gsub(spec: CraftedGsub): number[] {
  const w = new Bytes();
  const { lookups, subtables, coverageGlyphs, ligatures, components } = spec;
  w.u16(1);
  w.u16(0);
  w.u16(0);
  w.u16(0);
  w.u16(10); // lookup list at 10
  w.u16(lookups);
  const lookupAt = 2 + 2 * lookups;
  for (let i = 0; i < lookups; i++) w.u16(lookupAt);
  // The lookup, relative to the lookup list.
  w.u16(4);
  w.u16(0);
  w.u16(subtables);
  const subtableAt = 6 + 2 * subtables;
  for (let i = 0; i < subtables; i++) w.u16(subtableAt);
  // The ligature subtable: format 1, one set. Set then coverage when the coverage offset still fits in 16 bits,
  // else coverage then set (a test cannot need both a huge set and a huge coverage).
  const setLength = 2 + 2 * ligatures + 4 + 2 * Math.max(0, components - 1);
  const coverageLength = 4 + 6 * coverageGlyphs;
  const coverageFirst = 8 + setLength > 0xffff;
  w.u16(1);
  w.u16(coverageFirst ? 8 : 8 + setLength);
  w.u16(1);
  w.u16(coverageFirst ? 8 + coverageLength : 8);
  const writeSet = (): void => {
    // The set: the count, the offsets, then the ligature (glyph 2, componentCount, ids of glyph 2). When the ligature
    // would sit past what a 16-bit offset reaches, every offset reads 2 instead and names the offsets' own first
    // bytes (glyph 2, componentCount 2, id 2): a valid ligature of two components, so `components` is then ignored.
    w.u16(ligatures);
    const ligatureAt = 2 + 2 * ligatures;
    for (let i = 0; i < ligatures; i++) w.u16(ligatureAt <= 0xffff ? ligatureAt : 2);
    w.u16(2);
    w.u16(components);
    for (let i = 0; i < Math.max(0, components - 1); i++) w.u16(2);
  };
  const writeCoverage = (): void => {
    w.u16(2);
    w.u16(coverageGlyphs);
    for (let g = 0; g < coverageGlyphs; g++) {
      w.u16(g);
      w.u16(g);
      w.u16(0);
    }
  };
  if (coverageFirst) {
    writeCoverage();
    writeSet();
  } else {
    writeSet();
    writeCoverage();
  }
  return w.data;
}

/** A tiny font whose GSUB is shaped by `spec`, for a test that asserts what `openEmojiFont` says about that GSUB. */
export function craftedGsubFont(spec: CraftedGsub): Uint8Array {
  const maxp = new Bytes();
  maxp.u32(0x00005000);
  maxp.u16(65535);
  const cmap = new Bytes();
  cmap.u16(0);
  cmap.u16(1);
  cmap.u16(3);
  cmap.u16(10);
  cmap.u32(12);
  cmap.u16(12);
  cmap.u16(0);
  cmap.u32(28);
  cmap.u32(0);
  cmap.u32(1);
  cmap.u32(0x41);
  cmap.u32(0x41);
  cmap.u32(1);
  const tables: [string, number[]][] = [
    ["GSUB", gsub(spec)],
    ["cmap", cmap.data],
    ["maxp", maxp.data],
  ];
  const out = new Bytes();
  out.u32(0x00010000);
  out.u16(tables.length);
  out.u16(0);
  out.u16(0);
  out.u16(0);
  let offset = 12 + 16 * tables.length;
  for (const [tag, data] of tables) {
    out.tag(tag);
    out.u32(0);
    out.u32(offset);
    out.u32(data.length);
    offset += data.length;
  }
  for (const [, data] of tables) out.data.push(...data);
  return Uint8Array.from(out.data);
}
