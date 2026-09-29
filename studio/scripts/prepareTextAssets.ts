/**
 * Build-time copy for the text rasteriser (plan 3b.2, N11): after `electron-vite build` writes `out-studio/`
 * (emptied on every build), the resvg `.wasm` and the bundled fonts with their OFL texts are copied in next to
 * the engine entry, `out-studio/engine/wasm/` and `out-studio/engine/fonts/`, so electron-builder.studio.yml's
 * `out-studio/**` glob ships them inside app.asar under the integrity fuse, and engine/main.ts finds them
 * from its own `import.meta.url`. resvg-wasm is a devDependency, so its `.wasm` never reaches the packaged
 * `node_modules` (and never the uniquifier's installer); this copy is the only way it ships.
 *
 * Everything is verified BEFORE anything is copied (the wasm against its pinned sha256, every font against
 * the manifest, every licence present), so a bad input leaves `out-studio` untouched and fails the build.
 * Run by `build:studio` and `build:studio:e2e` (package.json), after the electron-vite step.
 */
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TEXT_ASSET_DIRS } from "../engine/text/assetLayout";
import { EMOJI_FONT, loadEmojiFont, loadTextFonts, TEXT_FONTS } from "../engine/text/fonts";
import { checkRasterWasmBytes, RASTER_WASM } from "../engine/text/rasteriser";

export interface TextAssetPaths {
  fontDir: string;
  wasmPath: string;
}

export function textAssetOutPaths(root: string): TextAssetPaths {
  const engineDir = join(root, "out-studio", "engine");
  return { fontDir: join(engineDir, TEXT_ASSET_DIRS.fonts), wasmPath: join(engineDir, TEXT_ASSET_DIRS.wasm, RASTER_WASM.file) };
}

export interface PrepareTextAssetsOptions {
  /** Where `out-studio/` lives. Default: the repo root. */
  outRoot?: string;
  /** The resvg wasm. Default: the installed `@resvg/resvg-wasm`. */
  wasmSource?: string;
  /** The fonts directory. Default: `studio/assets/fonts`. */
  fontSource?: string;
}

/** Verifies, then copies, the resvg wasm, the six fonts and their six licences. Throws before copying anything if one is wrong. */
export async function prepareTextAssets(root: string, options: PrepareTextAssetsOptions = {}): Promise<TextAssetPaths> {
  const wasmSource = options.wasmSource ?? join(root, "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);
  const fontSource = options.fontSource ?? join(root, "studio", "assets", "fonts");
  const out = textAssetOutPaths(options.outRoot ?? root);

  checkRasterWasmBytes(await readFile(wasmSource), wasmSource);
  await loadTextFonts(fontSource);
  await loadEmojiFont(fontSource);
  const fontFiles = [...Object.values(TEXT_FONTS), EMOJI_FONT].flatMap((spec) => [spec.file, spec.license]);
  for (const file of fontFiles) {
    if (!(await stat(join(fontSource, file)).then((s) => s.isFile(), () => false))) throw new Error(`prepareTextAssets: ${file} is missing from ${fontSource}`);
  }

  await mkdir(out.fontDir, { recursive: true });
  await mkdir(dirname(out.wasmPath), { recursive: true });
  await copyFile(wasmSource, out.wasmPath);
  for (const file of fontFiles) await copyFile(join(fontSource, file), join(out.fontDir, file));
  return out;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..", "..");
  const paths = await prepareTextAssets(root);
  console.log(`text assets copied into ${paths.fontDir} and ${paths.wasmPath}`);
}
