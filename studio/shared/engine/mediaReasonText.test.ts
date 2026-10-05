import { describe, expect, test } from "bun:test";
import { mediaReasonRu, MEDIA_REASONS_RU } from "./errorMessagesRu";
import { MAX_PICKED_FILES, MediaKind, MediaUnsupportedReason } from "./media";

// 3f.3a review M2: the reason CODES are shared by every kind (`too-long`, `too-small`, `dimensions`, `codec`, ...), the TEXT depends on the
// kind of the file that was refused. A text with no kind, or a kind with no text of its own, is the neutral one.

const VIDEO_WORDS = /[Вв]идео|ролик/;

describe("mediaReasonRu", () => {
  test("a video's length, size and codec are told as a video's", () => {
    expect(mediaReasonRu("too-long", "video")).toContain("Видео длиннее трёх минут");
    expect(mediaReasonRu("dimensions", "video")).toContain("Видео больше 4K");
    expect(mediaReasonRu("codec", "video")).toContain("H.264");
  });

  test("the neutral text names no kind: it is what a kind with no text of its own is told", () => {
    for (const reason of ["too-long", "too-small", "dimensions", "codec", "structure"] as const) {
      expect(MEDIA_REASONS_RU[reason]).not.toMatch(VIDEO_WORDS);
      expect(mediaReasonRu(reason)).toBe(MEDIA_REASONS_RU[reason]);
    }
  });

  test("a sticker has no text of its own for the length, the codec or the structure: it is told the neutral one", () => {
    for (const reason of ["too-long", "codec", "structure"] as const) {
      expect(mediaReasonRu(reason, "sticker")).toBe(MEDIA_REASONS_RU[reason]);
    }
  });

  test("a track's length, codec and format are told as a track's (3f.4)", () => {
    expect(mediaReasonRu("too-long", "audio")).toContain("10 минут");
    expect(mediaReasonRu("codec", "audio")).toMatch(/mp3|AAC|FLAC/);
    expect(mediaReasonRu("format", "audio")).toContain("музык");
    expect(mediaReasonRu("too-long", "audio")).not.toMatch(VIDEO_WORDS);
    expect(mediaReasonRu("empty", "audio")).toBe(MEDIA_REASONS_RU.empty);
  });

  test("a reason a kind has no text for is the neutral one", () => {
    expect(mediaReasonRu("heic", "video")).toBe(MEDIA_REASONS_RU.heic);
    expect(mediaReasonRu("empty", "video")).toBe(MEDIA_REASONS_RU.empty);
  });

  test("a video's own text is not the neutral one", () => {
    expect(mediaReasonRu("too-long", "video")).not.toBe(MEDIA_REASONS_RU["too-long"]);
    expect(mediaReasonRu("dimensions", "video")).not.toBe(MEDIA_REASONS_RU.dimensions);
  });

  test.each(MediaKind.options)("every reason has a Russian text for %s, with no path or placeholder in it", (kind) => {
    for (const reason of MediaUnsupportedReason.options) {
      const text = mediaReasonRu(reason, kind);
      expect(text).toMatch(/[А-Яа-яЁё]/);
      expect(text).not.toMatch(/[\\/{}]/);
    }
  });

  test("the structure refusal is honest about what it is: not a wrong file type", () => {
    expect(MEDIA_REASONS_RU.structure).not.toMatch(/MP4/);
    expect(MEDIA_REASONS_RU.structure).toMatch(/устроен|структур/);
  });
});

// L3 of the Stage 3 whole-slice review: `too-many` is told for two limits, the pick's (`MAX_PICKED_FILES` files at once, main's) and the engine's own queue of waiting
// imports (a larger number). A text that states only the pick's number is false for the second.
describe("the text of too-many", () => {
  test("states the limit of one pick from its constant, not a number typed beside it", () => {
    expect(mediaReasonRu("too-many")).toContain(`не больше ${MAX_PICKED_FILES} файлов`);
  });

  test("also says that files waiting to be added count, since the engine refuses a file when too many are waiting", () => {
    expect(mediaReasonRu("too-many")).toMatch(/ждут|очеред/);
  });
});
