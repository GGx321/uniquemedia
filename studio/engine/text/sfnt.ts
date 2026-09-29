/**
 * A minimal sfnt `cmap` reader (formats 4 and 12), enough to answer "does this
 * font have a glyph for this code point" (invariant 22: the text fonts cover
 * the allowed charset, so no caption draws tofu). It parses only the bundled,
 * sha256-pinned fonts, never user bytes. No shaping, no metrics: widths come
 * from resvg's own `getBBox()` (plan, Text row).
 */
export function cmapCoverage(bytes: Uint8Array): (codePoint: number) => boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inRange = (offset: number, length: number): boolean => offset >= 0 && offset + length <= view.byteLength;
  const fail = (why: string): never => {
    throw new Error(`sfnt: ${why}`);
  };

  if (!inRange(0, 12)) return fail("too short to be a font");
  const tableCount = view.getUint16(4);
  let cmapOffset = -1;
  for (let i = 0; i < tableCount; i++) {
    const record = 12 + 16 * i;
    if (!inRange(record, 16)) return fail("truncated table directory");
    const tag = String.fromCharCode(view.getUint8(record), view.getUint8(record + 1), view.getUint8(record + 2), view.getUint8(record + 3));
    if (tag === "cmap") cmapOffset = view.getUint32(record + 8);
  }
  if (cmapOffset < 0 || !inRange(cmapOffset, 4)) return fail("no cmap table");

  let format4 = -1;
  let format12 = -1;
  const subtableCount = view.getUint16(cmapOffset + 2);
  for (let i = 0; i < subtableCount; i++) {
    const record = cmapOffset + 4 + 8 * i;
    if (!inRange(record, 8)) return fail("truncated cmap encoding records");
    const offset = cmapOffset + view.getUint32(record + 4);
    if (!inRange(offset, 2)) return fail("cmap subtable out of range");
    const format = view.getUint16(offset);
    if (format === 4 && format4 < 0) format4 = offset;
    if (format === 12 && format12 < 0) format12 = offset;
  }
  if (format4 < 0 && format12 < 0) return fail("no cmap subtable of format 4 or 12");

  const glyphIn12 = (codePoint: number): number => {
    const groups = view.getUint32(format12 + 12);
    for (let g = 0; g < groups; g++) {
      const at = format12 + 16 + 12 * g;
      if (!inRange(at, 12)) return fail("truncated cmap format 12");
      if (codePoint >= view.getUint32(at) && codePoint <= view.getUint32(at + 4)) return view.getUint32(at + 8) + (codePoint - view.getUint32(at));
    }
    return 0;
  };

  const glyphIn4 = (codePoint: number): number => {
    if (codePoint > 0xffff) return 0;
    const segmentsX2 = view.getUint16(format4 + 6);
    const ends = format4 + 14;
    const starts = ends + segmentsX2 + 2;
    const deltas = starts + segmentsX2;
    const rangeOffsets = deltas + segmentsX2;
    for (let s = 0; s < segmentsX2; s += 2) {
      if (!inRange(rangeOffsets + s, 2)) return fail("truncated cmap format 4");
      if (codePoint > view.getUint16(ends + s)) continue;
      const start = view.getUint16(starts + s);
      if (codePoint < start) return 0;
      const rangeOffset = view.getUint16(rangeOffsets + s);
      if (rangeOffset === 0) return (codePoint + view.getInt16(deltas + s)) & 0xffff;
      const at = rangeOffsets + s + rangeOffset + 2 * (codePoint - start);
      if (!inRange(at, 2)) return fail("cmap format 4 glyph index out of range");
      const glyph = view.getUint16(at);
      return glyph === 0 ? 0 : (glyph + view.getInt16(deltas + s)) & 0xffff;
    }
    return 0;
  };

  return (codePoint) => (format12 >= 0 ? glyphIn12(codePoint) : glyphIn4(codePoint)) !== 0;
}
