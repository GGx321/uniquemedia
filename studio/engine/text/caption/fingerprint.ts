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

/**
 * Layers that pin more than the font's own caption: a long one that wraps (with the three characters that are markup, so the
 * escaping and the wrapping arithmetic are pinned across platforms together), and one whose ends stick out past their advance
 * (Caveat's bracket and its j), so the ink-sized box is pinned too.
 */
const OVERRIDES: Readonly<Record<string, { value: string; scale: number }>> = {
  "playfair/outline": { value: "coffee & cake <3 > tea & toast, no rush, just slow sips ☕", scale: 1.5 },
  "caveat/outline": { value: "jump, chef & brief [", scale: 2 },
};

export const CAPTION_FINGERPRINT_LAYERS: readonly CaptionFingerprintLayer[] = TEXT_FONT_KEYS.flatMap((font, fontIndex) =>
  CAPTION_STYLES.map((style) => {
    const key = `${font}/${style}`;
    return { key, request: { ...(OVERRIDES[key] ?? CAPTIONS[font]), font, style, color: COLORS[style][fontIndex] ?? "#ffffff" } satisfies CaptionRequest };
  }),
);

/** sha256 prefix of each layer's PNG. */
export const CAPTION_LAYER_HASHES: Readonly<Record<string, string>> = {
  "manrope/plaque": "08540547ec4c6f27",
  "manrope/outline": "8cb8ba7e2ce5f958",
  "manrope/none": "56445bf444fdef38",
  "playfair/plaque": "37e6a91bbad086f9",
  "playfair/outline": "c58369618c98a1d3",
  "playfair/none": "45290c9df808dc6a",
  "oswald/plaque": "794c850692d92f3a",
  "oswald/outline": "3ec51ffd3821d314",
  "oswald/none": "252911a42744891b",
  "ptmono/plaque": "6ce987d00b5381d0",
  "ptmono/outline": "42828bd727f10a9b",
  "ptmono/none": "289430338f1b1ff1",
  "caveat/plaque": "92e4aa5a15478fc1",
  "caveat/outline": "b31dc077b3344eb5",
  "caveat/none": "21f739b10b3bc0fc",
};

/** The fingerprint over the fifteen hashes, in layer order. CI asserts it on macOS and on Windows. */
export const CAPTION_FINGERPRINT = "7adf42174a44da99";

export function hashOf(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export function fingerprintOf(hashes: Readonly<Record<string, string>>): string {
  return hashOf(CAPTION_FINGERPRINT_LAYERS.map((layer) => hashes[layer.key] ?? "").join(","));
}
