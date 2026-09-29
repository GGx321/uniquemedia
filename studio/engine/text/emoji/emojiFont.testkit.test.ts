import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { EMOJI_FONT_BYTES, keyOf, loadEmojiTest, loadHarfBuzzGlyphs, loadPinnedEmojiFont, parseEmojiTest } from "./emojiFont.testkit";
useNativeGlobals();

describe("the emoji test fixtures", () => {
  test("the vendored emoji-test.txt is Unicode Emoji 17.0 with 3944 fully-qualified sequences", async () => {
    const entries = await loadEmojiTest();
    expect(entries.filter((e) => e.status === "fully-qualified")).toHaveLength(3944);
  });

  test("parses a line into code points, status, version and name", () => {
    const [entry] = parseEmojiTest("1F469 200D 1F4BB                                       ; fully-qualified     # 👩‍💻 E4.0 woman technologist\n");
    expect(entry).toEqual({ codePoints: [0x1f469, 0x200d, 0x1f4bb], status: "fully-qualified", since: "E4.0", name: "woman technologist" });
  });

  test("refuses a data line it cannot read", () => {
    expect(() => parseEmojiTest("nonsense line\n")).toThrow("unparseable");
  });

  test("the HarfBuzz oracle has a glyph for every fully-qualified sequence", async () => {
    const [entries, glyphs] = await Promise.all([loadEmojiTest(), loadHarfBuzzGlyphs()]);
    const missing = entries.filter((e) => e.status === "fully-qualified" && !glyphs.has(keyOf(e.codePoints)));
    expect(missing).toEqual([]);
  });

  test("the pinned font is 10 673 480 bytes and each call gets its own copy", async () => {
    const a = await loadPinnedEmojiFont();
    expect(a.byteLength).toBe(EMOJI_FONT_BYTES);
    a[0] = 0xff;
    expect((await loadPinnedEmojiFont())[0]).toBe(0);
  });
});
