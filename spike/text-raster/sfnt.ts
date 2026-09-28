// Minimal sfnt reader (~70 lines): head/hhea/hmtx/cmap(4,12). Enough for vertical metrics, an advance-width
// estimate (no kerning, no shaping) and the cmap coverage check of invariant 22. Exploratory, not production.
export interface FontMetrics {
  unitsPerEm: number;
  ascender: number;
  descender: number; // negative
  lineGap: number;
  advance(cp: number): number | undefined; // font units; undefined = not in cmap
  gid(cp: number): number; // 0 = not in cmap
}

export function readMetrics(buf: Uint8Array): FontMetrics {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint16(4);
  const tab = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    tab.set(String.fromCharCode(...buf.subarray(o, o + 4)), dv.getUint32(o + 8));
  }
  const need = (t: string): number => {
    const v = tab.get(t);
    if (v === undefined) throw new Error(`missing table ${t}`);
    return v;
  };
  const head = need("head");
  const hhea = need("hhea");
  const hmtx = need("hmtx");
  const unitsPerEm = dv.getUint16(head + 18);
  const nHM = dv.getUint16(hhea + 34);
  const cmap = need("cmap");
  const nSub = dv.getUint16(cmap + 2);
  let fmt4 = -1;
  let fmt12 = -1;
  for (let i = 0; i < nSub; i++) {
    const off = cmap + dv.getUint32(cmap + 4 + 8 * i + 4);
    const f = dv.getUint16(off);
    if (f === 4 && fmt4 < 0) fmt4 = off;
    if (f === 12) fmt12 = off;
  }
  const gid = (cp: number): number => {
    if (fmt12 >= 0) {
      const ng = dv.getUint32(fmt12 + 12);
      for (let g = 0; g < ng; g++) {
        const o = fmt12 + 16 + 12 * g;
        const s = dv.getUint32(o);
        const e = dv.getUint32(o + 4);
        if (cp >= s && cp <= e) return dv.getUint32(o + 8) + (cp - s);
      }
      return 0;
    }
    if (fmt4 < 0 || cp > 0xffff) return 0;
    const segX2 = dv.getUint16(fmt4 + 6);
    const endO = fmt4 + 14;
    const startO = endO + segX2 + 2;
    const deltaO = startO + segX2;
    const rangeO = deltaO + segX2;
    for (let s = 0; s < segX2; s += 2) {
      if (cp <= dv.getUint16(endO + s)) {
        if (cp < dv.getUint16(startO + s)) return 0;
        const ro = dv.getUint16(rangeO + s);
        if (ro === 0) return (cp + dv.getInt16(deltaO + s)) & 0xffff;
        const g = dv.getUint16(rangeO + s + ro + 2 * (cp - dv.getUint16(startO + s)));
        return g === 0 ? 0 : (g + dv.getInt16(deltaO + s)) & 0xffff;
      }
    }
    return 0;
  };
  return {
    unitsPerEm,
    ascender: dv.getInt16(hhea + 4),
    descender: dv.getInt16(hhea + 6),
    lineGap: dv.getInt16(hhea + 8),
    gid,
    advance(cp) {
      const g = gid(cp);
      if (g === 0) return undefined;
      const i = Math.min(g, nHM - 1);
      return dv.getUint16(hmtx + 4 * i);
    },
  };
}
