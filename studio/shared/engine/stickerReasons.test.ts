import { describe, expect, test } from "bun:test";
import { MEDIA_REASONS_BY_KIND_RU, MEDIA_REASONS_RU, mediaReasonRu } from "./errorMessagesRu";
import { MediaUnsupportedReason } from "./media";

const STICKER_REASONS_RU = MEDIA_REASONS_BY_KIND_RU.sticker ?? {};
const stickerReasonRu = (reason: MediaUnsupportedReason): string => mediaReasonRu(reason, "sticker");

// 3f.5: the refusal reasons of an own sticker, and the words an owner is told them in.

describe("the sticker refusal reasons", () => {
  test("`not-animated` and `loop-too-long` are appended after the older reasons, each on its own", () => {
    const options = [...MediaUnsupportedReason.options];
    expect(options).toContain("not-animated");
    expect(options).toContain("loop-too-long");
    expect(options.indexOf("not-animated")).toBeGreaterThan(options.indexOf("animated-webp"));
    expect(options.indexOf("loop-too-long")).toBeGreaterThan(options.indexOf("animated-webp"));
  });

  test("the neutral table has a text for each of them", () => {
    expect(MEDIA_REASONS_RU["not-animated"]).toMatch(/[А-Яа-яЁё]/);
    expect(MEDIA_REASONS_RU["loop-too-long"]).toMatch(/[А-Яа-яЁё]/);
  });
});

describe("STICKER_REASONS_RU", () => {
  test("holds a text only for a real reason, in Russian, with no path or placeholder", () => {
    for (const [reason, text] of Object.entries(STICKER_REASONS_RU)) {
      expect(MediaUnsupportedReason.safeParse(reason).success).toBe(true);
      expect(text).toMatch(/[А-Яа-яЁё]/);
      expect(text).not.toMatch(/[\\/]/);
      expect(text).not.toMatch(/\{|\}/);
    }
  });

  test("says what a sticker takes where the neutral text speaks of photos", () => {
    expect(STICKER_REASONS_RU.format).toContain("GIF");
    expect(STICKER_REASONS_RU.format).toContain("APNG");
    expect(STICKER_REASONS_RU["too-large"]).toContain("5 МБ");
    expect(STICKER_REASONS_RU.dimensions).toContain("720");
    expect(STICKER_REASONS_RU["too-small"]).toContain("2 пиксел");
    expect(STICKER_REASONS_RU["loop-too-long"]).toContain("300");
    expect(STICKER_REASONS_RU["not-animated"]).toMatch(/GIF|APNG/);
  });

  test("stickerReasonRu uses the sticker's own text, and the neutral one for a reason it has none for", () => {
    expect(stickerReasonRu("dimensions")).toBe(STICKER_REASONS_RU.dimensions ?? "");
    expect(stickerReasonRu("heic")).toBe(MEDIA_REASONS_RU.heic);
    expect(stickerReasonRu("cancelled")).toBe(MEDIA_REASONS_RU.cancelled);
  });

  test("none of the sticker's texts is a copy of the neutral one it replaces", () => {
    for (const [reason, text] of Object.entries(STICKER_REASONS_RU)) {
      const parsed = MediaUnsupportedReason.parse(reason);
      expect(text).not.toBe(MEDIA_REASONS_RU[parsed]);
    }
  });
});
