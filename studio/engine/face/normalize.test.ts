import { describe, expect, test } from "bun:test";
import { FACE_PIPELINE_MAX_SIDE, normalizeForFacePipeline } from "./normalize";
import type { TaggedPixels } from "./pixels";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Re-review, MUST FIX 1: normalizeForFacePipeline must be a strict no-op at
// or below FACE_PIPELINE_MAX_SIDE (parity.test.ts's calibrated fixtures,
// 720x1280 and 864x1152, must stay byte-identical to before this task) and
// a correct, deterministic area/box downscale above it.

function solid(width: number, height: number, rgba: [number, number, number, number]): TaggedPixels {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { format: "rgba", width, height, data };
}

describe("normalizeForFacePipeline: no-op at or below the cap", () => {
  test("returns the exact same object when the long side equals the cap", () => {
    const pixels = solid(FACE_PIPELINE_MAX_SIDE, 800, [1, 2, 3, 255]);
    expect(normalizeForFacePipeline(pixels)).toBe(pixels);
  });

  test("returns the exact same object when well below the cap (a calibrated 864x1152 master)", () => {
    const pixels = solid(864, 1152, [1, 2, 3, 255]);
    expect(normalizeForFacePipeline(pixels)).toBe(pixels);
  });

  test("returns the exact same object when well below the cap (a calibrated 720x1280 render)", () => {
    const pixels = solid(720, 1280, [1, 2, 3, 255]);
    expect(normalizeForFacePipeline(pixels)).toBe(pixels);
  });

  test("never upscales a tiny image", () => {
    const pixels = solid(4, 3, [9, 9, 9, 255]);
    expect(normalizeForFacePipeline(pixels)).toBe(pixels);
  });
});

describe("normalizeForFacePipeline: downscale above the cap", () => {
  test("shrinks a landscape image so the long side (width) is exactly the cap, preserving aspect ratio", () => {
    const pixels = solid(4032, 3024, [10, 20, 30, 255]);
    const out = normalizeForFacePipeline(pixels);
    expect(out.width).toBe(FACE_PIPELINE_MAX_SIDE);
    expect(out.height).toBe(Math.round((3024 * FACE_PIPELINE_MAX_SIDE) / 4032));
    expect(out).not.toBe(pixels);
  });

  test("shrinks a portrait image (12 MP phone photo, 3024x4032) so the long side (height) is exactly the cap", () => {
    const pixels = solid(3024, 4032, [10, 20, 30, 255]);
    const out = normalizeForFacePipeline(pixels);
    expect(out.height).toBe(FACE_PIPELINE_MAX_SIDE);
    expect(out.width).toBe(Math.round((3024 * FACE_PIPELINE_MAX_SIDE) / 4032));
  });

  test("preserves the pixel format tag", () => {
    const pixels = solid(2000, 1500, [1, 1, 1, 255]);
    const out = normalizeForFacePipeline({ ...pixels, format: "bgra" });
    expect(out.format).toBe("bgra");
  });

  test("a solid-colour image stays exactly that colour after averaging (every box is uniform)", () => {
    const pixels = solid(2560, 1920, [200, 100, 50, 255]);
    const out = normalizeForFacePipeline(pixels);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(200);
      expect(out.data[i + 1]).toBe(100);
      expect(out.data[i + 2]).toBe(50);
      expect(out.data[i + 3]).toBe(255);
    }
  });

  test("area-averages a real gradient: a 4x1 row halved to 2x1 averages adjacent pixel pairs", () => {
    const data = new Uint8Array([0, 0, 0, 255, 100, 0, 0, 255, 0, 0, 0, 255, 200, 0, 0, 255]);
    const pixels: TaggedPixels = { format: "rgba", width: 4, height: 1, data };
    const out = normalizeForFacePipeline(pixels, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
    // box 0: source px [0,1] -> avg R (0+100)/2=50; box 1: source px [2,3] -> avg R (0+200)/2=100
    expect(out.data[0]).toBe(50);
    expect(out.data[4]).toBe(100);
  });

  test("output byte length matches width*height*4", () => {
    const pixels = solid(3000, 2000, [5, 5, 5, 5]);
    const out = normalizeForFacePipeline(pixels);
    expect(out.data.byteLength).toBe(out.width * out.height * 4);
  });
});
