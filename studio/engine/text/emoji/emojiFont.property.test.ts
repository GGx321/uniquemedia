import { beforeAll, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { type EmojiFont, openEmojiFont } from "./emojiFont";
import { type EmojiTestEntry, keyOf, loadEmojiTest, loadHarfBuzzGlyphs, loadPinnedEmojiFont } from "./emojiFont.testkit";
useNativeGlobals();

// Invariant 22, the property test: the reader's GSUB pass is a simplification (lookups in lookup order, no
// script/feature selection), so it is checked against the WHOLE Unicode emoji-test.txt for the version Noto Color
// Emoji v2.051 was cut for (Emoji 16.0), and against HarfBuzz's own glyph ids for it.

let font: EmojiFont;
let entries: EmojiTestEntry[];
let fullyQualified: EmojiTestEntry[];
let harfBuzz: Map<string, number>;

beforeAll(async () => {
  font = openEmojiFont(await loadPinnedEmojiFont());
  entries = await loadEmojiTest();
  fullyQualified = entries.filter((e) => e.status === "fully-qualified");
  harfBuzz = await loadHarfBuzzGlyphs();
});

/** Noto v2.051 covers Emoji 16.0 completely; anything newer than it would be listed here with its reason. */
const KNOWN_UNSUPPORTED: readonly string[] = [];

describe("every fully-qualified emoji of Emoji 16.0", () => {
  test("the list is Emoji 16.0 and none of it is newer than Noto v2.051", () => {
    const newest = Math.max(...entries.map((e) => Number(e.since.slice(1))));
    expect([fullyQualified.length, newest]).toEqual([3781, 16]);
  });

  test("resolves to a bitmap, except the recorded unsupported ones", () => {
    const unsupported = fullyQualified.filter((e) => font.bitmap(e.codePoints) === null).map((e) => keyOf(e.codePoints));
    expect(unsupported).toEqual([...KNOWN_UNSUPPORTED]);
  });

  test("resolves to the glyph HarfBuzz shapes it to", () => {
    const disagree = fullyQualified
      .filter((e) => font.glyphId(e.codePoints) !== harfBuzz.get(keyOf(e.codePoints)))
      .map((e) => `${keyOf(e.codePoints)}: reader ${font.glyphId(e.codePoints)}, HarfBuzz ${harfBuzz.get(keyOf(e.codePoints))}`);
    expect(disagree).toEqual([]);
  });

  test("resolves the same from the string as from the code points", () => {
    const disagree = fullyQualified.filter((e) => font.glyphId(String.fromCodePoint(...e.codePoints)) !== font.glyphId(e.codePoints)).map((e) => keyOf(e.codePoints));
    expect(disagree).toEqual([]);
  });

  test("gives a bitmap whose PNG has the stated size and the strike's advance", () => {
    const wrong = fullyQualified.flatMap((e) => {
      const bitmap = font.bitmap(e.codePoints);
      if (bitmap === null) return [keyOf(e.codePoints)];
      const view = new DataView(bitmap.png.buffer, bitmap.png.byteOffset, bitmap.png.byteLength);
      const ok = view.getUint32(16) === bitmap.width && view.getUint32(20) === bitmap.height && bitmap.advance === 136;
      return ok ? [] : [keyOf(e.codePoints)];
    });
    expect(wrong).toEqual([]);
  });
});

describe("the other statuses", () => {
  test("every component (skin tones, hair styles) has a bitmap", () => {
    const missing = entries.filter((e) => e.status === "component" && !font.has(e.codePoints)).map((e) => keyOf(e.codePoints));
    expect(missing).toEqual([]);
  });

  test("every minimally-qualified sequence has a bitmap, the same one as its fully-qualified form", () => {
    const byName = new Map(fullyQualified.map((e) => [e.name, e]));
    const wrong = entries
      .filter((e) => e.status === "minimally-qualified")
      .filter((e) => {
        const full = byName.get(e.name);
        return full === undefined || font.glyphId(e.codePoints) !== font.glyphId(full.codePoints);
      })
      .map((e) => keyOf(e.codePoints));
    expect(wrong).toEqual([]);
  });

  test("the counts by status, and every one of them has a bitmap", () => {
    const counts = (status: string) => {
      const of = entries.filter((e) => e.status === status);
      return [of.length, of.filter((e) => font.has(e.codePoints)).length];
    };
    // Unqualified sequences (no VS16) are not emoji to type, but the font draws them all.
    expect({ fully: counts("fully-qualified"), minimally: counts("minimally-qualified"), unqualified: counts("unqualified"), component: counts("component") }).toEqual({
      fully: [3781, 3781],
      minimally: [1009, 1009],
      unqualified: [243, 243],
      component: [9, 9],
    });
  });
});
