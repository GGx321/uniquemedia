import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TEXT_FONT_KEYS, type TextFontKey } from "./fonts";
import { createTextRasteriser, RASTER_WASM, RasterError, type RasterImage, type RasterRequest } from "./rasteriser";
import { assertTextSelfTest, runTextSelfTest, SELF_TEST_FINGERPRINT, SELF_TEST_HASHES, SELF_TEST_TEXT, selfTestSvg } from "./selfTest";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const FONT_DIR = join(import.meta.dir, "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);

// Golden renders, the SP2 way: resvg-wasm is deterministic and the fonts are bundled, so the PNG bytes are
// pinned exactly (a sha256 prefix per font and one fingerprint over the five) instead of compared with a pixel
// tolerance. The same constants must hold on macOS and on Windows (the CI smoke asserts them on both).
describe("golden text renders", () => {
  const rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });

  test("the Cyrillic self-test string is the one the goldens were cut from", () => {
    expect(SELF_TEST_TEXT).toBe("Привет, мир! Ёж 2026 Beach");
  });

  test.each([...TEXT_FONT_KEYS])("%s draws the Cyrillic string to the pinned PNG hash", async (font: TextFontKey) => {
    const { hashes } = await runTextSelfTest(rasteriser);
    expect(hashes[font]).toBe(SELF_TEST_HASHES[font]);
  });

  test("the fingerprint over the five fonts is the pinned one", async () => {
    expect((await runTextSelfTest(rasteriser)).fingerprint).toBe(SELF_TEST_FINGERPRINT);
  });

  test("a second full run gives the same fingerprint", async () => {
    const first = await runTextSelfTest(rasteriser);
    const second = await runTextSelfTest(rasteriser);
    expect(second).toEqual(first);
  });

  test("no two fonts draw the same picture", () => {
    expect(new Set(Object.values(SELF_TEST_HASHES)).size).toBe(5);
  });

  test("the self-test SVG names each font's own family and weight", () => {
    expect(selfTestSvg("caveat")).toContain('font-family="Caveat" font-weight="600"');
    expect(selfTestSvg("manrope")).toContain('font-family="Manrope" font-weight="800"');
  });

  test("assertTextSelfTest returns the fingerprint when every font matches", async () => {
    expect(await assertTextSelfTest(rasteriser)).toBe(SELF_TEST_FINGERPRINT);
  });

  test("assertTextSelfTest throws, naming the fonts, when a font draws something else", async () => {
    // A rasteriser that draws Oswald's string in Manrope's bytes, as a swapped font file would.
    const swapped = {
      async render(request: RasterRequest): Promise<RasterImage> {
        return rasteriser.render({ ...request, font: request.font === "oswald" ? "manrope" : request.font });
      },
    };
    await expect(assertTextSelfTest(swapped)).rejects.toThrow(/oswald/);
  });

  test("assertTextSelfTest passes a rasteriser failure through untouched", async () => {
    const failing = {
      render(): Promise<RasterImage> {
        return Promise.reject(new RasterError("RENDER_FAILED", "boom"));
      },
    };
    await expect(assertTextSelfTest(failing)).rejects.toBeInstanceOf(RasterError);
  });
});
