import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { TEXT_FONTS } from "./fonts";
import { loadTextRasteriser, TEXT_RASTERISER_READY_PREFIX, type TextRuntimeLog } from "./load";
import { RASTER_WASM } from "./rasteriser";
import { SELF_TEST_FINGERPRINT, selfTestSvg } from "./selfTest";
useNativeGlobals();

const FONT_DIR = join(import.meta.dir, "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

function recordingLog(): TextRuntimeLog & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return { infos, errors, info: (m) => infos.push(m), error: (m) => errors.push(m) };
}

describe("loadTextRasteriser", () => {
  test("loads, runs the self-test and reports the fingerprint on a healthy install", async () => {
    const log = recordingLog();
    const loaded = await loadTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR, log });
    expect("error" in loaded).toBe(false);
    if ("error" in loaded) return;
    expect(loaded.fingerprint).toBe(SELF_TEST_FINGERPRINT);
    expect(log.infos).toEqual([`${TEXT_RASTERISER_READY_PREFIX}${SELF_TEST_FINGERPRINT}`]);
    expect(log.errors).toEqual([]);
  });

  test("hands back a rasteriser that is already initialised", async () => {
    const loaded = await loadTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR, log: recordingLog() });
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.rasteriser.measure({ svg: selfTestSvg("manrope"), font: "manrope" })?.width).toBeGreaterThan(0);
  });

  test("never throws: a missing wasm is an error result and one logged line, with no ready line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-text-load-"));
    scratch.push(dir);
    const log = recordingLog();
    const loaded = await loadTextRasteriser({ wasmPath: join(dir, "index_bg.wasm"), fontDir: FONT_DIR, log });
    expect("error" in loaded && loaded.error).toContain("WASM");
    expect(log.errors).toHaveLength(1);
    expect(log.infos).toEqual([]);
  });

  test("reports a corrupt font as an error result naming the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-text-load-"));
    scratch.push(dir);
    for (const spec of Object.values(TEXT_FONTS)) await copyFile(join(FONT_DIR, spec.file), join(dir, spec.file));
    await writeFile(join(dir, TEXT_FONTS.playfair.file), new Uint8Array(64));
    const log = recordingLog();
    const loaded = await loadTextRasteriser({ wasmPath: WASM_PATH, fontDir: dir, log });
    expect("error" in loaded && loaded.error).toContain(TEXT_FONTS.playfair.file);
    expect(log.infos).toEqual([]);
  });

  test("reports a self-test that draws something else as an error result, with no ready line", async () => {
    const log = recordingLog();
    const loaded = await loadTextRasteriser({
      wasmPath: WASM_PATH,
      fontDir: FONT_DIR,
      log,
      selfTest: () => Promise.reject(new Error("text self-test: oswald did not match")),
    });
    expect("error" in loaded && loaded.error).toContain("oswald");
    expect(log.errors).toHaveLength(1);
    expect(log.infos).toEqual([]);
  });

  test("gives up on a load that hangs, so the engine can start without it", async () => {
    const log = recordingLog();
    const started = performance.now();
    const loaded = await loadTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR, log, timeoutMs: 50, readFile: () => new Promise(() => {}) });
    expect("error" in loaded && loaded.error).toContain("50 ms");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
