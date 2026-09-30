import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { openEmojiFont, type EmojiFont } from "../emoji/emojiFont";
import { loadPinnedEmojiFont } from "../emoji/emojiFont.testkit";
import { TextWorkerResponseSchema } from "../worker/protocol";
import { TEXT_FONT_KEYS, type TextFontKey } from "../fonts";
import { createTextRasteriser, RASTER_WASM, type TextRasteriser } from "../rasteriser";
import { decodePng, type Rgba } from "./png.testkit";
import { createCaptionRenderer, type CaptionRequest } from "./renderer";
useNativeGlobals();

// Ink must never meet the box's edge. Some glyphs reach past their advance (Caveat's bracket by 0.3 em, its f and j), and the box is
// sized by ink for that: a caption ending in one used to lose a strip of its outline to a hard vertical cut.

const FONT_DIR = join(import.meta.dir, "..", "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);
const STYLES = ["none", "plaque", "outline"] as const;

let rasteriser: TextRasteriser;
let emoji: EmojiFont;
beforeAll(async () => {
  rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
  await rasteriser.init();
  emoji = openEmojiFont(await loadPinnedEmojiFont());
});

const renderer = () => createCaptionRenderer({ rasteriser, emoji });

/** How many pixels in the outermost column on each side and the outermost row above and below are ink: opaque text or stroke, or, for a plaque, the dark text. */
function edgeInk(image: Rgba, style: CaptionRequest["style"]): number {
  const isInk = (r: number, g: number, b: number, a: number): boolean => (style === "plaque" ? a > 200 && r < 100 && g < 100 && b < 100 : a > 2);
  let n = 0;
  for (let y = 0; y < image.height; y++) {
    for (const x of [0, image.width - 1]) {
      const at = (y * image.width + x) * 4;
      if (isInk(image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0, image.data[at + 3] ?? 0)) n++;
    }
  }
  for (let x = 0; x < image.width; x++) {
    for (const y of [0, image.height - 1]) {
      const at = (y * image.width + x) * 4;
      if (isInk(image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0, image.data[at + 3] ?? 0)) n++;
    }
  }
  return n;
}

const request = (over: Partial<CaptionRequest>): CaptionRequest => ({ value: "hi", font: "caveat", style: "outline", color: "#ffffff", scale: 1, ...over });

describe("no ink reaches the box's edge", () => {
  const ENDS = ["chef", "brief", "of", "if", "stuff off", "Hey [", "[", "jump", "j", "[jj]", "quiz_", "fjord", "f", "x [ ]"];

  test.each([...TEXT_FONT_KEYS])("%s, every style, both ends of the scale: captions that start with j or end in [ or f are whole", async (font: TextFontKey) => {
    for (const style of STYLES) {
      for (const scale of [1, 2]) {
        for (const value of ENDS) {
          const { png } = await renderer().render(request({ value, font, style, scale, color: style === "plaque" ? "#ffd166" : "#ffffff" }));
          expect(edgeInk(decodePng(png), style), `${font}/${style} x${scale} ${JSON.stringify(value)}`).toBe(0);
        }
      }
    }
  });

  test("Caveat's bracket is not cut in a two-line caption either", async () => {
    for (const style of STYLES) {
      const { png } = await renderer().render(request({ value: "jump [\nover [", style, scale: 2 }));
      expect(edgeInk(decodePng(png), style)).toBe(0);
    }
  });

  test("a bracket at the end of the widest legal line is whole, or only the far tail of a shadow is cut", async () => {
    for (const style of STYLES) {
      const { png, width } = await renderer().render(request({ value: `${"W".repeat(20)}[`, style, scale: 2 }));
      expect(width).toBeLessThanOrEqual(1080);
      expect(edgeInk(decodePng(png), style)).toBe(0);
    }
  });

  test("every printable character, at each end of a caption, in every font at the largest scale, leaves the outline whole", async () => {
    const chars: string[] = [];
    for (let c = 0x21; c <= 0x7e; c++) chars.push(String.fromCharCode(c));
    chars.push("’", "‘", "“", "”", "–", "—", "…");
    const r = renderer();
    const clipped: string[] = [];
    for (const font of TEXT_FONT_KEYS) {
      for (const c of chars) {
        for (const value of [`a${c}`, `${c}a`]) {
          const { png } = await r.render(request({ value, font, style: "outline", scale: 2 }));
          if (edgeInk(decodePng(png), "outline") > 0) clipped.push(`${font} ${JSON.stringify(value)}`);
        }
      }
    }
    expect(clipped).toEqual([]);
  }, 120_000);

  test("a caption whose ends do not stick out is no wider than before: the box is not padded for nothing", async () => {
    const plain = await renderer().render(request({ value: "hello", font: "manrope", style: "outline" }));
    const size = plain.layout.fontSize;
    expect(plain.width).toBeLessThanOrEqual(Math.ceil(plain.layout.width) + 1);
    expect(plain.width).toBeLessThan(400 + 0.6 * size);
  });
});

describe("the worst legal caption", () => {
  test("41 kiss emoji (41 graphemes, 615 UTF-16 units) are drawn, and the answer the worker would send is inside the protocol", async () => {
    const value = "\u{1F469}\u{1F3FD}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}\u{1F3FB}".repeat(41);
    const image = await renderer().render(request({ value, style: "none", font: "manrope", scale: 2 }));
    const wire = { type: "captioned", id: 1, width: image.width, height: image.height, png: image.png.slice().buffer, layout: image.layout, workerMs: 1 };
    expect(TextWorkerResponseSchema.safeParse(wire).success).toBe(true);
  });
});
