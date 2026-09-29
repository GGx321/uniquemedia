// Pure checks behind the text rasteriser part of smoke-engine.ts (plan 3b.2), kept apart so they are tested.
import { TEXT_ASSET_DIRS } from "../engine/text/assetLayout";
import { EMOJI_FONT, TEXT_FONTS } from "../engine/text/fonts";
import { TEXT_RASTERISER_READY_PREFIX } from "../engine/text/load";
import { RASTER_WASM } from "../engine/text/rasteriser";
import { SELF_TEST_FINGERPRINT } from "../engine/text/selfTest";

const LOAD_FAILURE = "the text rasteriser could not be loaded";

/**
 * Problems with what the engine printed about the rasteriser. The ready line carries the fingerprint of the
 * engine's own startup self-test (a Cyrillic string in each of the five fonts), so a match proves the wasm and
 * every font were read, compiled and drawn inside the real utilityProcess of the package under test. The
 * same pinned fingerprint is asserted on macOS and on Windows. With several engine starts in the output the
 * last ready line counts; an engine load-failure line is a problem wherever it is.
 */
export function textRasteriserOutputProblems(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const problems: string[] = [];
  const ready = lines.filter((line) => line.startsWith(TEXT_RASTERISER_READY_PREFIX));
  const last = ready[ready.length - 1];
  if (last === undefined) problems.push("the engine never reported the text rasteriser as ready");
  else {
    const fingerprint = last.slice(TEXT_RASTERISER_READY_PREFIX.length).trim();
    if (fingerprint !== SELF_TEST_FINGERPRINT) problems.push(`the text self-test fingerprint is ${fingerprint}, expected ${SELF_TEST_FINGERPRINT}`);
  }
  for (const line of lines) if (line.includes(LOAD_FAILURE)) problems.push(line.trim());
  return problems;
}

/** The asar entries (with a leading slash, as `listPackage` prints them) the rasteriser needs. */
export function textAssetPackageProblems(entries: readonly string[]): string[] {
  const present = new Set(entries);
  const fonts = `/out-studio/engine/${TEXT_ASSET_DIRS.fonts}`;
  const wanted = [
    `/out-studio/engine/${TEXT_ASSET_DIRS.wasm}/${RASTER_WASM.file}`,
    ...[...Object.values(TEXT_FONTS), EMOJI_FONT].flatMap((font) => [`${fonts}/${font.file}`, `${fonts}/${font.license}`]),
  ];
  return wanted.filter((path) => !present.has(path)).map((path) => `${path} is not in the package`);
}
