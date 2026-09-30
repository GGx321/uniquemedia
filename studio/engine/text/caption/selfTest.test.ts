import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { openEmojiFont } from "../emoji/emojiFont";
import { loadPinnedEmojiFont } from "../emoji/emojiFont.testkit";
import { createTextRasteriser, RASTER_WASM } from "../rasteriser";
import { CAPTION_FINGERPRINT_LAYERS } from "./fingerprint";
import { createCaptionRenderer, type CaptionRenderer } from "./renderer";
import { assertCaptionSelfTest, CAPTION_SELF_TEST_KEY } from "./selfTest";
useNativeGlobals();

// The caption self-test: one pinned caption WITH an emoji drawn through the same gate the text does, at load, so the emoji reader,
// the layout and the template are proved wherever the engine runs (the packaged app included), not only by the tests.

const FONT_DIR = join(import.meta.dir, "..", "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);

let renderer: CaptionRenderer;
beforeAll(async () => {
  const rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
  await rasteriser.init();
  renderer = createCaptionRenderer({ rasteriser, emoji: openEmojiFont(await loadPinnedEmojiFont()) });
});

const layer = CAPTION_FINGERPRINT_LAYERS.find((entry) => entry.key === CAPTION_SELF_TEST_KEY);

describe("assertCaptionSelfTest", () => {
  test("uses a fingerprint layer that carries an emoji", () => {
    expect(layer).toBeDefined();
    expect(/\p{Extended_Pictographic}/u.test(layer?.request.value ?? "")).toBe(true);
  });

  test("passes when the gate draws the pinned caption to the pinned bytes", async () => {
    await expect(assertCaptionSelfTest({ caption: (request) => renderer.render(request) })).resolves.toBeUndefined();
  });

  test("asks for exactly that layer", async () => {
    const seen: unknown[] = [];
    await assertCaptionSelfTest({ caption: (request) => (seen.push(request), renderer.render(request)) });
    expect(seen).toEqual([layer?.request]);
  });

  test("throws, naming the layer and both hashes, when it draws something else", async () => {
    const other = CAPTION_FINGERPRINT_LAYERS.find((entry) => entry.key === "manrope/outline");
    const swapped = { caption: () => renderer.render(other?.request ?? { value: "x", font: "manrope", style: "plaque", color: "#ffffff", scale: 1 }) };
    await expect(assertCaptionSelfTest(swapped)).rejects.toThrow(new RegExp(`caption self-test: ${CAPTION_SELF_TEST_KEY}`));
  });

  test("passes a failure of the gate through untouched", async () => {
    const boom = new Error("gate down");
    await expect(assertCaptionSelfTest({ caption: () => Promise.reject(boom) })).rejects.toBe(boom);
  });
});
