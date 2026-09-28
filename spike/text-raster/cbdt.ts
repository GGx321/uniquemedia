// Extracts the per-emoji PNG bitmaps from Noto Color Emoji's CBDT/CBLC tables. Single code points resolve through
// cmap; ZWJ sequences, flags, keycaps and skin tones through a small GSUB ligature (type 4) pass. The font's
// `post` table is format 3 (no glyph names), so names cannot be used. Exploratory, ~150 lines.
export interface EmojiBitmaps {
  count: number;
  totalPngBytes: number;
  ppem: number;
  /** PNG bytes for a code point sequence, or undefined when the font has no such glyph. */
  get(cps: number[]): Uint8Array | undefined;
  has(cps: number[]): boolean;
}

import { readMetrics } from "./sfnt";

export function readCbdt(buf: Uint8Array): EmojiBitmaps {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint16(4);
  const tab = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    tab.set(String.fromCharCode(...buf.subarray(o, o + 4)), dv.getUint32(o + 8));
  }
  const cblc = tab.get("CBLC");
  const cbdt = tab.get("CBDT");
  if (cblc === undefined || cbdt === undefined) throw new Error("not a CBDT font");
  const metrics = readMetrics(buf);
  const gsub = tab.get("GSUB");
  if (gsub === undefined) throw new Error("no GSUB");
  const coverage = (o: number): Map<number, number> => {
    const m = new Map<number, number>();
    const f = dv.getUint16(o);
    if (f === 1) {
      const cnt = dv.getUint16(o + 2);
      for (let i = 0; i < cnt; i++) m.set(dv.getUint16(o + 4 + 2 * i), i);
    } else {
      const cnt = dv.getUint16(o + 2);
      for (let i = 0; i < cnt; i++) {
        const s = dv.getUint16(o + 4 + 6 * i);
        const e = dv.getUint16(o + 6 + 6 * i);
        const si = dv.getUint16(o + 8 + 6 * i);
        for (let g = s; g <= e; g++) m.set(g, si + g - s);
      }
    }
    return m;
  };
  // Every ligature (type 4) subtable of every lookup, in lookup order: first glyph -> [components, ligature glyph]
  type Lig = [number[], number];
  const stages: Map<number, Lig[]>[] = [];
  const lookupList = gsub + dv.getUint16(gsub + 8);
  const nLookups = dv.getUint16(lookupList);
  for (let li = 0; li < nLookups; li++) {
    const lk = lookupList + dv.getUint16(lookupList + 2 + 2 * li);
    let type = dv.getUint16(lk);
    const nSubs = dv.getUint16(lk + 4);
    const stage = new Map<number, Lig[]>();
    for (let si = 0; si < nSubs; si++) {
      let st = lk + dv.getUint16(lk + 6 + 2 * si);
      if (type === 7) {
        const inner = dv.getUint16(st + 2);
        st = st + dv.getUint32(st + 4);
        if (inner !== 4) continue;
      } else if (type !== 4) continue;
      const cov = coverage(st + dv.getUint16(st + 2));
      const nSets = dv.getUint16(st + 4);
      for (const [first, ci] of cov) {
        if (ci >= nSets) continue;
        const set = st + dv.getUint16(st + 6 + 2 * ci);
        const cnt = dv.getUint16(set);
        const arr = stage.get(first) ?? [];
        for (let k = 0; k < cnt; k++) {
          const lg = set + dv.getUint16(set + 2 + 2 * k);
          const glyph = dv.getUint16(lg);
          const cc = dv.getUint16(lg + 2);
          const comps: number[] = [];
          for (let j = 0; j < cc - 1; j++) comps.push(dv.getUint16(lg + 4 + 2 * j));
          arr.push([comps, glyph]);
        }
        stage.set(first, arr);
      }
    }
    void type;
    type = 0;
    if (stage.size) stages.push(stage);
  }
  const shape = (cps: number[]): number[] => {
    let g = cps.filter((c) => c !== 0xfe0f).map((c) => metrics.gid(c));
    if (g.includes(0)) return [0];
    for (const stage of stages) {
      const out: number[] = [];
      for (let i = 0; i < g.length; ) {
        const cands = stage.get(g[i]!);
        const hit = cands?.find(([comps]) => comps.every((c, j) => g[i + 1 + j] === c));
        if (hit) {
          out.push(hit[1]);
          i += 1 + hit[0].length;
        } else out.push(g[i++]!);
      }
      g = out;
    }
    return g;
  };
  // CBLC: first strike
  const nSizes = dv.getUint32(cblc + 4);
  const strike = cblc + 8; // BitmapSize record: indexSubTableArrayOffset(4) ... ppemX at +44
  const arrOff = cblc + dv.getUint32(strike);
  const nSub = dv.getUint32(strike + 8);
  const ppem = dv.getUint8(strike + 44);
  void nSizes;
  const loc = new Map<number, [number, number]>(); // gid -> [offset, length] inside CBDT
  for (let i = 0; i < nSub; i++) {
    const first = dv.getUint16(arrOff + 8 * i);
    const last = dv.getUint16(arrOff + 8 * i + 2);
    const sub = arrOff + dv.getUint32(arrOff + 8 * i + 4);
    const fmt = dv.getUint16(sub);
    const imgFmt = dv.getUint16(sub + 2);
    const dataOff = dv.getUint32(sub + 4);
    if (imgFmt !== 17) throw new Error(`unsupported image format ${imgFmt}`);
    for (let g = first; g <= last; g++) {
      if (fmt === 1) {
        const a = dv.getUint32(sub + 8 + 4 * (g - first));
        const b = dv.getUint32(sub + 8 + 4 * (g - first + 1));
        loc.set(g, [dataOff + a, b - a]);
      } else if (fmt === 3) {
        const a = dv.getUint16(sub + 8 + 2 * (g - first));
        const b = dv.getUint16(sub + 8 + 2 * (g - first + 1));
        loc.set(g, [dataOff + a, b - a]);
      } else throw new Error(`unsupported index format ${fmt}`);
    }
  }
  const pngOf = (g: number): Uint8Array | undefined => {
    const l = loc.get(g);
    if (!l) return undefined;
    // format 17: smallGlyphMetrics(5) + dataLen(4) + PNG
    const o = cbdt + l[0];
    const len = dv.getUint32(o + 5);
    return buf.subarray(o + 9, o + 9 + len);
  };
  const gidFor = (cps: number[]): number | undefined => {
    const g = shape(cps);
    return g.length === 1 && g[0] !== 0 && loc.has(g[0]!) ? g[0] : undefined;
  };
  return {
    count: loc.size,
    totalPngBytes: [...loc.keys()].reduce((a, g) => a + (pngOf(g)?.length ?? 0), 0),
    ppem,
    has: (cps) => gidFor(cps) !== undefined,
    get: (cps) => {
      const g = gidFor(cps);
      return g === undefined ? undefined : pngOf(g);
    },
  };
}
