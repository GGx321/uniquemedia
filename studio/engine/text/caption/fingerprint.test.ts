import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { openEmojiFont } from "../emoji/emojiFont";
import { loadPinnedEmojiFont } from "../emoji/emojiFont.testkit";
import { createTextRasteriser, RASTER_WASM } from "../rasteriser";
import { CAPTION_FINGERPRINT, CAPTION_FINGERPRINT_LAYERS, CAPTION_LAYER_HASHES, CAPTION_STYLES, fingerprintOf, hashOf } from "./fingerprint";
import { createCaptionRenderer } from "./renderer";
useNativeGlobals();

const FONT_DIR = join(import.meta.dir, "..", "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);

// Golden renders of the caption template, the SP2 way: the PNG bytes are pinned by hash, not compared with a tolerance.
// This is the in-process half (Bun, the renderer without a worker); the same constants are asserted through the real
// worker under Electron's Node (worker/textCaption.real.node-test.ts), and both run on macOS and Windows in CI.

let hashes: Record<string, string>;
beforeAll(async () => {
  const rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
  await rasteriser.init();
  const renderer = createCaptionRenderer({ rasteriser, emoji: openEmojiFont(await loadPinnedEmojiFont()) });
  hashes = {};
  for (const layer of CAPTION_FINGERPRINT_LAYERS) hashes[layer.key] = hashOf((await renderer.render(layer.request)).png);
});

describe("the caption fingerprint layers", () => {
  test("are the fifteen font by style layers, in a fixed order", () => {
    expect(CAPTION_FINGERPRINT_LAYERS).toHaveLength(15);
    expect(CAPTION_STYLES).toEqual(["plaque", "outline", "none"]);
    expect(new Set(CAPTION_FINGERPRINT_LAYERS.map((layer) => layer.key)).size).toBe(15);
  });

  test("cover a two-line caption, a ZWJ emoji, a dark and a light colour in every style, and both ends of the scale", () => {
    const requests = CAPTION_FINGERPRINT_LAYERS.map((layer) => layer.request);
    expect(requests.some((r) => /\r\n/.test(r.value))).toBe(true);
    expect(requests.some((r) => r.value.includes("‍"))).toBe(true);
    for (const style of CAPTION_STYLES) {
      expect(requests.filter((r) => r.style === style && r.color === "#111111").length).toBeGreaterThan(0);
      expect(requests.filter((r) => r.style === style && r.color !== "#111111").length).toBeGreaterThan(0);
    }
    expect(requests.some((r) => /[&<>]/.test(r.value) && r.value.length > 40)).toBe(true);
    expect(requests.some((r) => r.font === "caveat" && r.value.endsWith("["))).toBe(true);
    expect(Math.max(...requests.map((r) => r.scale))).toBe(2);
    expect(Math.min(...requests.map((r) => r.scale))).toBeLessThanOrEqual(1);
  });
});

describe("golden caption renders", () => {
  test("every layer draws to its pinned PNG hash", () => {
    expect(hashes).toEqual({ ...CAPTION_LAYER_HASHES });
  });

  test("the fingerprint over the fifteen layers is the pinned one", () => {
    expect(fingerprintOf(hashes)).toBe(CAPTION_FINGERPRINT);
  });

  test("no two layers draw the same picture", () => {
    expect(new Set(Object.values(CAPTION_LAYER_HASHES)).size).toBe(15);
  });

  test("the fingerprint moves when any one layer's hash does", () => {
    for (const layer of CAPTION_FINGERPRINT_LAYERS) {
      expect(fingerprintOf({ ...hashes, [layer.key]: "ffffffffffffffff" })).not.toBe(CAPTION_FINGERPRINT);
    }
  });
});
