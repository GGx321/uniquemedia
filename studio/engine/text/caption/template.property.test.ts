import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { openEmojiFont, type EmojiFont } from "../emoji/emojiFont";
import { loadPinnedEmojiFont } from "../emoji/emojiFont.testkit";
import { TEXT_FONT_KEYS, type TextFontKey } from "../fonts";
import { createTextRasteriser, RASTER_WASM, type TextRasteriser } from "../rasteriser";
import { layoutCaption } from "./layout";
import { decodePng } from "./png.testkit";
import { createCaptionRenderer } from "./renderer";
import { buildCaptionSvg, measureSvg } from "./template";
useNativeGlobals();

// Invariant 17, as a property (plan 3b.4b): however a caption is made of markup, it stays character data. Random captions built
// from the pieces an attacker, or a person, would try are pushed through the template, and through the real resvg.

const FONT_DIR = join(import.meta.dir, "..", "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);
const STYLES = ["none", "plaque", "outline"] as const;

const PIECES = [
  "<",
  ">",
  "&",
  '"',
  "'",
  "]]>",
  "<!--",
  "-->",
  "<?xml",
  "?>",
  "<![CDATA[",
  '<!DOCTYPE a [<!ENTITY x "y">]>&x;',
  "&x;",
  "&amp;",
  "&#60;",
  "url(#e0)",
  "url(http://x/y)",
  "href=",
  'href="file:///etc/passwd"',
  "xlink:href=",
  "<script>alert(1)</script>",
  "</text>",
  '<image href="data:image/png;base64,AAAA"/>',
  '<use href="#e0"/>',
  '<rect width="9999" height="9999"/>',
  "<b>",
  "[",
  "f",
  "j",
  "hello",
  "a",
  "W",
  " ",
  "\n",
  "\r\n",
];

function random(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** Up to `limit` characters made of the pieces, at most one line break (a caption has at most two lines), never empty or blank. */
function caption(next: () => number, limit: number): string {
  let text = "";
  let breaks = 0;
  while (text.length < 1 + Math.floor(next() * limit)) {
    let piece = PIECES[Math.floor(next() * PIECES.length)] ?? "a";
    if (piece === "\n" || piece === "\r\n") {
      if (breaks > 0) piece = " ";
      else breaks++;
    }
    if (text.length + piece.length > limit) break;
    text += piece;
  }
  return text.trim() === "" ? "x" : text;
}

const unescape = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const ALLOWED = new Set(["svg", "defs", "filter", "feGaussianBlur", "feOffset", "feFlood", "feComposite", "feMerge", "feMergeNode", "rect", "g", "text", "image", "use"]);

let rasteriser: TextRasteriser;
let emoji: EmojiFont;
beforeAll(async () => {
  rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
  await rasteriser.init();
  emoji = openEmojiFont(await loadPinnedEmojiFont());
});

describe("the template, for random markup-laden captions", () => {
  test("only the template's own tags, one <text> per laid text piece whose text is exactly the caption's, and only engine-built hrefs and url()", () => {
    const next = random(20260930);
    for (let round = 0; round < 400; round++) {
      const value = caption(next, 140);
      const style = STYLES[Math.floor(next() * 3)] ?? "plaque";
      const layout = layoutCaption({ text: value, scale: 0.5 + next() * 1.5, measure: (run) => run.length * 60, emojiAspect: () => 1 });
      const { svg } = buildCaptionSvg({ layout, font: "manrope", style, color: "#ffd166", metrics: { unitsPerEm: 2000, ascender: 2132, descender: -600 }, emoji: () => ({ key: 1, base64: "QUJD" }) });

      const tags = [...svg.matchAll(/<([A-Za-z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1] ?? "");
      expect(tags.filter((tag) => !ALLOWED.has(tag)), JSON.stringify(value)).toEqual([]);

      const nodes = [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => unescape(m[1] ?? ""));
      const laid = layout.lines.flatMap((line) => line.items.flatMap((item) => (item.kind === "text" ? [item.text] : [])));
      expect(nodes, JSON.stringify(value)).toEqual(laid);
      expect(nodes.join("").replace(/\s/g, ""), JSON.stringify(value)).toBe(value.replace(/\s/g, ""));

      // The caption's own words are text nodes, where `url(#e0)` or `href=` are just characters: look at the markup around them.
      const markup = svg.replace(/(<text [^>]*>)[^<]*(<\/text>)/g, "$1$2");
      for (const [, href] of markup.matchAll(/href="([^"]*)"/g)) expect(href).toMatch(/^(?:data:image\/png;base64,[A-Za-z0-9+/=]+|#e\d+)$/);
      for (const [, target] of markup.matchAll(/url\(([^)]*)\)/g)) expect(target).toBe("#s");
      expect(markup.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/file:|https?:|xlink|<!|<\?|\]\]>/);
      expect(count(svg, "rect")).toBe(style === "plaque" ? 1 : 0);
      expect(count(svg, "image")).toBe(0);
    }
  });

  test("the whole hostile strings of the review are inert", () => {
    for (const value of ['x\r\n<![CDATA[', '<!DOCTYPE a [<!ENTITY x "y">]>&x;', 'url(#e0) href="file:///etc/passwd" <image href="x"/>', "]]><!-- <?xml"]) {
      const layout = layoutCaption({ text: value, scale: 1, measure: (run) => run.length * 60, emojiAspect: () => 1 });
      const { svg } = buildCaptionSvg({ layout, font: "caveat", style: "outline", color: "#ffffff", metrics: { unitsPerEm: 1000, ascender: 960, descender: -300 }, emoji: () => ({ key: 1, base64: "QUJD" }) });
      expect([...svg.matchAll(/<([A-Za-z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]).filter((tag) => !ALLOWED.has(tag ?? ""))).toEqual([]);
      expect(svg).not.toContain("<![CDATA[");
      expect(svg).not.toContain("<!DOCTYPE");
    }
  });
});

function count(svg: string, tag: string): number {
  return [...svg.matchAll(/<([A-Za-z][A-Za-z0-9]*)[\s/>]/g)].filter((m) => m[1] === tag).length;
}

describe("the same captions through the real resvg", () => {
  test("each draws, and its ink is inside its box", async () => {
    const next = random(20260931);
    const renderer = createCaptionRenderer({ rasteriser, emoji });
    for (let round = 0; round < 150; round++) {
      const value = caption(next, 58);
      const font: TextFontKey = TEXT_FONT_KEYS[Math.floor(next() * TEXT_FONT_KEYS.length)] ?? "manrope";
      const { png } = await renderer.render({ value, font, style: "outline", color: "#ffffff", scale: 0.5 + next() * 1.5 });
      const image = decodePng(png);
      let edge = 0;
      for (let y = 0; y < image.height; y++) for (const x of [0, image.width - 1]) edge += (image.data[(y * image.width + x) * 4 + 3] ?? 0) > 2 ? 1 : 0;
      for (let x = 0; x < image.width; x++) for (const y of [0, image.height - 1]) edge += (image.data[(y * image.width + x) * 4 + 3] ?? 0) > 2 ? 1 : 0;
      expect(edge, `${font} ${JSON.stringify(value)}`).toBe(0);
    }
  }, 120_000);

  test("markup is drawn as glyphs: <b> is wider than b", () => {
    for (const font of TEXT_FONT_KEYS) {
      const wide = rasteriser.measure({ svg: measureSvg(font, "<b>"), font })?.width ?? 0;
      const narrow = rasteriser.measure({ svg: measureSvg(font, "b"), font })?.width ?? 0;
      expect(wide, font).toBeGreaterThan(narrow * 1.5);
    }
  });

  test("a caption of nothing but markup draws something and adds no shape of its own: one plaque, nothing else opaque outside it", async () => {
    const renderer = createCaptionRenderer({ rasteriser, emoji });
    const { png, width, height } = await renderer.render({ value: '<rect width="9999" height="9999" fill="red"/>', font: "manrope", style: "plaque", color: "#ffffff", scale: 1 });
    const image = decodePng(png);
    expect(width).toBeLessThanOrEqual(1080);
    let red = 0;
    for (let i = 0; i < image.data.length; i += 4) if ((image.data[i] ?? 0) > 200 && (image.data[i + 1] ?? 255) < 60 && (image.data[i + 2] ?? 255) < 60 && (image.data[i + 3] ?? 0) > 200) red++;
    expect(red).toBe(0);
    expect(height).toBeLessThanOrEqual(600);
  });
});
