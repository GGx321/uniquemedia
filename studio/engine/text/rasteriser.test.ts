import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEXT_FONT_KEYS, TEXT_FONTS } from "./fonts";
import { createTextRasteriser, DEFAULT_RASTER_LIMITS, RASTER_WASM, RasterError, type RasterDeps, type RasterErrorCode } from "./rasteriser";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const FONT_DIR = join(import.meta.dir, "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "studio-raster-"));
  scratch.push(dir);
  return dir;
}

function deps(over: Partial<RasterDeps> = {}): RasterDeps {
  return { wasmPath: WASM_PATH, fontDir: FONT_DIR, ...over };
}

function svg(text: string, size = { width: 240, height: 64 }): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">` +
    `<text x="8" y="44" font-family="Manrope" font-weight="800" font-size="36" fill="#ffffff" xml:space="preserve">${text}</text></svg>`
  );
}

async function codeOf(promise: Promise<unknown>): Promise<RasterErrorCode | "not a RasterError"> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error instanceof RasterError ? error.code : "not a RasterError";
}

describe("the pinned resvg wasm", () => {
  test("is the 2.6.2 file the plan pins, byte for byte", async () => {
    const bytes = await readFile(WASM_PATH);
    expect(RASTER_WASM.version).toBe("2.6.2");
    expect(bytes.byteLength).toBe(RASTER_WASM.bytes);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(RASTER_WASM.sha256);
  });

  test("matches the exact version in package.json, with no range", async () => {
    const pkg: unknown = JSON.parse(await readFile(join(import.meta.dir, "..", "..", "..", "package.json"), "utf8"));
    const dev = typeof pkg === "object" && pkg !== null && "devDependencies" in pkg && typeof pkg.devDependencies === "object" ? pkg.devDependencies : null;
    expect(dev !== null && "@resvg/resvg-wasm" in dev ? dev["@resvg/resvg-wasm"] : null).toBe("2.6.2");
  });
});

describe("init", () => {
  test("is idempotent: concurrent and repeated calls run initWasm once", async () => {
    let calls = 0;
    const r = createTextRasteriser(deps({ initWasm: () => (calls++, Promise.resolve()) }));
    await Promise.all([r.init(), r.init()]);
    await r.init();
    expect(calls).toBe(1);
  });

  test("is shared by every rasteriser of the process, since resvg can be initialised only once", async () => {
    let calls = 0;
    const initWasm = (): Promise<void> => (calls++, Promise.resolve());
    await createTextRasteriser(deps({ initWasm })).init();
    await createTextRasteriser(deps({ initWasm })).init();
    expect(calls).toBe(1);
  });

  test("two rasterisers on the real resvg both work", async () => {
    const a = createTextRasteriser(deps());
    const b = createTextRasteriser(deps());
    await Promise.all([a.init(), b.init()]);
    expect((await a.render({ svg: svg("a"), font: "manrope" })).width).toBe(240);
    expect((await b.render({ svg: svg("b"), font: "manrope" })).width).toBe(240);
  });

  test("fails with WASM_UNAVAILABLE when the wasm file is missing", async () => {
    const dir = await scratchDir();
    expect(await codeOf(createTextRasteriser(deps({ wasmPath: join(dir, "index_bg.wasm") })).init())).toBe("WASM_UNAVAILABLE");
  });

  test("fails with WASM_UNAVAILABLE when the wasm file is not the pinned one", async () => {
    const dir = await scratchDir();
    const path = join(dir, "index_bg.wasm");
    const bytes = new Uint8Array(await readFile(WASM_PATH));
    bytes[100] = (bytes[100] ?? 0) ^ 1;
    await writeFile(path, bytes);
    expect(await codeOf(createTextRasteriser(deps({ wasmPath: path })).init())).toBe("WASM_UNAVAILABLE");
  });

  test("fails with WASM_UNAVAILABLE, keeping the cause, when resvg itself refuses to initialise", async () => {
    const boom = new Error("compile failed");
    const r = createTextRasteriser(deps({ initWasm: () => Promise.reject(boom) }));
    const error = await r.init().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RasterError);
    expect(error instanceof RasterError && error.code).toBe("WASM_UNAVAILABLE");
    expect(error instanceof Error && error.cause).toBe(boom);
  });

  test("fails with FONT_UNAVAILABLE when a font is missing", async () => {
    const dir = await scratchDir();
    for (const spec of Object.values(TEXT_FONTS)) if (spec.file !== TEXT_FONTS.oswald.file) await copyFile(join(FONT_DIR, spec.file), join(dir, spec.file));
    expect(await codeOf(createTextRasteriser(deps({ fontDir: dir })).init())).toBe("FONT_UNAVAILABLE");
  });

  test("does not remember a failure: the next init retries and can succeed", async () => {
    let attempts = 0;
    const flaky = (path: string): Promise<Uint8Array> => (attempts++ === 0 ? Promise.reject(new Error("EIO")) : readFile(path));
    const r = createTextRasteriser(deps({ readFile: flaky }));
    expect(await codeOf(r.init())).toBe("WASM_UNAVAILABLE");
    await r.init();
    expect((await r.render({ svg: svg("ok"), font: "manrope" })).width).toBe(240);
  });

  test("render initialises on its own when init was never called", async () => {
    const r = createTextRasteriser(deps());
    expect((await r.render({ svg: svg("lazy"), font: "manrope" })).png.length).toBeGreaterThan(0);
  });
});

describe("render", () => {
  test("returns a PNG of the SVG's own size", async () => {
    const r = createTextRasteriser(deps());
    const image = await r.render({ svg: svg("Привет"), font: "manrope" });
    expect([...image.png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(image.width).toBe(240);
    expect(image.height).toBe(64);
  });

  test("draws a different picture for each font", async () => {
    const r = createTextRasteriser(deps());
    const hashes = new Set<string>();
    for (const font of TEXT_FONT_KEYS) {
      const spec = TEXT_FONTS[font];
      const source = svg("Привет").replace('font-family="Manrope" font-weight="800"', `font-family="${spec.family}" font-weight="${spec.weight}"`);
      hashes.add(new Bun.CryptoHasher("sha256").update((await r.render({ svg: source, font })).png).digest("hex"));
    }
    expect(hashes.size).toBe(5);
  });

  test("renders the same bytes every time", async () => {
    const r = createTextRasteriser(deps());
    const hashes = new Set<string>();
    for (let i = 0; i < 10; i++) hashes.add(new Bun.CryptoHasher("sha256").update((await r.render({ svg: svg("Ёжик 123"), font: "manrope" })).png).digest("hex"));
    expect(hashes.size).toBe(1);
  });

  test("refuses a control character with RENDER_FAILED, never a fallback picture", async () => {
    const r = createTextRasteriser(deps());
    expect(await codeOf(r.render({ svg: svg("a\u0001b"), font: "manrope" }))).toBe("RENDER_FAILED");
  });

  test("refuses malformed XML with RENDER_FAILED", async () => {
    const r = createTextRasteriser(deps());
    expect(await codeOf(r.render({ svg: "<svg", font: "manrope" }))).toBe("RENDER_FAILED");
  });

  test("refuses an empty string with RENDER_FAILED", async () => {
    const r = createTextRasteriser(deps());
    expect(await codeOf(r.render({ svg: "", font: "manrope" }))).toBe("RENDER_FAILED");
  });

  test("a failed render leaves the next one working", async () => {
    const r = createTextRasteriser(deps());
    await codeOf(r.render({ svg: "<svg", font: "manrope" }));
    expect((await r.render({ svg: svg("still fine"), font: "manrope" })).width).toBe(240);
  });

  test("refuses an SVG over the byte cap with SVG_TOO_LARGE, before parsing it", async () => {
    const r = createTextRasteriser(deps({ limits: { maxSvgBytes: 100 } }));
    expect(await codeOf(r.render({ svg: svg("x"), font: "manrope" }))).toBe("SVG_TOO_LARGE");
  });

  test("counts the SVG's bytes, not its UTF-16 units", async () => {
    const source = svg("Ё");
    const bytes = new TextEncoder().encode(source).length;
    expect(bytes).toBeGreaterThan(source.length);
    const atLimit = createTextRasteriser(deps({ limits: { maxSvgBytes: bytes } }));
    expect((await atLimit.render({ svg: source, font: "manrope" })).width).toBe(240);
    const oneUnder = createTextRasteriser(deps({ limits: { maxSvgBytes: bytes - 1 } }));
    expect(await codeOf(oneUnder.render({ svg: source, font: "manrope" }))).toBe("SVG_TOO_LARGE");
  });

  test("refuses a canvas over the pixel cap with RASTER_TOO_LARGE, before allocating it", async () => {
    const r = createTextRasteriser(deps());
    const huge = svg("x", { width: 100_000, height: 100_000 });
    expect(await codeOf(r.render({ svg: huge, font: "manrope" }))).toBe("RASTER_TOO_LARGE");
  });

  test("accepts a canvas of exactly the pixel cap and refuses one pixel more", async () => {
    const r = createTextRasteriser(deps({ limits: { maxPixels: 240 * 64 } }));
    expect((await r.render({ svg: svg("x"), font: "manrope" })).height).toBe(64);
    expect(await codeOf(r.render({ svg: svg("x", { width: 240, height: 65 }), font: "manrope" }))).toBe("RASTER_TOO_LARGE");
  });

  test("refuses output over the byte cap with OUTPUT_TOO_LARGE", async () => {
    const r = createTextRasteriser(deps({ limits: { maxOutputBytes: 50 } }));
    expect(await codeOf(r.render({ svg: svg("x"), font: "manrope" }))).toBe("OUTPUT_TOO_LARGE");
  });

  test("fails a render that overran its deadline with RENDER_TIMEOUT and returns no picture", async () => {
    let now = 0;
    const r = createTextRasteriser(deps({ limits: { timeoutMs: 1000 }, now: () => (now += 5000) }));
    expect(await codeOf(r.render({ svg: svg("slow"), font: "manrope" }))).toBe("RENDER_TIMEOUT");
  });

  test("keeps a render that finished exactly on its deadline", async () => {
    let now = 0;
    const r = createTextRasteriser(deps({ limits: { timeoutMs: 1000 }, now: () => (now += 1000) }));
    expect((await r.render({ svg: svg("edge"), font: "manrope" })).width).toBe(240);
  });

  test("ships a positive deadline by default", () => {
    expect(DEFAULT_RASTER_LIMITS.timeoutMs).toBeGreaterThan(0);
  });

  test("gives the event loop a turn between queued renders", async () => {
    const r = createTextRasteriser(deps());
    await r.init();
    let turns = 0;
    let running = true;
    const spin = (): void => {
      turns++;
      if (running) setImmediate(spin);
    };
    setImmediate(spin);
    await Promise.all([1, 2, 3, 4].map((n) => r.render({ svg: svg(String(n)), font: "manrope" })));
    running = false;
    // Four back-to-back renders were separated by at least three loop turns.
    expect(turns).toBeGreaterThanOrEqual(3);
  });

  test("answers concurrent renders in the order they were asked", async () => {
    const r = createTextRasteriser(deps());
    const sizes = [80, 120, 160];
    const images = await Promise.all(sizes.map((width) => r.render({ svg: svg("x", { width, height: 40 }), font: "manrope" })));
    expect(images.map((i) => i.width)).toEqual(sizes);
  });
});

describe("measure", () => {
  test("gives the ink box of the text, wider for a longer string", async () => {
    const r = createTextRasteriser(deps());
    await r.init();
    const short = r.measure({ svg: svg("Да"), font: "manrope" });
    const long = r.measure({ svg: svg("Да, конечно"), font: "manrope" });
    expect(short?.width).toBeGreaterThan(0);
    expect(long?.width).toBeGreaterThan(short?.width ?? Infinity);
  });

  test("returns null for an SVG with nothing to draw", async () => {
    const r = createTextRasteriser(deps());
    await r.init();
    expect(r.measure({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', font: "manrope" })).toBeNull();
  });

  test("throws NOT_INITIALISED before init, since it is synchronous", () => {
    const r = createTextRasteriser(deps());
    expect(() => r.measure({ svg: svg("x"), font: "manrope" })).toThrow(RasterError);
  });

  test("throws RENDER_FAILED on a control character, like render", async () => {
    const r = createTextRasteriser(deps());
    await r.init();
    expect(() => r.measure({ svg: svg("a\u0001"), font: "manrope" })).toThrow(RasterError);
  });

  test("refuses an SVG over the byte cap with SVG_TOO_LARGE", async () => {
    const r = createTextRasteriser(deps({ limits: { maxSvgBytes: 100 } }));
    await r.init();
    let code: string | null = null;
    try {
      r.measure({ svg: svg("x"), font: "manrope" });
    } catch (e) {
      code = e instanceof RasterError ? e.code : null;
    }
    expect(code).toBe("SVG_TOO_LARGE");
  });
});
