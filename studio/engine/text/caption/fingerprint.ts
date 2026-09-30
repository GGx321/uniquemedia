import { createHash } from "node:crypto";
import { TEXT_FONT_KEYS, type TextFontKey } from "../fonts";
import type { CaptionRequest } from "./types";

/**
 * The caption template's known-answer fingerprint (plan 3b.4b): fifteen layers, every font in every style, each with
 * its own caption, colour and scale, drawn through the real layout and template, hashed, and hashed again together.
 * It replaces SP2's `5c996c795344026e`, which belonged to the spike's template.
 *
 * resvg-wasm's arithmetic is deterministic and the fonts and the emoji bitmaps are bundled, so the same bytes come out on
 * macOS, on Windows, in Bun and in Electron's Node (the tests assert each). ANY change to the layout, the template (a
 * padding, a radius, a stroke, the emoji baseline, the escaping) or the fonts moves these hashes, and that is the point:
 * a moved hash is a decision, made by re-pinning it in the same commit as the change, never a surprise.
 */

export const CAPTION_STYLES = ["plaque", "outline", "none"] as const;
export type CaptionStyleKey = (typeof CAPTION_STYLES)[number];

const CAPTIONS: Record<TextFontKey, { value: string; scale: number }> = {
  manrope: { value: "sunday reset ☀️", scale: 1.5 },
  playfair: { value: "golden hour \u{1F305}", scale: 1.25 },
  oswald: { value: "coffee first ☕\r\nno rush", scale: 1 },
  ptmono: { value: "day 01 \u{1F469}‍\u{1F4BB}", scale: 1.5 },
  caveat: { value: "slow morning \u{1F33F}", scale: 2 },
};

/** Per style, the colour of each font's layer, in font order: light and dark, so both ink and both halo colours are covered. */
const COLORS: Record<CaptionStyleKey, readonly string[]> = {
  plaque: ["#ffffff", "#ffd166", "#ff9ec4", "#111111", "#9ad9ff"],
  outline: ["#ffffff", "#ffffff", "#ffd166", "#111111", "#ff7a59"],
  none: ["#ffffff", "#111111", "#ffffff", "#9ad9ff", "#ffffff"],
};

export interface CaptionFingerprintLayer {
  /** `font/style`, the key of the pinned hash. */
  key: string;
  request: CaptionRequest;
}

export const CAPTION_FINGERPRINT_LAYERS: readonly CaptionFingerprintLayer[] = TEXT_FONT_KEYS.flatMap((font, fontIndex) =>
  CAPTION_STYLES.map((style) => ({
    key: `${font}/${style}`,
    request: { ...CAPTIONS[font], font, style, color: COLORS[style][fontIndex] ?? "#ffffff" } satisfies CaptionRequest,
  })),
);

/** sha256 prefix of each layer's PNG. */
export const CAPTION_LAYER_HASHES: Readonly<Record<string, string>> = {
  "manrope/plaque": "3111c6b410a0fd1d",
  "manrope/outline": "c1338c4439f16934",
  "manrope/none": "5bfec1e7ec10348e",
  "playfair/plaque": "3aae689973582184",
  "playfair/outline": "f5e4d8ab55bb5432",
  "playfair/none": "8a23029ae177c18f",
  "oswald/plaque": "1461450923703368",
  "oswald/outline": "3430c2f4d92b435e",
  "oswald/none": "6ecec78da8020138",
  "ptmono/plaque": "4db5463c0ac75b96",
  "ptmono/outline": "3797268de143d5d9",
  "ptmono/none": "5160dfde9259dc84",
  "caveat/plaque": "32bb4299867961ab",
  "caveat/outline": "e6fb0e74b8832f63",
  "caveat/none": "3fcbbdab5ac78f48",
};

/** The fingerprint over the fifteen hashes, in layer order (macOS mac arm64 and Windows agree: see the CI run). */
export const CAPTION_FINGERPRINT = "bc496a2495711c7f";

export function hashOf(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export function fingerprintOf(hashes: Readonly<Record<string, string>>): string {
  return hashOf(CAPTION_FINGERPRINT_LAYERS.map((layer) => hashes[layer.key] ?? "").join(","));
}
