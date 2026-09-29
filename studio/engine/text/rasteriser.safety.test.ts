import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { createTextRasteriser, DEFAULT_RASTER_LIMITS, RASTER_WASM, RasterError, TEXT_RENDER_DEADLINE_MS, type RasterDeps, type ResvgLike } from "./rasteriser";
useNativeGlobals();

const FONT_DIR = join(import.meta.dir, "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);
const REQUEST = { svg: "<svg/>", font: "manrope" } as const;

function deps(over: Partial<RasterDeps> = {}): RasterDeps {
  return { wasmPath: WASM_PATH, fontDir: FONT_DIR, ...over };
}

/** What resvg-wasm does after a trap (600 nested `<g opacity>` ran it out of memory): the call throws, and `free()` then throws about aliasing. */
function trappedResvg(where: "render" | "getBBox"): ResvgLike {
  const trap = (): never => {
    throw new WebAssembly.RuntimeError("unreachable");
  };
  return {
    width: 100,
    height: 50,
    render: where === "render" ? trap : () => ({ width: 100, height: 50, asPng: () => new Uint8Array(8), free: () => {} }),
    getBBox: where === "getBBox" ? trap : () => undefined,
    free: () => {
      throw new Error("recursive use of an object detected which would lead to unsafe aliasing in rust");
    },
  };
}

function fake(over: Partial<ResvgLike> = {}): ResvgLike {
  return {
    width: 100,
    height: 50,
    render: () => ({ width: 100, height: 50, asPng: () => new Uint8Array(8), free: () => {} }),
    getBBox: () => ({ x: 0, y: 0, width: 10, height: 10, free: () => {} }),
    free: () => {},
    ...over,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

describe("after a wasm trap", () => {
  test("render rejects with the RasterError, not with free()'s aliasing error", async () => {
    const r = createTextRasteriser(deps({ newResvg: () => trappedResvg("render") }));
    const error = await failureOf(r.render(REQUEST));
    expect(error).toBeInstanceOf(RasterError);
    expect(error instanceof RasterError && error.code).toBe("RENDER_FAILED");
    expect(error instanceof Error && error.message).not.toContain("recursive use");
  });

  test("render keeps the trap as the cause", async () => {
    const r = createTextRasteriser(deps({ newResvg: () => trappedResvg("render") }));
    const error = await failureOf(r.render(REQUEST));
    expect(error instanceof Error && error.cause).toBeInstanceOf(WebAssembly.RuntimeError);
  });

  test("the rasteriser is marked broken, and says so instead of drawing on a corrupt instance", async () => {
    const r = createTextRasteriser(deps({ newResvg: () => trappedResvg("render") }));
    expect(r.isBroken()).toBe(false);
    await failureOf(r.render(REQUEST));
    expect(r.isBroken()).toBe(true);
    const later = await failureOf(r.render(REQUEST));
    expect(later instanceof RasterError && later.code).toBe("BROKEN");
    expect(() => r.measure(REQUEST)).toThrow(RasterError);
  });

  test("a trap inside getBBox is handled the same way", async () => {
    const r = createTextRasteriser(deps({ newResvg: () => trappedResvg("getBBox") }));
    await r.init();
    let code: string | null = null;
    try {
      r.measure(REQUEST);
    } catch (e) {
      code = e instanceof RasterError ? e.code : `raw: ${String(e)}`;
    }
    expect(code).toBe("RENDER_FAILED");
    expect(r.isBroken()).toBe(true);
  });

  test("a free() that fails after a good render still returns the picture, and marks the rasteriser broken", async () => {
    const r = createTextRasteriser(deps({ newResvg: () => fake({ free: () => { throw new Error("recursive use of an object"); } }) }));
    expect((await r.render(REQUEST)).png.byteLength).toBe(8);
    expect(r.isBroken()).toBe(true);
  });

  test("says why it is broken: the failing free()'s own message rides on every BROKEN answer", async () => {
    const r = createTextRasteriser(deps({ newResvg: () => trappedResvg("render") }));
    await failureOf(r.render(REQUEST));
    const later = await failureOf(r.render(REQUEST));
    expect(later instanceof Error && later.message).toContain("recursive use of an object detected");
    expect(later instanceof Error && later.cause).toBeInstanceOf(Error);
  });

  test("a clean parse error is not a trap: the rasteriser stays usable", async () => {
    const r = createTextRasteriser(deps());
    await failureOf(r.render({ svg: "<svg", font: "manrope" }));
    expect(r.isBroken()).toBe(false);
  });

  test("a parse that throws a wasm trap marks it broken", async () => {
    const r = createTextRasteriser(deps({ newResvg: () => { throw new WebAssembly.RuntimeError("memory access out of bounds"); } }));
    await failureOf(r.render(REQUEST));
    expect(r.isBroken()).toBe(true);
  });
});

describe("one real time limit", () => {
  test("the in-worker tripwire is never tighter than the gate's wall, so the wall is the limit", () => {
    expect(DEFAULT_RASTER_LIMITS.timeoutMs).toBeGreaterThanOrEqual(TEXT_RENDER_DEADLINE_MS);
  });
});

describe("RasterError", () => {
  test("does not prefix a message that already carries the prefix", () => {
    expect(new RasterError("RENDER_FAILED", "text rasteriser: boom").message).toBe("text rasteriser: boom");
    expect(new RasterError("RENDER_FAILED", "boom").message).toBe("text rasteriser: boom");
  });
});

describe("limits", () => {
  test("the deadline covers parsing and shaping, not only the paint", async () => {
    let now = 0;
    const r = createTextRasteriser(deps({ limits: { timeoutMs: 1000 }, now: () => now, newResvg: () => ((now += 5000), fake()) }));
    const error = await failureOf(r.render(REQUEST));
    expect(error instanceof RasterError && error.code).toBe("RENDER_TIMEOUT");
  });

  test("measure has the same deadline", async () => {
    let now = 0;
    const r = createTextRasteriser(deps({ limits: { timeoutMs: 1000 }, now: () => now, newResvg: () => ((now += 5000), fake()) }));
    await r.init();
    expect(() => r.measure(REQUEST)).toThrow(/RENDER_TIMEOUT|took/);
  });

  test("the canvas is rounded up before it is counted", async () => {
    const r = createTextRasteriser(deps({ limits: { maxPixels: 1050 }, newResvg: () => fake({ width: 100.4, height: 10.2 }) }));
    const error = await failureOf(r.render(REQUEST));
    expect(error instanceof RasterError && error.code).toBe("RASTER_TOO_LARGE");
  });

  test("measure refuses a canvas over the pixel cap too", async () => {
    const r = createTextRasteriser(deps({ limits: { maxPixels: 10 } }));
    await r.init();
    const big = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="5" height="5"/></svg>';
    expect(() => r.measure({ svg: big, font: "manrope" })).toThrow(/pixels/);
  });

  test("the defaults are the caption template's ceiling, not a full frame", () => {
    // A text box is at most the frame wide (1080). Height: 2 lines x 1.2 line height x (56 px base x 2 max scale)
    // = 269, plus 2 x 0.3 em padding = 67, about 336 px, plus stroke or shadow bleed: 600 px is 1.75x headroom.
    expect(DEFAULT_RASTER_LIMITS.maxPixels).toBe(1080 * 600);
    // 60 graphemes; 60 distinct emoji at the font's 99th-percentile bitmap (5.1 KB, 6.8 KB base64) come to 410 KB.
    expect(DEFAULT_RASTER_LIMITS.maxSvgBytes).toBe(512 * 1024);
  });

  test("a frame-sized canvas is refused by default", async () => {
    const r = createTextRasteriser(deps());
    const frame = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"/>';
    const error = await failureOf(r.render({ svg: frame, font: "manrope" }));
    expect(error instanceof RasterError && error.code).toBe("RASTER_TOO_LARGE");
  });
});
