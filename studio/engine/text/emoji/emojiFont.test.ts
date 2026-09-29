import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { EmojiFontError, type EmojiFont, openEmojiFont } from "./emojiFont";
import { loadPinnedEmojiFont } from "./emojiFont.testkit";
useNativeGlobals();

let font: EmojiFont;
beforeAll(async () => {
  font = openEmojiFont(await loadPinnedEmojiFont());
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function sha16(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

describe("the strike", () => {
  test("is the font's one 109 ppem strike with its line metrics", () => {
    expect([font.ppem, font.ascender, font.descender]).toEqual([109, 101, -27]);
  });

  test("counts the glyphs that carry a bitmap", () => {
    expect(font.bitmapCount).toBeGreaterThan(3700);
  });
});

describe("coverage", () => {
  test("has a plain emoji", () => {
    expect(font.has("😀")).toBe(true);
  });

  test("has an emoji given as code points", () => {
    expect(font.has([0x1f600])).toBe(true);
  });

  test("has a ZWJ sequence as one glyph", () => {
    expect(font.has("👩‍💻")).toBe(true);
  });

  test("has a skin tone sequence", () => {
    expect(font.has("👍🏽")).toBe(true);
  });

  test("has a flag", () => {
    expect(font.has("🇺🇸")).toBe(true);
  });

  test("has a keycap", () => {
    expect(font.has("1️⃣")).toBe(true);
  });

  test("has a subdivision flag made of tag characters", () => {
    expect(font.has("🏴󠁧󠁢󠁥󠁮󠁧󠁿")).toBe(true);
  });

  test("has a VS16 emoji whether or not the selector is present", () => {
    expect([font.has("❤️"), font.has("❤")]).toEqual([true, true]);
  });

  test("refuses a ZWJ sequence the font has no ligature for", () => {
    expect(font.has("😀‍😀")).toBe(false);
  });

  test("refuses two regional indicators that are not a flag", () => {
    expect(font.has("🇦🇦")).toBe(false);
  });

  test("refuses a code point outside the cmap", () => {
    expect(font.has("\u{10FFFF}")).toBe(false);
  });

  test("refuses the empty sequence", () => {
    expect(font.has("")).toBe(false);
  });

  test("refuses a lone surrogate", () => {
    expect(font.has("\ud83d")).toBe(false);
  });

  test("refuses code points that are not code points", () => {
    expect([font.has([-1]), font.has([0x110000]), font.has([1.5]), font.has([Number.NaN])]).toEqual([false, false, false, false]);
  });

  test("refuses a sequence longer than any emoji", () => {
    expect(font.has("😀".repeat(33))).toBe(false);
  });

  test("has() gives the same answer for the string and for its code points", () => {
    expect(font.has("👩‍💻")).toBe(font.has([0x1f469, 0x200d, 0x1f4bb]));
  });
});

describe("glyph ids", () => {
  test("a plain emoji is the glyph HarfBuzz picks", () => {
    expect(font.glyphId("😀")).toBe(883);
  });

  test("a ZWJ sequence is the ligature glyph HarfBuzz picks", () => {
    expect(font.glyphId("👩‍💻")).toBe(2316);
  });

  test("a family of four is the ligature glyph HarfBuzz picks", () => {
    expect(font.glyphId("👨‍👩‍👧‍👦")).toBe(2023);
  });

  test("a skin tone sequence is the glyph HarfBuzz picks", () => {
    expect(font.glyphId("👍🏽")).toBe(1969);
  });

  test("a flag is the glyph HarfBuzz picks", () => {
    expect(font.glyphId("🇺🇸")).toBe(1772);
  });

  test("a keycap is the glyph HarfBuzz picks", () => {
    expect(font.glyphId("1️⃣")).toBe(1485);
  });

  test("is null for a sequence the font cannot draw as one glyph", () => {
    expect(font.glyphId("😀‍😀")).toBeNull();
  });
});

describe("bitmaps", () => {
  test("gives exact metrics for a plain emoji", () => {
    const bitmap = font.bitmap("😀");
    expect(bitmap && { ...bitmap, png: bitmap.png.byteLength }).toEqual({ png: 3390, width: 136, height: 128, bearingX: 0, bearingY: 101, advance: 136 });
  });

  test("gives the exact PNG bytes for a plain emoji", () => {
    expect(sha16(font.bitmap("😀")?.png ?? new Uint8Array())).toBe("10d6305ce9241ddf");
  });

  test("gives the exact PNG bytes for a ZWJ sequence", () => {
    expect(sha16(font.bitmap("👩‍💻")?.png ?? new Uint8Array())).toBe("0a91362520537444");
  });

  test("gives the exact PNG bytes for a flag", () => {
    expect(sha16(font.bitmap("🇺🇸")?.png ?? new Uint8Array())).toBe("ce78b4a4390d6c05");
  });

  test("gives the exact PNG bytes for a keycap", () => {
    expect(sha16(font.bitmap("1️⃣")?.png ?? new Uint8Array())).toBe("7108341e15a395ef");
  });

  test("gives the exact PNG bytes for a skin tone", () => {
    expect(sha16(font.bitmap("👍🏽")?.png ?? new Uint8Array())).toBe("03ccad17e4bf27b3");
  });

  test("the bytes are a PNG of the stated size", () => {
    const bitmap = font.bitmap("👨‍👩‍👧‍👦");
    if (bitmap === null) throw new Error("no bitmap for the family");
    const view = new DataView(bitmap.png.buffer, bitmap.png.byteOffset, bitmap.png.byteLength);
    expect([[...bitmap.png.subarray(0, 8)], view.getUint32(16), view.getUint32(20)]).toEqual([PNG_SIGNATURE, bitmap.width, bitmap.height]);
  });

  test("is null for a sequence with no bitmap", () => {
    expect(font.bitmap("😀‍😀")).toBeNull();
  });

  test("hands out a copy, so a caller cannot change the font", () => {
    const first = font.bitmap("😀");
    first?.png.fill(0);
    expect(sha16(font.bitmap("😀")?.png ?? new Uint8Array())).toBe("10d6305ce9241ddf");
  });
});

describe("opening", () => {
  test("refuses bytes that are not a font", () => {
    expect(() => openEmojiFont(new Uint8Array(100))).toThrow(EmojiFontError);
  });

  test("refuses the empty input with a typed error", () => {
    expect(() => openEmojiFont(new Uint8Array(0))).toThrow(expect.objectContaining({ code: "NOT_A_FONT" }));
  });

  test("keeps working when the caller's buffer is transferred away after open", async () => {
    const bytes = await loadPinnedEmojiFont();
    const opened = openEmojiFont(bytes);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    expect(bytes.byteLength).toBe(0);
    expect(sha16(opened.bitmap("😀")?.png ?? new Uint8Array())).toBe("10d6305ce9241ddf");
  });

  test("keeps its answers when the caller overwrites the buffer after open", async () => {
    const bytes = await loadPinnedEmojiFont();
    const opened = openEmojiFont(bytes);
    bytes.fill(0);
    expect([opened.has("👩‍💻"), sha16(opened.bitmap("😀")?.png ?? new Uint8Array())]).toEqual([true, "10d6305ce9241ddf"]);
  });

  test("opens a font handed over as a view into a larger buffer", async () => {
    const font = await loadPinnedEmojiFont();
    const padded = new Uint8Array(font.byteLength + 100).fill(0xaa);
    padded.set(font, 50);
    const opened = openEmojiFont(padded.subarray(50, 50 + font.byteLength));
    padded.fill(0);
    expect(sha16(opened.bitmap("😀")?.png ?? new Uint8Array())).toBe("10d6305ce9241ddf");
  });
});
