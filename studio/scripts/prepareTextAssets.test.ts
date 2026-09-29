import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { EMOJI_FONT, TEXT_FONT_KEYS, TEXT_FONTS } from "../engine/text/fonts";
import { loadTextRasteriser } from "../engine/text/load";
import { RASTER_WASM } from "../engine/text/rasteriser";
import { SELF_TEST_FINGERPRINT } from "../engine/text/selfTest";
import { prepareTextAssets, textAssetOutPaths } from "./prepareTextAssets";
useNativeGlobals();

const ROOT = join(import.meta.dir, "..", "..");
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "studio-text-assets-"));
  scratch.push(dir);
  return dir;
}

describe("prepareTextAssets", () => {
  test("copies the wasm, the six fonts and their six licences next to the built engine", async () => {
    const root = await tempDir();
    const paths = await prepareTextAssets(ROOT, { outRoot: root });
    expect(paths).toEqual(textAssetOutPaths(root));
    const fonts = await readdir(paths.fontDir);
    for (const spec of [...Object.values(TEXT_FONTS), EMOJI_FONT]) {
      expect(fonts).toContain(spec.file);
      expect(fonts).toContain(spec.license);
    }
    expect(existsSync(paths.wasmPath)).toBe(true);
    expect(paths.wasmPath.endsWith(RASTER_WASM.file)).toBe(true);
  });

  test("puts them where the engine looks: out-studio/engine/fonts and out-studio/engine/wasm", () => {
    const paths = textAssetOutPaths("/repo");
    expect(paths.fontDir).toBe(join("/repo", "out-studio", "engine", "fonts"));
    expect(paths.wasmPath).toBe(join("/repo", "out-studio", "engine", "wasm", RASTER_WASM.file));
  });

  test("what it copies loads and passes the self-test, as the packaged engine will run it", async () => {
    const root = await tempDir();
    const paths = await prepareTextAssets(ROOT, { outRoot: root });
    const loaded = await loadTextRasteriser({ wasmPath: paths.wasmPath, fontDir: paths.fontDir, log: { info: () => {}, error: () => {} } });
    expect("error" in loaded ? loaded.error : loaded.fingerprint).toBe(SELF_TEST_FINGERPRINT);
  });

  test("refuses a wasm that is not the pinned one and copies nothing", async () => {
    const root = await tempDir();
    const bad = join(await tempDir(), "index_bg.wasm");
    await writeFile(bad, new Uint8Array(100));
    await expect(prepareTextAssets(ROOT, { outRoot: root, wasmSource: bad })).rejects.toThrow(/resvg-wasm/);
    expect(existsSync(join(root, "out-studio"))).toBe(false);
  });

  test("refuses a corrupt font and copies nothing", async () => {
    const root = await tempDir();
    const fonts = await tempDir();
    for (const spec of [...Object.values(TEXT_FONTS), EMOJI_FONT]) {
      await copyFile(join(ROOT, "studio", "assets", "fonts", spec.file), join(fonts, spec.file));
      await copyFile(join(ROOT, "studio", "assets", "fonts", spec.license), join(fonts, spec.license));
    }
    await writeFile(join(fonts, TEXT_FONTS[TEXT_FONT_KEYS[1]].file), new Uint8Array(10));
    await expect(prepareTextAssets(ROOT, { outRoot: root, fontSource: fonts })).rejects.toThrow(TEXT_FONTS.playfair.file);
    expect(existsSync(join(root, "out-studio"))).toBe(false);
  });

  test("refuses a missing licence: a font must never ship without its OFL text", async () => {
    const root = await tempDir();
    const fonts = await tempDir();
    for (const spec of [...Object.values(TEXT_FONTS), EMOJI_FONT]) {
      await copyFile(join(ROOT, "studio", "assets", "fonts", spec.file), join(fonts, spec.file));
      if (spec.license !== TEXT_FONTS.oswald.license) await copyFile(join(ROOT, "studio", "assets", "fonts", spec.license), join(fonts, spec.license));
    }
    await expect(prepareTextAssets(ROOT, { outRoot: root, fontSource: fonts })).rejects.toThrow(TEXT_FONTS.oswald.license);
    expect(existsSync(join(root, "out-studio"))).toBe(false);
  });

  test("is safe to run twice over the same output", async () => {
    const root = await tempDir();
    await prepareTextAssets(ROOT, { outRoot: root });
    await prepareTextAssets(ROOT, { outRoot: root });
    expect((await readdir(textAssetOutPaths(root).fontDir)).length).toBe(12);
  });
});
