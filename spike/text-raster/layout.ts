// Engine-owned layout (A3): tokenise, measure, wrap to <= 2 lines, fit to 86% of the width, emit the fixed SVG.
// Emoji are NOT drawn by resvg (see README): they are laid out as square inline bitmaps taken from the CBDT
// font and embedded as engine-generated data: PNG URIs (resvg-wasm 2.6.2 resolves nothing else: imagesToResolve()
// stays empty for any non-data href). The href is never derived from user text, only from bundled bytes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-wasm";
import { cacheDir, esc, FONTS, fontBuffers, metricsFor, type FontKey, type Style } from "./common";
import { readCbdt, type EmojiBitmaps } from "./cbdt";

let emojiBitmaps: EmojiBitmaps | undefined;
export function emojiSet(): EmojiBitmaps {
  emojiBitmaps ??= readCbdt(new Uint8Array(readFileSync(join(cacheDir, "src", "NotoColorEmoji-CBDT.ttf"))));
  return emojiBitmaps;
}

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const seg = new Intl.Segmenter("en", { granularity: "grapheme" });

export type Piece = { kind: "text"; text: string } | { kind: "emoji"; cps: number[] };
export interface Word {
  pieces: Piece[];
}

/** Splits into words on spaces; each word is a list of text runs and emoji. Unknown emoji throw (the caption rules refuse them earlier). */
export function tokenise(s: string): Word[] {
  const words: Word[] = [];
  for (const raw of s.split(" ")) {
    if (raw === "") continue;
    const pieces: Piece[] = [];
    for (const { segment } of seg.segment(raw)) {
      if (EMOJI_RE.test(segment)) {
        const cps = [...segment].map((c) => c.codePointAt(0)!);
        if (!emojiSet().has(cps)) throw new Error(`emoji not covered by the bundled font: ${segment}`);
        pieces.push({ kind: "emoji", cps });
      } else {
        const last = pieces[pieces.length - 1];
        if (last?.kind === "text") last.text += segment;
        else pieces.push({ kind: "text", text: segment });
      }
    }
    words.push({ pieces });
  }
  return words;
}

// ---- measuring -----------------------------------------------------------------------------------------
const REF = 100; // measure at 100 px and scale linearly (no hinting: verified below)
export type Measurer = (text: string, font: FontKey) => number; // advance width at REF px

const bboxCache = new Map<string, number>();
function bboxWidth(text: string, font: FontKey): number {
  const f = FONTS[font];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="200"><text x="0" y="150" font-family="${esc(f.family)}" font-weight="${f.weight}" font-size="${REF}">${esc(text)}</text></svg>`;
  const r = new Resvg(svg, { font: { fontBuffers: fontBuffers(font, "none"), defaultFontFamily: f.family } });
  try {
    return r.getBBox()?.width ?? 0;
  } finally {
    r.free();
  }
}
/** resvg bbox loop. Sentinels make leading/trailing spaces count: w("|"+t+"|") - w("||"). */
export const measureBbox: Measurer = (text, font) => {
  const key = `${font}\u0000${text}`;
  let w = bboxCache.get(key);
  if (w === undefined) {
    const bars = bboxCache.get(`${font}\u0000||`) ?? bboxWidth("||", font);
    bboxCache.set(`${font}\u0000||`, bars);
    w = bboxWidth(`|${text}|`, font) - bars;
    bboxCache.set(key, w);
  }
  return w;
};
/** Pure JS: sum of hmtx advances. No kerning, no shaping. */
export const measureSfnt: Measurer = (text, font) => {
  const m = metricsFor(font);
  let w = 0;
  for (const ch of text) w += m.advance(ch.codePointAt(0)!) ?? m.advance(0x20)!;
  return (w / m.unitsPerEm) * REF;
};

// ---- layout --------------------------------------------------------------------------------------------
const EMOJI_H = 1.15; // em
const EMOJI_ASPECT = 136 / 128;

export interface LayoutOpts {
  text: string;
  font: FontKey;
  baseSize: number; // px, before scale
  scale: number;
  maxWidth: number; // frame width, px
  measure: Measurer;
}
export interface LaidLine {
  items: { piece: Piece; x: number; w: number }[];
  width: number;
}
export interface Layout {
  font: FontKey;
  fontSize: number;
  lines: LaidLine[];
  lineHeight: number;
  textWidth: number;
  measurements: number;
}

export function layoutText(o: LayoutOpts): Layout {
  const words = tokenise(o.text);
  let count = 0;
  const m: Measurer = (t, f) => {
    count++;
    return o.measure(t, f);
  };
  const pieceW = (p: Piece, size: number): number =>
    p.kind === "text" ? (m(p.text, o.font) * size) / REF : size * EMOJI_H * EMOJI_ASPECT;
  const wordW = (w: Word, size: number): number => w.pieces.reduce((a, p) => a + pieceW(p, size), 0);
  const spaceW = (size: number): number => (m(" ", o.font) * size) / REF;
  const fit = o.maxWidth * 0.86;

  let size = o.baseSize * o.scale;
  let split = words.length; // number of words on line 1
  for (let pass = 0; pass < 3; pass++) {
    const ws = words.map((w) => wordW(w, size));
    const sp = spaceW(size);
    const lineW = (a: number, b: number): number => ws.slice(a, b).reduce((x, y) => x + y, 0) + sp * Math.max(0, b - a - 1);
    let best = Infinity;
    split = words.length;
    if (lineW(0, words.length) > fit && words.length > 1) {
      for (let k = 1; k < words.length; k++) {
        const worst = Math.max(lineW(0, k), lineW(k, words.length));
        if (worst < best) {
          best = worst;
          split = k;
        }
      }
    } else best = lineW(0, words.length);
    if (best <= fit) break;
    size = Math.floor(size * (fit / best) * 0.995);
  }
  const sp = spaceW(size);
  const mk = (ws: Word[]): LaidLine => {
    const items: LaidLine["items"] = [];
    let x = 0;
    ws.forEach((w, i) => {
      if (i > 0) x += sp;
      for (const p of w.pieces) {
        const pw = pieceW(p, size);
        items.push({ piece: p, x, w: pw });
        x += pw;
      }
    });
    return { items, width: x };
  };
  const lines = split >= words.length ? [mk(words)] : [mk(words.slice(0, split)), mk(words.slice(split))];
  return { font: o.font, fontSize: size, lines, lineHeight: size * 1.2, textWidth: Math.max(...lines.map((l) => l.width)), measurements: count };
}

// ---- SVG -----------------------------------------------------------------------------------------------
export interface LayerSvg {
  svg: string;
  width: number;
  height: number;
  images: { href: string; png: Uint8Array }[];
}

export function layerSvg(l: Layout, style: Style): LayerSvg {
  const f = FONTS[l.font];
  const size = l.fontSize;
  const met = metricsFor(l.font);
  const asc = (met.ascender / met.unitsPerEm) * size;
  const desc = (met.descender / met.unitsPerEm) * size;
  const padX = style === "pill" ? size * 0.5 : size * 0.3;
  const padY = style === "pill" ? size * 0.3 : size * 0.25;
  const W = Math.ceil(l.textWidth + padX * 2);
  const H = Math.ceil(l.lineHeight * l.lines.length + padY * 2);
  const images: LayerSvg["images"] = [];
  let body = "";
  const fam = `font-family="${esc(f.family)}" font-weight="${f.weight}" font-size="${size.toFixed(2)}"`;
  const paint =
    style === "pill"
      ? `fill="#111111"`
      : style === "outline"
        ? `fill="#ffffff" stroke="#000000" stroke-width="${Math.max(2, Math.round(size * 0.12)).toFixed(0)}" stroke-linejoin="round" paint-order="stroke fill"`
        : `fill="#ffffff"`;
  l.lines.forEach((line, li) => {
    const base = padY + li * l.lineHeight + (l.lineHeight - (asc - desc)) / 2 + asc;
    const x0 = (W - line.width) / 2;
    for (const it of line.items) {
      const x = (x0 + it.x).toFixed(2);
      if (it.piece.kind === "text") {
        body += `<text x="${x}" y="${base.toFixed(2)}" ${fam} ${paint} xml:space="preserve">${esc(it.piece.text)}</text>`;
      } else {
        const png = emojiSet().get(it.piece.cps)!;
        const href = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
        images.push({ href, png });
        const h = size * EMOJI_H;
        body += `<image x="${x}" y="${(base - h * 0.82).toFixed(2)}" width="${it.w.toFixed(2)}" height="${h.toFixed(2)}" href="${href}"/>`;
      }
    }
  });
  let inner = body;
  if (style === "pill") {
    inner = `<rect width="${W}" height="${H}" rx="${(size * 0.45).toFixed(1)}" fill="#ffffff"/>` + body;
  } else if (style === "shadow") {
    const sd = Math.max(2, size * 0.06).toFixed(2);
    inner = `<defs><filter id="s" x="-20%" y="-20%" width="140%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="${sd}"/><feOffset dx="0" dy="${(size * 0.05).toFixed(2)}" result="b"/><feFlood flood-color="#000000" flood-opacity="0.75"/><feComposite in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g filter="url(#s)">${body}</g>`;
  }
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`,
    width: W,
    height: H,
    images,
  };
}

export function rasterise(layer: LayerSvg, font: FontKey, background?: string): Uint8Array {
  const r = new Resvg(layer.svg, {
    background,
    font: { fontBuffers: fontBuffers(font, "none"), defaultFontFamily: FONTS[font].family },
    shapeRendering: 2,
    textRendering: 1,
  });
  try {
    const img = r.render();
    const png = img.asPng();
    img.free();
    return png;
  } finally {
    r.free();
  }
}
