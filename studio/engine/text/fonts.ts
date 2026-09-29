import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The bundled fonts (plan 3b.2, invariant 22): the five on-video text fonts and
 * the Noto Color Emoji CBDT bitmap font, all SIL OFL 1.1, committed under
 * `studio/assets/fonts/` next to their licence texts. Text renders only from
 * these bytes, never from a system font, and every file is pinned by size and
 * sha256, so a swapped, truncated or re-cut file fails at load instead of
 * changing a caption.
 *
 * The engine resolves no path itself (runtime.test.ts): `loadTextFonts` takes
 * the directory as a parameter. The engine entry passes `out-studio/engine/
 * fonts` (copied there at build time by scripts/prepareTextAssets.ts, so it
 * sits inside app.asar), tests and dev pass the repo's `studio/assets/fonts`.
 *
 * Provenance (also in studio/assets/fonts/README.md):
 * - Playfair Display and PT Mono carry a Reserved Font Name, which OFL forbids
 *   on a modified version, so both are official statics, never re-cut:
 *   Playfair's is `static/PlayfairDisplay-SemiBold.ttf` from Google Fonts'
 *   own download (v40, URL in README.md), PT Mono's is ParaType's `PTM55FT.ttf`.
 * - Manrope, Oswald and Caveat have no Reserved Font Name; their statics are
 *   instances of the variable fonts (fontTools 4.66.1 `varLib.instancer`
 *   wght=800/600/600, names rewritten, byte-reproducible: recipe/make-statics.sh),
 *   because resvg 2.6.x does not instantiate variable fonts.
 * - Noto Color Emoji is `NotoColorEmoji.ttf` (CBDT) of noto-emoji v2.051.
 */
export const TEXT_FONT_KEYS = ["manrope", "playfair", "oswald", "ptmono", "caveat"] as const;
export type TextFontKey = (typeof TEXT_FONT_KEYS)[number];

export interface FontSpec {
  /** File name inside the fonts directory. */
  file: string;
  /** The OFL text shipped next to it. */
  license: string;
  sha256: string;
  bytes: number;
}

export interface TextFontSpec extends FontSpec {
  /** The `font-family` the SVG template names and resvg matches. */
  family: string;
  /** The static instance's weight, the `font-weight` the template names. */
  weight: number;
  origin: "official-static" | "instanced";
}

export const TEXT_FONTS: Readonly<Record<TextFontKey, TextFontSpec>> = {
  manrope: {
    file: "Manrope-800.ttf",
    license: "Manrope-OFL.txt",
    family: "Manrope",
    weight: 800,
    origin: "instanced",
    sha256: "fd48ef02aef3f232b44f7ba94c54316a0d2a079eb04bcadb08ece575e624ae1a",
    bytes: 98_056,
  },
  playfair: {
    file: "PlayfairDisplay-600.ttf",
    license: "PlayfairDisplay-OFL.txt",
    family: "Playfair Display",
    weight: 600,
    origin: "official-static",
    sha256: "0f8ae66ea018739838dac8fc0a70f9dd6fe8806bf4f63bb35b3c643480221d31",
    bytes: 193_832,
  },
  oswald: {
    file: "Oswald-600.ttf",
    license: "Oswald-OFL.txt",
    family: "Oswald",
    weight: 600,
    origin: "instanced",
    sha256: "eafab583787ca3ef1871f7f1a6c4129db2a9349c2684386068f2fea6cb601de0",
    bytes: 88_932,
  },
  ptmono: {
    file: "PTMono-400.ttf",
    license: "PTMono-OFL.txt",
    family: "PT Mono",
    weight: 400,
    origin: "official-static",
    sha256: "cbe732b3b8fd211fd986ebdfc9b870ddeca4faab0bb5425fc509b37f9b4ac804",
    bytes: 185_912,
  },
  caveat: {
    file: "Caveat-600.ttf",
    license: "Caveat-OFL.txt",
    family: "Caveat",
    weight: 600,
    origin: "instanced",
    sha256: "a16825c74473761bf0c5d026c0651acae63d280b8030bc206374bb5ef7460f67",
    bytes: 267_148,
  },
};

/** Noto Color Emoji, CBDT v2.051. resvg 2.6.2 cannot draw it; the emoji reader (3b.4a) reads its bitmaps. */
export const EMOJI_FONT: FontSpec = {
  file: "NotoColorEmoji.ttf",
  license: "NotoColorEmoji-OFL.txt",
  sha256: "72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b",
  bytes: 10_673_480,
};

export type FontLoadErrorCode = "FONT_MISSING" | "FONT_CORRUPT" | "FONT_UNREADABLE";

export class FontLoadError extends Error {
  readonly code: FontLoadErrorCode;
  readonly file: string;

  constructor(code: FontLoadErrorCode, file: string, message: string, options?: ErrorOptions) {
    super(`fonts: ${file}: ${message}`, options);
    this.name = "FontLoadError";
    this.code = code;
    this.file = file;
  }
}

/** How a file is read; tests inject a failing one. */
export type ReadBytes = (path: string) => Promise<Uint8Array>;

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function loadVerified(dir: string, spec: FontSpec, read: ReadBytes): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await read(join(dir, spec.file));
  } catch (cause) {
    if (isNotFound(cause)) throw new FontLoadError("FONT_MISSING", spec.file, `not found in ${dir}`, { cause });
    throw new FontLoadError("FONT_UNREADABLE", spec.file, "could not be read", { cause });
  }
  if (bytes.byteLength !== spec.bytes) {
    throw new FontLoadError("FONT_CORRUPT", spec.file, `is ${bytes.byteLength} bytes, expected ${spec.bytes}`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== spec.sha256) throw new FontLoadError("FONT_CORRUPT", spec.file, `sha256 mismatch (expected ${spec.sha256}, got ${actual})`);
  return bytes;
}

/** Reads and verifies the five text fonts, in manifest order. Rejects with a `FontLoadError` naming the first bad file. */
export async function loadTextFonts(dir: string, read: ReadBytes = readFile): Promise<Record<TextFontKey, Uint8Array>> {
  return {
    manrope: await loadVerified(dir, TEXT_FONTS.manrope, read),
    playfair: await loadVerified(dir, TEXT_FONTS.playfair, read),
    oswald: await loadVerified(dir, TEXT_FONTS.oswald, read),
    ptmono: await loadVerified(dir, TEXT_FONTS.ptmono, read),
    caveat: await loadVerified(dir, TEXT_FONTS.caveat, read),
  };
}

/** Reads and verifies the emoji font (10.7 MB). Only the emoji reader (3b.4a) needs it. */
export function loadEmojiFont(dir: string, read: ReadBytes = readFile): Promise<Uint8Array> {
  return loadVerified(dir, EMOJI_FONT, read);
}
