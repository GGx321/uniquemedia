import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FRAME_W } from "../../../shared/montage";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { TEXT_ALLOWED } from "../../../shared/text/captionRules";
import { TEXT_FONT_KEYS, type TextFontKey } from "../fonts";
import { createTextRasteriser, RASTER_WASM, type TextRasteriser } from "../rasteriser";
import { TEXT_FIT_WIDTH } from "../../../shared/text/layout";
import { INK_ORIGIN_PX, inkSvg, measureSvg } from "./template";
useNativeGlobals();

// The frame caps the box (template.ts), so a glyph that sticks out further than the frame's spare room would be cut at the frame
// edge whatever the layout does. This measures EVERY glyph of the caption charset in every font and pins that the worst of them
// fits that room in the styles whose reach is small (outline and plaque), so a font added or swapped later cannot bring clipping back.

const FONT_DIR = join(import.meta.dir, "..", "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);

/** The largest size a caption is drawn at, and what is left of the frame beside the widest legal text, per side. */
const MAX_SIZE_PX = 112;
const SPARE_PER_SIDE = (FRAME_W - TEXT_FIT_WIDTH) / 2;
const OUTLINE_REACH_EM = 0.0625;
const OUTLINE_REACH_PX = 1;
const PLAQUE_PAD_EM = 0.5;

/** Every character the caption charset allows on a line: TEXT_ALLOWED is the rule's own regular expression, so this cannot drift from it. */
function charset(): string[] {
  const all: string[] = [];
  for (let code = 0x20; code <= 0x2026; code++) {
    const character = String.fromCharCode(code);
    if (character !== " " && TEXT_ALLOWED.test(character)) all.push(character);
  }
  return all;
}

let rasteriser: TextRasteriser;
beforeAll(async () => {
  rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
  await rasteriser.init();
});

function worstOverhangEm(font: TextFontKey): { left: number; right: number; leftOf: string; rightOf: string } {
  const at = (svg: string): number => rasteriser.measure({ svg, font })?.width ?? Number.NaN;
  const bars = at(measureSvg(font, ""));
  const out = { left: 0, right: 0, leftOf: "", rightOf: "" };
  for (const character of charset()) {
    const advance = at(measureSvg(font, character)) - bars;
    const ink = rasteriser.measure({ svg: inkSvg(font, character), font });
    if (ink === null) continue;
    const left = (INK_ORIGIN_PX - ink.x) / 100;
    const right = (ink.x + ink.width - INK_ORIGIN_PX - advance) / 100;
    if (left > out.left) Object.assign(out, { left, leftOf: character });
    if (right > out.right) Object.assign(out, { right, rightOf: character });
  }
  return out;
}

describe("the charset's worst overhang, per font", () => {
  test("the charset is the whole allowed set: printable ASCII and the seven typographic marks", () => {
    expect(charset()).toHaveLength(94 + 7);
  });

  test.each([...TEXT_FONT_KEYS])("%s: at the largest size the worst glyph plus the outline's reach fits the frame's spare room, and the plaque's padding holds it", (font: TextFontKey) => {
    const worst = worstOverhangEm(font);
    const wider = Math.max(worst.left, worst.right);
    const outline = wider * MAX_SIZE_PX + OUTLINE_REACH_EM * MAX_SIZE_PX + OUTLINE_REACH_PX;
    expect(outline, `${font}: ${JSON.stringify(worst)}`).toBeLessThanOrEqual(SPARE_PER_SIDE);
    expect(wider, `${font}: ${JSON.stringify(worst)}`).toBeLessThanOrEqual(PLAQUE_PAD_EM);
  });

  test("Caveat's bracket is the reason this exists: it reaches past a quarter of an em", () => {
    const worst = worstOverhangEm("caveat");
    expect(Math.max(worst.left, worst.right)).toBeGreaterThan(0.25);
  });
});
