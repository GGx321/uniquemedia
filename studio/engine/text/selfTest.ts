import { createHash } from "node:crypto";
import { TEXT_FONT_KEYS, TEXT_FONTS, type TextFontKey } from "./fonts";
import type { RasterImage, RasterRequest } from "./rasteriser";

/**
 * The rasteriser's known-answer test (plan 3b.2): a fixed Cyrillic-and-Latin
 * string in each of the five fonts, drawn through the real runtime, must come out
 * as the same bytes everywhere. The engine runs it at startup (engine/main.ts) and
 * the packaged smoke (scripts/smoke-engine.ts) checks the fingerprint it reports,
 * so it proves that the wasm and every font load from inside the asar under the
 * fuses and the utilityProcess. The same constant is asserted on macOS and on
 * Windows: resvg's wasm arithmetic is deterministic and the fonts are bundled, so
 * the bytes agree by construction, and a platform that differs fails loudly.
 *
 * This is NOT the caption template (3b.4b's fixed SVG with layout, styles and
 * emoji): SP2's `5c996c795344026e` fingerprint belongs to that layer test.
 */
export const SELF_TEST_TEXT = "Привет, мир! Ёж 2026 Beach";

/** sha256 prefix of the PNG each font draws for `selfTestSvg`. */
export const SELF_TEST_HASHES: Readonly<Record<TextFontKey, string>> = {
  manrope: "1a1b89dbeadc12c1",
  playfair: "fc412d8ba4723819",
  oswald: "b67a68e9131db2e4",
  ptmono: "12281b4834672894",
  caveat: "9b0189d563c2074c",
};

/** The fingerprint over the five hashes, in manifest order. */
export const SELF_TEST_FINGERPRINT = "5e2c4242a26355c2";

export function selfTestSvg(font: TextFontKey): string {
  const spec = TEXT_FONTS[font];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="96" viewBox="0 0 800 96">` +
    `<rect width="800" height="96" rx="20" fill="#ffffff"/>` +
    `<text x="400" y="62" text-anchor="middle" font-family="${spec.family}" font-weight="${spec.weight}" font-size="40" fill="#111111" xml:space="preserve">${SELF_TEST_TEXT}</text>` +
    `</svg>`
  );
}

function prefix(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export interface SelfTestResult {
  hashes: Record<TextFontKey, string>;
  fingerprint: string;
}

/** Draws the string in every font and hashes the results. Rejects with the rasteriser's own error. */
export async function runTextSelfTest(rasteriser: { render(request: RasterRequest): Promise<RasterImage> }): Promise<SelfTestResult> {
  const hashes: Record<TextFontKey, string> = { manrope: "", playfair: "", oswald: "", ptmono: "", caveat: "" };
  for (const font of TEXT_FONT_KEYS) hashes[font] = prefix((await rasteriser.render({ svg: selfTestSvg(font), font })).png);
  return { hashes, fingerprint: prefix(TEXT_FONT_KEYS.map((font) => hashes[font]).join(",")) };
}

/** Runs the self-test and returns its fingerprint, or throws naming the fonts that drew something else. */
export async function assertTextSelfTest(rasteriser: { render(request: RasterRequest): Promise<RasterImage> }): Promise<string> {
  const result = await runTextSelfTest(rasteriser);
  const wrong = TEXT_FONT_KEYS.filter((font) => result.hashes[font] !== SELF_TEST_HASHES[font]);
  if (wrong.length > 0 || result.fingerprint !== SELF_TEST_FINGERPRINT) {
    throw new Error(`text self-test: ${wrong.join(", ") || "the fingerprint"} did not match (got ${result.fingerprint}, expected ${SELF_TEST_FINGERPRINT})`);
  }
  return result.fingerprint;
}
