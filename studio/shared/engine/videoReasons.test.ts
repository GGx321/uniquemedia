import { describe, expect, test } from "bun:test";
import { MEDIA_REASONS_BY_KIND_RU, MEDIA_REASONS_RU, mediaReasonRu } from "./errorMessagesRu";

// The video's own words for «too-large» (3f.3b, M-A): the shared text says «видео — до 2 ГБ», which tells an owner with a 600 MB source nothing; for a video the limit is on BOTH
// the file and the prepared copy, and a long grainy clip can make a copy that does not fit.

describe("the video's too-large", () => {
  const text = MEDIA_REASONS_BY_KIND_RU.video?.["too-large"] ?? "";

  test("has its own text, not the shared one", () => {
    expect(text).not.toBe("");
    expect(text).not.toBe(MEDIA_REASONS_RU["too-large"]);
    expect(mediaReasonRu("too-large", "video")).toBe(text);
  });

  test("says that both the file and the prepared copy must be within 2 ГБ, and what to do: shorten the clip", () => {
    expect(text).toContain("2 ГБ");
    expect(text).toMatch(/исходн/);
    expect(text).toMatch(/готов/);
    expect(text).toMatch(/Сократите|Обрежьте/);
  });

  test("says why a small file can still be refused: a long, grainy clip", () => {
    expect(text).toMatch(/зернист|шум/);
  });

  test("the other kinds keep the shared text", () => {
    expect(mediaReasonRu("too-large", "photo")).toBe(MEDIA_REASONS_RU["too-large"]);
    expect(mediaReasonRu("too-large", "audio")).toBe(MEDIA_REASONS_RU["too-large"]);
  });
});
