// Q3 determinism + Q4 layout cost/accuracy + Q1 timings. Runs under bun and (bundled) Electron's Node.
import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-wasm";
import { FONTS, fontBuffers, initResvg, type FontKey, type Style } from "./common";
import { emojiSet, layerSvg, layoutText, measureBbox, measureSfnt, rasterise } from "./layout";

const rt = process.versions.electron ? "electron" : "bun";
const h = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 16);
const keys = Object.keys(FONTS) as FontKey[];
const styles: Style[] = ["pill", "outline", "shadow"];
const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const ms = (n: number): string => n.toFixed(2);

await initResvg();
const t0 = performance.now();
emojiSet();
console.log(`[${rt}] emoji CBDT index (cmap+GSUB+CBLC parse) ${ms(performance.now() - t0)} ms, ${emojiSet().count} bitmaps, ${emojiSet().totalPngBytes} PNG bytes`);

// ---- determinism ---------------------------------------------------------------------------------------
const text = "Beach day 🌴✨ with 👩‍👩‍👧 and 👍🏽";
for (const style of styles) {
  const hashes = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const l = layoutText({ text, font: "manrope", baseSize: 56, scale: 1, maxWidth: 1080, measure: measureBbox });
    hashes.add(h(rasterise(layerSvg(l, style), "manrope")));
  }
  console.log(`[${rt}] determinism ${style.padEnd(7)} 20 renders -> ${hashes.size} distinct hash(es): ${[...hashes].join(",")}`);
}
const all: string[] = [];
for (const k of keys) for (const s of styles) all.push(h(rasterise(layerSvg(layoutText({ text, font: k, baseSize: 56, scale: 1, maxWidth: 1080, measure: measureBbox }), s), k)));
console.log(`[${rt}] cross-runtime fingerprint (15 layers): ${h(new TextEncoder().encode(all.join()))}`);

// ---- layout accuracy: sfnt advances vs resvg bbox -------------------------------------------------------
const samples = ["Beach day", "Pack light. Travel far.", "Wait for it... AV To Ty We fi fl", "Top 10 spots in Lisbon", "“Quoted” – dash — and … ellipsis ’"];
console.log(`[${rt}] width at 100 px, bbox vs sfnt-sum (no kerning):`);
for (const k of keys) {
  const row = samples.map((s) => {
    const a = measureBbox(s, k);
    const b = measureSfnt(s, k);
    return `${(((b - a) / a) * 100).toFixed(1)}%`;
  });
  console.log(`  ${k.padEnd(8)} sfnt-vs-bbox error: ${row.join("  ")}`);
}

// ---- layout cost (cold = empty measure cache, warm = cached word widths) --------------------------------
const captions = [
  "Beach day",
  "Pack light. Travel far. Never look back.",
  "Weekend in Lisbon 🌴✨ tram rides and pastel de nata",
  "A very long caption that needs wrapping to two lines, sixty chars",
];
for (const cap of captions) {
  const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(cap)].length;
  const cold: number[] = [];
  const coldSfnt: number[] = [];
  let lay = layoutText({ text: cap, font: "manrope", baseSize: 56, scale: 1, maxWidth: 1080, measure: measureSfnt });
  for (let i = 0; i < 15; i++) {
    const a = performance.now();
    lay = layoutText({ text: cap, font: keys[i % 5]!, baseSize: 56, scale: 1, maxWidth: 1080, measure: measureSfnt });
    coldSfnt.push(performance.now() - a);
  }
  // cold bbox: no measure cache at all, so every word is measured again
  for (let i = 0; i < 15; i++) {
    const a = performance.now();
    lay = layoutText({ text: cap, font: keys[i % 5]!, baseSize: 56, scale: 1, maxWidth: 1080, measure: measureBboxNoCache });
    cold.push(performance.now() - a);
  }
  const warm: number[] = [];
  for (let i = 0; i < 15; i++) {
    const a = performance.now();
    lay = layoutText({ text: cap, font: "manrope", baseSize: 56, scale: 1, maxWidth: 1080, measure: measureBbox });
    warm.push(performance.now() - a);
  }
  const svgT: number[] = [];
  const rasT: number[] = [];
  let layer = layerSvg(lay, "pill");
  for (let i = 0; i < 15; i++) {
    const a = performance.now();
    layer = layerSvg(lay, styles[i % 3]!);
    const b = performance.now();
    rasterise(layer, "manrope");
    rasT.push(performance.now() - b);
    svgT.push(b - a);
  }
  console.log(
    `[${rt}] "${cap.slice(0, 28)}…" ${graphemes}g -> ${lay.lines.length} line(s), size ${lay.fontSize}px, layer ${layer.width}x${layer.height}; ` +
      `layout: bbox cold ${ms(med(cold))} ms (${lay.measurements} measures), bbox warm ${ms(med(warm))} ms, sfnt ${ms(med(coldSfnt))} ms; ` +
      `svg ${ms(med(svgT))} ms; rasterise ${ms(med(rasT))} ms`,
  );
}

// full-frame alternative: rasterise a 1080x1920 canvas with one caption
{
  const lay = layoutText({ text: captions[2]!, font: "manrope", baseSize: 56, scale: 1, maxWidth: 1080, measure: measureBbox });
  const layer = layerSvg(lay, "pill");
  const framed = layer.svg.replace(/^<svg[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920"><g transform="translate(${(1080 - layer.width) / 2} 1300)">`).replace("</svg>", "</g></svg>");
  let bytes = 0;
  const fullT: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = performance.now();
    const rr = new Resvg(framed, { font: { fontBuffers: fontBuffers("manrope", "none"), defaultFontFamily: "Manrope" } });
    const img = rr.render();
    bytes = img.asPng().length;
    fullT.push(performance.now() - a);
  }
  console.log(`[${rt}] full 1080x1920 transparent frame with one pill caption: ${ms(med(fullT))} ms, ${bytes} B PNG (vs tight layer ${layer.width}x${layer.height})`);
}

function measureBboxNoCache(t: string, f: FontKey): number {
  const fam = FONTS[f];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="200"><text x="0" y="150" font-family="${fam.family}" font-weight="${fam.weight}" font-size="100" xml:space="preserve">|${t.replace(/&/g, "&amp;").replace(/</g, "&lt;")}|</text></svg>`;
  const r = new Resvg(svg, { font: { fontBuffers: fontBuffers(f, "none"), defaultFontFamily: fam.family } });
  const w = r.getBBox()?.width ?? 0;
  r.free();
  return w;
}
