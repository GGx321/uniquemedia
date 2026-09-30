import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { createTextRasteriser, RASTER_WASM, RasterError } from "./rasteriser";
useNativeGlobals();

const FONT_DIR = join(import.meta.dir, "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);

describe("verticalMetrics", () => {
  test("gives each font's hhea metrics once the rasteriser has loaded", async () => {
    const rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
    await rasteriser.init();
    expect(rasteriser.verticalMetrics("manrope")).toEqual({ unitsPerEm: 2000, ascender: 2132, descender: -600 });
    expect(rasteriser.verticalMetrics("caveat")).toEqual({ unitsPerEm: 1000, ascender: 960, descender: -300 });
  });

  test("throws NOT_INITIALISED before the rasteriser has loaded, since it is synchronous", () => {
    const rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
    expect(() => rasteriser.verticalMetrics("manrope")).toThrow(expect.objectContaining({ name: "RasterError", code: "NOT_INITIALISED" }));
  });

  test("throws a RasterError, not a raw error, for a font key it does not know", async () => {
    const rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
    await rasteriser.init();
    // @ts-expect-error not one of the five font keys
    expect(() => rasteriser.verticalMetrics("comic")).toThrow(RasterError);
  });
});
