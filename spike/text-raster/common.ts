// Shared helpers: load the wasm from disk (no fetch), load fonts, build the fixed SVG template.
// Runs unchanged under bun and under `ELECTRON_RUN_AS_NODE=1 electron` (plain ESM + node:* only).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { readMetrics, type FontMetrics } from "./sfnt";

const here = dirname(fileURLToPath(import.meta.url));
/** Walks up from this file (or its bundle in .cache/text-raster/dist) until `rel` exists. */
function findUp(rel: string): string {
  for (let d = here; ; d = dirname(d)) {
    if (existsSync(join(d, rel))) return join(d, rel);
    if (dirname(d) === d) throw new Error(`not found: ${rel}`);
  }
}
export const cacheDir = findUp(join(".cache", "text-raster"));
export const outDir = join(cacheDir, "out");

export const FONTS = {
  manrope: { family: "Manrope", weight: 800, file: "Manrope-800.ttf" },
  playfair: { family: "Playfair Display", weight: 600, file: "PlayfairDisplay-600.ttf" },
  oswald: { family: "Oswald", weight: 600, file: "Oswald-600.ttf" },
  ptmono: { family: "PT Mono", weight: 400, file: "PTMono-400.ttf" },
  caveat: { family: "Caveat", weight: 600, file: "Caveat-600.ttf" },
} as const;
export type FontKey = keyof typeof FONTS;
export type Style = "pill" | "outline" | "shadow";

export type EmojiFormat = "colrv1" | "cbdt" | "none";
const emojiFile: Record<EmojiFormat, string | null> = {
  colrv1: join(cacheDir, "src", "Noto-COLRv1.ttf"),
  cbdt: join(cacheDir, "src", "NotoColorEmoji-CBDT.ttf"),
  none: null,
};

let inited = false;
export async function initResvg(): Promise<{ wasmBytes: number; initMs: number }> {
  const wasmPath = findUp(join("spike", "text-raster", "node_modules", "@resvg", "resvg-wasm", "index_bg.wasm"));
  const t0 = performance.now();
  const bytes = readFileSync(wasmPath);
  // Same shape as studio/engine/decode: read from disk, compile, hand the Module in. No fetch.
  const mod = await WebAssembly.compile(bytes);
  if (!inited) await initWasm(mod);
  inited = true;
  return { wasmBytes: bytes.length, initMs: performance.now() - t0 };
}

const fontBufCache = new Map<string, Uint8Array>();
export function loadFontBuf(path: string): Uint8Array {
  let b = fontBufCache.get(path);
  if (!b) {
    b = new Uint8Array(readFileSync(path));
    fontBufCache.set(path, b);
  }
  return b;
}

/** Font buffers for one render: the chosen text font, plus optionally the emoji font. */
export function fontBuffers(key: FontKey, emoji: EmojiFormat): Uint8Array[] {
  const bufs = [loadFontBuf(join(cacheDir, "fonts", FONTS[key].file))];
  const e = emojiFile[emoji];
  if (e) bufs.push(loadFontBuf(e));
  return bufs;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface TemplateOpts {
  lines: string[];
  font: FontKey;
  style: Style;
  fontSize: number;
  width: number;
  height: number;
  padX?: number;
  padY?: number;
}

const LINE_H = 1.2;

const metricsCache = new Map<FontKey, FontMetrics>();
export function metricsFor(key: FontKey): FontMetrics {
  let m = metricsCache.get(key);
  if (!m) {
    m = readMetrics(loadFontBuf(join(cacheDir, "fonts", FONTS[key].file)));
    metricsCache.set(key, m);
  }
  return m;
}

/** The fixed SVG template: text only as escaped character data, no href, no external resources. */
export function buildSvg(o: TemplateOpts): string {
  const f = FONTS[o.font];
  const padX = o.padX ?? Math.round(o.fontSize * 0.5);
  const padY = o.padY ?? Math.round(o.fontSize * 0.3);
  const lh = o.fontSize * LINE_H;
  const textH = lh * o.lines.length;
  const boxW = o.width;
  const boxH = Math.ceil(textH + padY * 2);
  const cx = boxW / 2;
  const m = metricsFor(o.font);
  const asc = (m.ascender / m.unitsPerEm) * o.fontSize;
  const desc = (m.descender / m.unitsPerEm) * o.fontSize; // negative
  const firstBase = padY + (lh - (asc - desc)) / 2 + asc;
  const tspans = o.lines
    .map((l, i) => `<tspan x="${cx}" y="${(firstBase + i * lh).toFixed(2)}">${esc(l)}</tspan>`)
    .join("");
  const fam = `font-family="${esc(f.family)}" font-weight="${f.weight}" font-size="${o.fontSize}" text-anchor="middle"`;
  let body: string;
  if (o.style === "pill") {
    body =
      `<rect x="0" y="0" width="${boxW}" height="${boxH}" rx="${Math.round(o.fontSize * 0.45)}" fill="#ffffff"/>` +
      `<text ${fam} fill="#111111">${tspans}</text>`;
  } else if (o.style === "outline") {
    body = `<text ${fam} fill="#ffffff" stroke="#000000" stroke-width="${Math.max(2, Math.round(o.fontSize * 0.12))}" stroke-linejoin="round" paint-order="stroke fill">${tspans}</text>`;
  } else {
    body =
      `<defs><filter id="s" x="-10%" y="-10%" width="120%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="${Math.max(2, o.fontSize * 0.06)}"/><feOffset dx="0" dy="${Math.round(o.fontSize * 0.05)}" result="b"/><feFlood flood-color="#000" flood-opacity="0.75"/><feComposite in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
      `<g filter="url(#s)"><text ${fam} fill="#ffffff">${tspans}</text></g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}" viewBox="0 0 ${boxW} ${boxH}">${body}</svg>`;
}

export function render(svg: string, font: FontKey, emoji: EmojiFormat, background?: string): { png: Uint8Array; w: number; h: number } {
  const r = new Resvg(svg, {
    background,
    font: {
      fontBuffers: fontBuffers(font, emoji),
      defaultFontFamily: FONTS[font].family,
      defaultFontSize: 40,
    },
    shapeRendering: 2,
    textRendering: 1,
  });
  try {
    const img = r.render();
    const png = img.asPng();
    const out = { png, w: img.width, h: img.height };
    img.free();
    return out;
  } finally {
    r.free();
  }
}

export async function sha(buf: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}
