import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { captionIssue } from "../captionRules";
import { openEmojiFont, type EmojiFont } from "../emoji/emojiFont";
import { loadEmojiTest, loadPinnedEmojiFont } from "../emoji/emojiFont.testkit";
import { segmentCaption } from "../emoji/segment";
import { TEXT_FONT_KEYS, type TextFontKey } from "../fonts";
import { createTextRasteriser, RASTER_WASM, RasterError, type TextRasteriser } from "../rasteriser";
import { layoutCaption } from "./layout";
import { decodePng, extent, countPixels, pixel } from "./png.testkit";
import { createCaptionRenderer, type CaptionRequest } from "./renderer";
import { buildCaptionSvg } from "./template";
useNativeGlobals();

// The renderer with the REAL resvg-wasm and the REAL emoji reader, in this process (no worker: the worker's own
// behaviour is worker/textCaption.real.node-test.ts's). It reads the pixels back, so what is asserted is what a viewer sees.

const FONT_DIR = join(import.meta.dir, "..", "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);

let rasteriser: TextRasteriser;
let emoji: EmojiFont;
beforeAll(async () => {
  rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
  await rasteriser.init();
  emoji = openEmojiFont(await loadPinnedEmojiFont());
});

const request = (over: Partial<CaptionRequest> = {}): CaptionRequest => ({ value: "sunday reset", font: "manrope", style: "plaque", color: "#ffffff", scale: 1, ...over });
const renderer = () => createCaptionRenderer({ rasteriser, emoji });
/** A single code point the caption rules take as one emoji the font draws (so a caption of them is legal). */
const captionRulesAccept = (sequence: string): boolean => captionIssue(sequence, { hasEmoji: (codePoints) => emoji.has(codePoints) }) === null;
const opaque = (r: number, g: number, b: number, a: number) => a === 255 && r === g && g === b;

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; captionIssue: string | undefined } | "not a RasterError"> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error instanceof RasterError ? { code: error.code, captionIssue: error.captionIssue } : "not a RasterError";
}

describe("what it returns", () => {
  test("a PNG whose pixel size is the box it reports", async () => {
    const result = await renderer().render(request());
    const image = decodePng(result.png);
    expect(image.width).toBe(result.width);
    expect(image.height).toBe(result.height);
    expect(result.layout.width).toBe(result.width);
    expect(result.layout.height).toBe(result.height);
  });

  test("the resolved layout: size in pixels and what each line says", async () => {
    const { layout } = await renderer().render(request({ value: "one\r\ntwo", scale: 1.5 }));
    expect(layout.fontSize).toBe(84);
    expect(layout.lines).toEqual(["one", "two"]);
  });

  test("the same caption twice is the same bytes", async () => {
    const a = await renderer().render(request({ value: "hello \u{1F600}", style: "none" }));
    const b = await renderer().render(request({ value: "hello \u{1F600}", style: "none" }));
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
  });

  test.each([...TEXT_FONT_KEYS])("%s draws in every style", async (font: TextFontKey) => {
    for (const style of ["none", "plaque", "outline"] as const) {
      const result = await renderer().render(request({ font, style }));
      expect(countPixels(decodePng(result.png), (_r, _g, _b, a) => a > 0)).toBeGreaterThan(100);
    }
  });

  test("the box is never wider than the frame or over the canvas budget at the widest text and largest scale", async () => {
    for (const style of ["none", "plaque", "outline"] as const) {
      const result = await renderer().render(request({ value: "W".repeat(30) + " " + "W".repeat(29), scale: 2, style, font: "ptmono" }));
      expect(result.width).toBeLessThanOrEqual(1080);
      expect(result.width * result.height).toBeLessThanOrEqual(1080 * 600);
    }
  });
});

describe("the three styles", () => {
  test("the plaque is the colour, opaque, with rounded corners and text in the contrasting ink", async () => {
    const { png, width, height } = await renderer().render(request({ style: "plaque", color: "#ffd166" }));
    const image = decodePng(png);
    expect(pixel(image, Math.floor(width / 2), 1)).toEqual([0xff, 0xd1, 0x66, 255]);
    expect(pixel(image, 0, 0)[3]).toBe(0);
    expect(pixel(image, width - 1, height - 1)[3]).toBe(0);
    expect(countPixels(image, (r, g, b, a) => a === 255 && r === 0x11 && g === 0x11 && b === 0x11)).toBeGreaterThan(200);
  });

  test("a dark plaque gets white text", async () => {
    const image = decodePng((await renderer().render(request({ style: "plaque", color: "#111111" }))).png);
    expect(countPixels(image, (r, g, b, a) => a === 255 && r === 255 && g === 255 && b === 255)).toBeGreaterThan(200);
  });

  test("the outline is a black stroke around white text, with nothing behind it", async () => {
    const { png } = await renderer().render(request({ style: "outline", color: "#ffffff" }));
    const image = decodePng(png);
    expect(pixel(image, 0, 0)[3]).toBe(0);
    expect(countPixels(image, (r, g, b, a) => a === 255 && r < 8 && g < 8 && b < 8)).toBeGreaterThan(200);
    expect(countPixels(image, (r, g, b, a) => a === 255 && r > 247 && g > 247 && b > 247)).toBeGreaterThan(200);
  });

  test("a dark text colour turns the outline white", async () => {
    const image = decodePng((await renderer().render(request({ style: "outline", color: "#111111" }))).png);
    expect(countPixels(image, (r, g, b, a) => a === 255 && r > 247 && g > 247 && b > 247)).toBeGreaterThan(200);
    expect(countPixels(image, (r, g, b, a) => a === 255 && r === 0x11 && g === 0x11 && b === 0x11)).toBeGreaterThan(200);
  });

  test("the background-less style is text over a soft shadow that fades out before the box's edge", async () => {
    const { png, width, height } = await renderer().render(request({ style: "none", color: "#ffffff" }));
    const image = decodePng(png);
    expect(countPixels(image, (r, g, b, a) => a > 10 && a < 200 && r < 16 && g < 16 && b < 16)).toBeGreaterThan(300);
    expect(pixel(image, 0, 0)[3]).toBeLessThan(3);
    expect(pixel(image, width - 1, height - 1)[3]).toBeLessThan(3);
    expect(pixel(image, Math.floor(width / 2), 0)[3]).toBeLessThan(3);
    expect(pixel(image, Math.floor(width / 2), height - 1)[3]).toBeLessThan(3);
  });

  test("the shadow is nowhere cut off by the box: every edge of the box is nearly clear", async () => {
    const { png, width, height } = await renderer().render(request({ style: "none", value: "W".repeat(28), scale: 2, font: "ptmono" }));
    const image = decodePng(png);
    let worst = 0;
    for (let x = 0; x < width; x++) worst = Math.max(worst, pixel(image, x, 0)[3], pixel(image, x, height - 1)[3]);
    for (let y = 0; y < height; y++) worst = Math.max(worst, pixel(image, 0, y)[3], pixel(image, width - 1, y)[3]);
    expect(worst).toBeLessThan(6);
  });

  test("a dark text colour turns the shadow light", async () => {
    const image = decodePng((await renderer().render(request({ style: "none", color: "#111111" }))).png);
    expect(countPixels(image, (r, g, b, a) => a > 10 && a < 200 && r > 240 && g > 240 && b > 240)).toBeGreaterThan(300);
  });
});

describe("the measuring agrees with the drawing", () => {
  test.each([...TEXT_FONT_KEYS])("%s: the ink of a one-line caption is as wide as the layout says, within a few percent", async (font: TextFontKey) => {
    const { png, layout } = await renderer().render(request({ value: "Sunday reset, slow mornings", font, style: "outline", color: "#ffffff" }));
    const ink = extent(decodePng(png), (r, g, b, a) => a === 255 && r > 240 && g > 240 && b > 240);
    expect(ink).not.toBeNull();
    const inked = (ink?.right ?? 0) - (ink?.left ?? 0) + 1;
    const stated = decodePng(png).width - 2 * 0.25 * layout.fontSize;
    expect(inked).toBeGreaterThan(stated * 0.9);
    expect(inked).toBeLessThan(stated * 1.02);
  });

  test("the text is centred in the box, to within a few pixels", async () => {
    const { png, width } = await renderer().render(request({ value: "Hello there", style: "outline", font: "oswald" }));
    const ink = extent(decodePng(png), (_r, _g, _b, a) => a > 0);
    const left = ink?.left ?? 0;
    const right = width - 1 - (ink?.right ?? 0);
    expect(Math.abs(left - right)).toBeLessThan(0.06 * width);
  });
});

describe("emoji", () => {
  test("an emoji is drawn from the bundled bitmap", async () => {
    const { png } = await renderer().render(request({ value: "\u{1F600}", style: "outline" }));
    expect(countPixels(decodePng(png), (r, g, b, a) => a === 255 && r > 200 && g > 150 && b < 100)).toBeGreaterThan(300);
  });

  test("a ZWJ sequence, a flag and a keycap are each one picture", async () => {
    for (const value of ["\u{1F469}‍\u{1F4BB}", "\u{1F1FA}\u{1F1E6}", "1️⃣"]) {
      const { layout, png } = await renderer().render(request({ value, style: "outline" }));
      expect(layout.lines).toEqual([value]);
      expect(countPixels(decodePng(png), (_r, _g, _b, a) => a > 0)).toBeGreaterThan(200);
    }
  });

  test("the deduped SVG draws the same pixels as one inline image per emoji", async () => {
    const value = "\u{1F600}\u{1F600} \u{1F600} go";
    const layout = layoutCaption({ text: value, scale: 1, measure: (run) => run.length * 60, emojiAspect: () => 136 / 128 });
    const svg = buildCaptionSvg({
      layout,
      font: "manrope",
      style: "outline",
      color: "#ffffff",
      metrics: rasteriser.verticalMetrics("manrope"),
      emoji: (codePoints) => {
        const bitmap = emoji.bitmap(codePoints);
        if (bitmap === null) throw new Error("no bitmap");
        return { key: 1, base64: Buffer.from(bitmap.png).toString("base64") };
      },
    });
    const href = /<image id="e0" width="([0-9.]+)" height="([0-9.]+)" href="([^"]+)"\/>/.exec(svg.svg);
    expect(href).not.toBeNull();
    const inlined = svg.svg.replace(/<defs>.*?<\/defs>/, "").replace(/<use href="#e0" x="([0-9.]+)" y="([0-9.]+)"\/>/g, (_m, x: string, y: string) => `<image x="${x}" y="${y}" width="${href?.[1]}" height="${href?.[2]}" href="${href?.[3]}"/>`);
    const a = await rasteriser.render({ svg: svg.svg, font: "manrope" });
    const b = await rasteriser.render({ svg: inlined, font: "manrope" });
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    expect(Buffer.byteLength(svg.svg)).toBeLessThan(Buffer.byteLength(inlined) / 2);
  });

  test("sixty distinct emoji of the largest bitmaps in the whole emoji-test list are DRAWN: they fit under the SVG cap, and the layout stays in its bounds", async () => {
    const sizes: { sequence: string; bytes: number }[] = [];
    for (const entry of await loadEmojiTest()) {
      if (entry.status !== "fully-qualified") continue;
      const sequence = String.fromCodePoint(...entry.codePoints);
      const bitmap = emoji.bitmap(sequence);
      if (bitmap !== null && captionRulesAccept(sequence)) sizes.push({ sequence, bytes: bitmap.png.byteLength });
    }
    expect(sizes.length).toBeGreaterThan(3000);
    const value = sizes
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 60)
      .map((entry) => entry.sequence)
      .join("");
    expect(segmentCaption(value)).toHaveLength(60);
    const image = await renderer().render(request({ value, style: "outline" }));
    expect(image.layout.lines).toEqual([value]);
    expect(image.width).toBeLessThanOrEqual(1080);
  });

  test("reads each distinct bitmap out of the font once, however many captions use it", async () => {
    let calls = 0;
    const counting: EmojiFont = { ...emoji, bitmap: (sequence) => (calls++, emoji.bitmap(sequence)) };
    const r = createCaptionRenderer({ rasteriser, emoji: counting });
    await r.render(request({ value: "\u{1F600} \u{1F600} hi" }));
    const first = calls;
    await r.render(request({ value: "bye \u{1F600}", style: "outline" }));
    expect(first).toBeGreaterThan(0);
    expect(calls).toBe(first);
  });
});

describe("measuring is cached", () => {
  test("a caption seen before costs no new measure", async () => {
    let measures = 0;
    const counting: TextRasteriser = { ...rasteriser, init: () => rasteriser.init(), render: (r) => rasteriser.render(r), measure: (r) => (measures++, rasteriser.measure(r)), verticalMetrics: (f) => rasteriser.verticalMetrics(f), isBroken: () => rasteriser.isBroken() };
    const r = createCaptionRenderer({ rasteriser: counting, emoji });
    await r.render(request({ value: "coffee first" }));
    const after = measures;
    await r.render(request({ value: "coffee first", style: "outline", scale: 1.7 }));
    expect(after).toBeGreaterThan(0);
    expect(measures).toBe(after);
  });

  test("the same word in another font is measured again", async () => {
    let measures = 0;
    const counting: TextRasteriser = { ...rasteriser, init: () => rasteriser.init(), render: (r) => rasteriser.render(r), measure: (r) => (measures++, rasteriser.measure(r)), verticalMetrics: (f) => rasteriser.verticalMetrics(f), isBroken: () => rasteriser.isBroken() };
    const r = createCaptionRenderer({ rasteriser: counting, emoji });
    await r.render(request({ value: "coffee" }));
    const after = measures;
    await r.render(request({ value: "coffee", font: "oswald" }));
    expect(measures).toBeGreaterThan(after);
  });
});

describe("failures are hard", () => {
  test.each([
    ["a character no text font has", "café", "charset"],
    ["Cyrillic", "Привет", "charset"],
    ["a lone regional indicator", "\u{1F1FA}", "emoji-missing"],
    ["an emoji with VS15", "❤︎", "emoji-text-style"],
    ["over sixty graphemes", "a".repeat(61), "too-long"],
    ["three lines", "a\nb\nc", "too-many-lines"],
  ])("%s is CAPTION_INVALID and names the rule, and nothing is drawn", async (_name, value, issue) => {
    expect(await codeOf(renderer().render(request({ value })))).toEqual({ code: "CAPTION_INVALID", captionIssue: issue });
  });

  test("a caption of only spaces has nothing to draw: RENDER_FAILED", async () => {
    expect(await codeOf(renderer().render(request({ value: "   " })))).toEqual({ code: "RENDER_FAILED", captionIssue: undefined });
  });

  test("a rasteriser failure is passed through with its own code, never replaced by another picture", async () => {
    const failing: TextRasteriser = { ...rasteriser, init: () => rasteriser.init(), measure: (r) => rasteriser.measure(r), verticalMetrics: (f) => rasteriser.verticalMetrics(f), isBroken: () => false, render: () => Promise.reject(new RasterError("RENDER_TIMEOUT", "the call took 4000 ms")) };
    const r = createCaptionRenderer({ rasteriser: failing, emoji });
    expect(await codeOf(r.render(request()))).toEqual({ code: "RENDER_TIMEOUT", captionIssue: undefined });
  });

  test("an unreadable measure is RENDER_FAILED with the cause kept", async () => {
    const broken: TextRasteriser = { ...rasteriser, init: () => rasteriser.init(), render: (r) => rasteriser.render(r), verticalMetrics: (f) => rasteriser.verticalMetrics(f), isBroken: () => false, measure: () => null };
    const r = createCaptionRenderer({ rasteriser: broken, emoji });
    expect(await codeOf(r.render(request({ value: "hi" })))).toEqual({ code: "RENDER_FAILED", captionIssue: undefined });
  });

  test("a colour that would break the markup is RENDER_FAILED, and never reaches resvg", async () => {
    let rendered = 0;
    const spy: TextRasteriser = { ...rasteriser, init: () => rasteriser.init(), measure: (r) => rasteriser.measure(r), verticalMetrics: (f) => rasteriser.verticalMetrics(f), isBroken: () => false, render: (r) => (rendered++, rasteriser.render(r)) };
    const r = createCaptionRenderer({ rasteriser: spy, emoji });
    expect(await codeOf(r.render(request({ color: '#ffffff" onload="x' })))).toEqual({ code: "RENDER_FAILED", captionIssue: undefined });
    expect(rendered).toBe(0);
  });

  test("a scale outside the contract's range is RENDER_FAILED", async () => {
    expect(await codeOf(renderer().render(request({ scale: 3 })))).toEqual({ code: "RENDER_FAILED", captionIssue: undefined });
  });
});

describe("the decoder the pixel tests rely on", () => {
  test("reads a filled rectangle back exactly", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="6" height="4"><rect x="1" y="1" width="2" height="2" fill="#12ab34"/></svg>';
    const image = decodePng((await rasteriser.render({ svg, font: "manrope" })).png);
    expect(pixel(image, 1, 1)).toEqual([0x12, 0xab, 0x34, 255]);
    expect(pixel(image, 0, 0)[3]).toBe(0);
    expect(image.width).toBe(6);
    expect(opaque(0x12, 0x12, 0x12, 255)).toBe(true);
  });
});
