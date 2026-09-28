// Q5: SVG escaping and inertness, plus fit accuracy and charset coverage. Plain asserts; exits 1 on failure.
import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-wasm";
import { FONTS, fontBuffers, initResvg, metricsFor, type FontKey } from "./common";
import { emojiSet, layerSvg, layoutText, measureBbox, rasterise } from "./layout";

await initResvg();
let failed = 0;
const check = (name: string, ok: boolean, extra = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 12);
const lay = (text: string, font: FontKey = "manrope") => layoutText({ text, font, baseSize: 56, scale: 1, maxWidth: 1080, measure: measureBbox });

// 1. hostile markup stays character data
const hostile = `<b>&amp; "q" 'x' </text><rect width="9999" height="9999" fill="red"/><image href="file:///etc/passwd"/>`;
const l1 = lay(hostile);
const s1 = layerSvg(l1, "pill");
const rects = (s1.svg.match(/<rect/g) ?? []).length;
const images = (s1.svg.match(/<image/g) ?? []).length;
check("hostile text adds no elements (1 template rect, 0 images)", rects === 1 && images === 0, `rects=${rects} images=${images}`);
check("no raw < or > inside any text node", [...s1.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].every((m) => !m[1]!.includes(">")));
check("escaped forms present (one <text> per word)", ["&lt;b&gt;&amp;amp;", "&quot;q&quot;", "&apos;x&apos;", "&lt;/text&gt;&lt;rect"].every((f) => s1.svg.includes(f)));
const png1 = rasterise(s1, "manrope");
check("hostile text rasterises (valid PNG)", png1[0] === 0x89 && png1[1] === 0x50);
// the visible glyphs really are the literal characters: same text with only the markup chars removed must differ and be narrower
check("markup characters are drawn as glyphs (`<b>` wider than `b`)", measureBbox("<b>", "manrope") > 2 * measureBbox("b", "manrope"), `${measureBbox("<b>", "manrope").toFixed(0)} vs ${measureBbox("b", "manrope").toFixed(0)} at 100 px`);

// 2. each special character alone
for (const ch of ["<", ">", "&", '"', "'", "&lt;", "]]>", "<!--", "<?xml"]) {
  const s = layerSvg(lay(`a ${ch} b`), "outline");
  let ok = true;
  try {
    const p = rasterise(s, "manrope");
    ok = p.length > 100;
  } catch {
    ok = false;
  }
  check(`renders ${JSON.stringify(ch)} as text`, ok);
}

// 3. control characters are invalid XML 1.0: resvg refuses them, so the caption rules (printable only) must
let threw = false;
try {
  rasterise(layerSvg(lay("a\u0001b"), "pill"), "manrope");
} catch {
  threw = true;
}
check("a raw control char makes resvg throw (caption rules must refuse it upstream)", threw);

// 4. emoji ZWJ sequences, skin tones, flags, keycaps
for (const [name, e] of Object.entries({ zwjFamily: "👩‍👩‍👧", zwjTech: "🧑🏽‍💻", skin: "👍🏽", flag: "🇺🇦", keycap: "1️⃣", heart: "❤️", rainbow: "🏳️‍🌈" })) {
  const l = lay(`x ${e} y`);
  const emojis = l.lines.flatMap((li) => li.items).filter((i) => i.piece.kind === "emoji");
  check(`emoji ${name} is ONE bitmap`, emojis.length === 1, `emoji pieces=${emojis.length}`);
}
check("an emoji the font lacks is refused (not silently dropped)", (() => { try { lay("x \u{1FAE9}\u{1FAE9}\u{1FAE9} y"); return emojiSet().has([0x1fae9]); } catch { return true; } })());
check("youth emoji still resolves in the font (the deny-list is the caption rules' job)", emojiSet().has([0x1f476]));

// 5. fit: rasterised ink width vs the layout's textWidth, both against the 86% target
for (const cap of ["Pack light. Travel far. Never look back.", "Weekend in Lisbon 🌴✨ tram rides and pastel de nata", "Wide W W W W W W W W W W W W W W W W W W W W", "Supercalifragilisticexpialidocious_and_more_unbreakable_text"]) {
  for (const font of Object.keys(FONTS) as FontKey[]) {
    const l = lay(cap, font);
    const s = layerSvg(l, "shadow");
    const r = new Resvg(s.svg, { font: { fontBuffers: fontBuffers(font, "none"), defaultFontFamily: FONTS[font].family } });
    const real = r.getBBox()?.width ?? 0; // resvg's own ink width of the finished layer (includes the shadow-free text and emoji)
    r.free();
    check(`fit ${font.padEnd(8)} "${cap.slice(0, 20)}"`, real <= 1080 * 0.86 + 1 && l.lines.length <= 2, `layout ${l.textWidth.toFixed(0)}, resvg ${real.toFixed(0)} / ${(1080 * 0.86).toFixed(0)}, size ${l.fontSize}, lines ${l.lines.length}`);
  }
}

// 6. cmap coverage of the caption charset (invariant 22) for the 5 fonts
const charset: number[] = [];
for (let c = 0x20; c <= 0x7e; c++) charset.push(c);
charset.push(0x2019, 0x2018, 0x201c, 0x201d, 0x2013, 0x2014, 0x2026);
for (const k of Object.keys(FONTS) as FontKey[]) {
  const m = metricsFor(k);
  const missing = charset.filter((c) => m.gid(c) === 0).map((c) => "U+" + c.toString(16).toUpperCase());
  check(`cmap covers the caption charset: ${k}`, missing.length === 0, missing.join(" "));
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed", sha(png1));
process.exit(failed ? 1 : 0);
