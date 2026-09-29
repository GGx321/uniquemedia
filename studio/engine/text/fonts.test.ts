import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMOJI_FONT, FontLoadError, loadEmojiFont, loadTextFonts, TEXT_FONT_KEYS, TEXT_FONTS, type TextFontKey } from "./fonts";
import { TextFont } from "../../shared/engine/montage";
import { cmapCoverage, fontInfo } from "./sfnt";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const FONT_DIR = join(import.meta.dir, "..", "..", "assets", "fonts");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function copyOfFonts(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "studio-fonts-"));
  scratch.push(dir);
  for (const spec of [...Object.values(TEXT_FONTS), EMOJI_FONT]) await copyFile(join(FONT_DIR, spec.file), join(dir, spec.file));
  return dir;
}

async function expectFontError(promise: Promise<unknown>, code: FontLoadError["code"], file: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FontLoadError);
  if (!(error instanceof FontLoadError)) return;
  expect(error.code).toBe(code);
  expect(error.file).toBe(file);
}

describe("the font manifest", () => {
  test("lists the five on-video fonts of the plan, each with its own weight", () => {
    expect(TEXT_FONT_KEYS).toEqual(["manrope", "playfair", "oswald", "ptmono", "caveat"]);
    expect(TEXT_FONTS.manrope).toMatchObject({ family: "Manrope", weight: 800 });
    expect(TEXT_FONTS.playfair).toMatchObject({ family: "Playfair Display", weight: 600 });
    expect(TEXT_FONTS.oswald).toMatchObject({ family: "Oswald", weight: 600 });
    expect(TEXT_FONTS.ptmono).toMatchObject({ family: "PT Mono", weight: 400 });
    expect(TEXT_FONTS.caveat).toMatchObject({ family: "Caveat", weight: 600 });
  });

  test("ships an OFL text next to every font, the emoji font included", async () => {
    for (const spec of [...Object.values(TEXT_FONTS), EMOJI_FONT]) {
      const text = await readFile(join(FONT_DIR, spec.license), "utf8");
      expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });

  test("keeps the Reserved Font Name holders as the official statics, never re-cut", async () => {
    // Playfair Display and PT Mono carry a Reserved Font Name: OFL forbids that name on a modified version.
    for (const key of ["playfair", "ptmono"] as const) expect(TEXT_FONTS[key].origin).toBe("official-static");
    for (const key of ["manrope", "oswald", "caveat"] as const) expect(TEXT_FONTS[key].origin).toBe("instanced");
    for (const key of ["playfair", "ptmono"] as const) {
      const license = await readFile(join(FONT_DIR, TEXT_FONTS[key].license), "utf8");
      expect(license).toContain("Reserved Font Name");
    }
  });
});

describe("loadTextFonts", () => {
  test("returns the bytes of every text font, sha256-verified, from the repo's assets", async () => {
    const fonts = await loadTextFonts(FONT_DIR);
    for (const key of TEXT_FONT_KEYS) expect(fonts[key].byteLength).toBe(TEXT_FONTS[key].bytes);
  });

  test("refuses a missing font file and names it", async () => {
    const dir = await copyOfFonts();
    await rm(join(dir, TEXT_FONTS.oswald.file));
    await expectFontError(loadTextFonts(dir), "FONT_MISSING", TEXT_FONTS.oswald.file);
  });

  test("refuses a font whose bytes differ by one byte from the pinned hash", async () => {
    const dir = await copyOfFonts();
    const path = join(dir, TEXT_FONTS.caveat.file);
    const bytes = new Uint8Array(await readFile(path));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await writeFile(path, bytes);
    await expectFontError(loadTextFonts(dir), "FONT_CORRUPT", TEXT_FONTS.caveat.file);
  });

  test("refuses an empty font file", async () => {
    const dir = await copyOfFonts();
    await writeFile(join(dir, TEXT_FONTS.manrope.file), new Uint8Array(0));
    await expectFontError(loadTextFonts(dir), "FONT_CORRUPT", TEXT_FONTS.manrope.file);
  });

  test("reports a directory that does not exist as a missing font, not a crash", async () => {
    await expectFontError(loadTextFonts(join(FONT_DIR, "nope")), "FONT_MISSING", TEXT_FONTS.manrope.file);
  });

  test("propagates an unreadable font as a failure with the cause attached, never as missing", async () => {
    const boom = new Error("EIO");
    const error = await loadTextFonts(FONT_DIR, () => Promise.reject(boom)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FontLoadError);
    expect(error instanceof FontLoadError && error.code).toBe("FONT_UNREADABLE");
    expect(error instanceof Error && error.cause).toBe(boom);
  });
});

describe("loadEmojiFont", () => {
  test("returns the Noto Color Emoji CBDT bytes, sha256-verified", async () => {
    const bytes = await loadEmojiFont(FONT_DIR);
    expect(bytes.byteLength).toBe(EMOJI_FONT.bytes);
  });

  test("refuses a corrupt emoji font", async () => {
    const dir = await copyOfFonts();
    await writeFile(join(dir, EMOJI_FONT.file), new Uint8Array(1024));
    await expectFontError(loadEmojiFont(dir), "FONT_CORRUPT", EMOJI_FONT.file);
  });
});

// Invariant 22: a static test proves every text TTF covers the allowed charset, so no caption draws tofu.
describe("cmap coverage of the text fonts", () => {
  const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const PRINTABLE_ASCII = range(0x20, 0x7e);
  const TYPOGRAPHIC = [0x2019, 0x2018, 0x201c, 0x201d, 0x2013, 0x2014, 0x2026];
  const CYRILLIC = [...range(0x0410, 0x044f), 0x0401, 0x0451];

  test.each([...TEXT_FONT_KEYS])("%s covers printable ASCII, the typographic marks and the Russian alphabet", async (key: TextFontKey) => {
    const fonts = await loadTextFonts(FONT_DIR);
    const has = cmapCoverage(fonts[key]);
    const missing = [...PRINTABLE_ASCII, ...TYPOGRAPHIC, ...CYRILLIC].filter((cp) => !has(cp));
    expect(missing.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`)).toEqual([]);
  });

  test("does not claim a code point the font lacks", async () => {
    const fonts = await loadTextFonts(FONT_DIR);
    expect(cmapCoverage(fonts.manrope)(0x1f600)).toBe(false);
  });

  test("refuses bytes that are not an sfnt font", () => {
    expect(() => cmapCoverage(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

// A static cut from a variable font keeps the variable font's default names unless they are rewritten: Manrope 800
// once called itself "Manrope ExtraLight". resvg matches by family and weight, so the names are part of the contract.
describe("the font keys", () => {
  test("are exactly the contract's TextFont, in the same order", () => {
    expect([...TEXT_FONT_KEYS]).toEqual([...TextFont.options]);
  });
});

describe("the name tables of the text fonts", () => {
  const WEIGHT_NAMES: Record<number, string> = { 400: "Regular", 600: "SemiBold", 800: "ExtraBold" };

  test.each([...TEXT_FONT_KEYS])("%s names its family and weight as the manifest says", async (key: TextFontKey) => {
    const fonts = await loadTextFonts(FONT_DIR);
    const spec = TEXT_FONTS[key];
    const info = fontInfo(fonts[key]);
    expect(info.families).toContain(spec.family);
    expect(info.weightClass).toBe(spec.weight);
    const weightName = WEIGHT_NAMES[spec.weight] ?? "";
    expect(info.fullName === spec.family || info.fullName === `${spec.family} ${weightName}`).toBe(true);
    expect(info.variable).toBe(false);
  });
});
