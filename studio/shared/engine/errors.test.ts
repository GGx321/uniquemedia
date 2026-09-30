import { describe, expect, test } from "bun:test";
import { CAPTION_ISSUES_RU, ERROR_MESSAGES_RU, EXPORT_UNAVAILABLE_REASONS_RU, MONTAGE_ISSUE_MESSAGES_RU } from "./errorMessagesRu";
import { CAPTION_ISSUES, ERROR_CODES, EXPORT_UNAVAILABLE_REASONS, EngineError, ErrorCode } from "./errors";
import { MAX_MONTAGE_ISSUES, MONTAGE_ISSUE_CODES } from "./montage";

const EXPECTED_CODES = [
  "AUTH_INVALID",
  "INSUFFICIENT_CREDITS",
  "BUDGET_EXCEEDED",
  "RUN_CAP_EXCEEDED",
  "MODERATION_REFUSED",
  "RATE_LIMITED",
  "NETWORK",
  "TIMEOUT",
  "RECONCILE_REQUIRED",
  "ENCRYPTION_UNAVAILABLE",
  "VALIDATION",
  "NOT_FOUND",
  "INTERNAL",
  "LEDGER_CORRUPT",
  "LEDGER_UNREADABLE",
  "SETTLE_ABOVE_WORST",
  "LEDGER_WRITE_FAILED",
  "PRICE_UNAVAILABLE",
  "PRICE_CHANGED",
  "IN_FLIGHT",
  "LIBRARY_UNAVAILABLE",
  "DESCRIPTOR_INVALID",
  "AGE_CHECK_FAILED",
  "IMPORT_SUBJECT_INVALID",
  "QA_REJECTED",
  "AGE_GATE_UNAVAILABLE",
  "FACE_GATE_UNAVAILABLE",
  "MASTER_FACE_UNUSABLE",
  "MONTAGE_INVALID",
  "PHOTO_UNAVAILABLE",
  "EXPORT_UNAVAILABLE",
  "RENDER_FAILED",
  "RENDER_VERIFY_FAILED",
  "RENDER_QUEUE_FULL",
  "LIBRARY_TOO_NEW",
  "TEXT_INVALID",
  "TEXT_PREVIEW_SUPERSEDED",
  "MUSIC_KEY_MISSING",
  "MUSIC_KEY_REJECTED",
  "MUSIC_QUOTA_EXHAUSTED",
  "MUSIC_UNAVAILABLE",
];

/** The codes that must say more than their code: what is wrong with the montage, which cells, why the folder is unusable, which caption rule broke. */
const CODES_WITH_A_REQUIRED_FIELD = ["MONTAGE_INVALID", "PHOTO_UNAVAILABLE", "EXPORT_UNAVAILABLE", "TEXT_INVALID"];

describe("ErrorCode", () => {
  test("is exactly the closed set of forty-one codes", () => {
    const actual: string[] = [...ERROR_CODES].sort();
    expect(actual).toEqual([...EXPECTED_CODES].sort());
  });

  test("rejects a code outside the set", () => {
    expect(ErrorCode.safeParse("PAYMENT_REQUIRED").success).toBe(false);
  });
});

describe("EngineError", () => {
  test.each(EXPECTED_CODES.filter((c) => !CODES_WITH_A_REQUIRED_FIELD.includes(c)))("accepts a bare %s error", (code) => {
    expect(EngineError.safeParse({ code }).success).toBe(true);
  });

  test("accepts a rate-limit error with a retry delay and detail", () => {
    const e = { code: "RATE_LIMITED", retryAfterMs: 2_000, detail: "429 from provider" };
    expect(EngineError.safeParse(e).success).toBe(true);
  });

  test("rejects a user-facing message field: messages live in the separate map", () => {
    expect(EngineError.safeParse({ code: "NETWORK", message: "Нет сети" }).success).toBe(false);
  });

  test("strips an API key from detail instead of carrying it", () => {
    const e = { code: "AUTH_INVALID", detail: "key sk-or-v1-0123456789abcdef was refused" };
    expect(EngineError.parse(e).detail).toBe("key [redacted] was refused");
  });

  test("rejects a negative retry delay", () => {
    expect(EngineError.safeParse({ code: "RATE_LIMITED", retryAfterMs: -1 }).success).toBe(false);
  });

  test("rejects a fractional retry delay", () => {
    expect(EngineError.safeParse({ code: "RATE_LIMITED", retryAfterMs: 1.5 }).success).toBe(false);
  });

  test("accepts a render failure whose detail is the stderr tail", () => {
    expect(EngineError.safeParse({ code: "RENDER_FAILED", detail: "Error while filtering: Invalid argument" }).success).toBe(true);
  });
});

describe("EngineError for a montage that cannot be rendered", () => {
  const issue = { code: "layer-too-short", path: ["layers", 0] };

  test("MONTAGE_INVALID carries the issue list", () => {
    expect(EngineError.safeParse({ code: "MONTAGE_INVALID", issues: [issue] }).success).toBe(true);
  });

  test("MONTAGE_INVALID without issues is refused: the owner could not be told what to fix", () => {
    expect(EngineError.safeParse({ code: "MONTAGE_INVALID" }).success).toBe(false);
  });

  test("MONTAGE_INVALID with an empty issue list is refused", () => {
    expect(EngineError.safeParse({ code: "MONTAGE_INVALID", issues: [] }).success).toBe(false);
  });

  test("the issue list is bounded", () => {
    const some = Array.from({ length: MAX_MONTAGE_ISSUES }, () => issue);
    const tooMany = [...some, issue];
    expect(EngineError.safeParse({ code: "MONTAGE_INVALID", issues: some }).success).toBe(true);
    expect(EngineError.safeParse({ code: "MONTAGE_INVALID", issues: tooMany }).success).toBe(false);
  });

  test("an issue outside the closed set is refused", () => {
    expect(EngineError.safeParse({ code: "MONTAGE_INVALID", issues: [{ code: "looks-wrong", path: [] }] }).success).toBe(false);
  });

  test("issues on any other code are refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", issues: [issue] }).success).toBe(false);
  });

  test("issues on any other code are refused, PHOTO_UNAVAILABLE aside", () => {
    expect(EngineError.safeParse({ code: "NOT_FOUND", issues: [issue] }).success).toBe(false);
  });

  test("the engine's own refusal for a part whose slice has not landed is an ordinary issue", () => {
    const notYet = { code: "not-yet-supported", path: ["layers", 0] };
    expect(EngineError.safeParse({ code: "MONTAGE_INVALID", issues: [notYet] }).success).toBe(true);
  });
});

describe("EngineError for a photo a montage cannot use", () => {
  const cell = { code: "photo-unavailable", path: ["clips", 1, "cells", 0] };

  test("PHOTO_UNAVAILABLE says which cells: its issues name them", () => {
    expect(EngineError.safeParse({ code: "PHOTO_UNAVAILABLE", issues: [cell, { ...cell, path: ["clips", 2, "cell"] }] }).success).toBe(true);
  });

  test("PHOTO_UNAVAILABLE without issues is refused", () => {
    expect(EngineError.safeParse({ code: "PHOTO_UNAVAILABLE" }).success).toBe(false);
  });

  test("PHOTO_UNAVAILABLE carries only photo-unavailable issues", () => {
    expect(EngineError.safeParse({ code: "PHOTO_UNAVAILABLE", issues: [{ code: "layer-too-short", path: ["layers", 0] }] }).success).toBe(false);
  });

  test("MONTAGE_INVALID may list a photo-unavailable issue too, next to the others", () => {
    const issues = [cell, { code: "duration-too-short", path: ["clips"] }];
    expect(EngineError.safeParse({ code: "MONTAGE_INVALID", issues }).success).toBe(true);
  });

  test("PHOTO_UNAVAILABLE's issue list is bounded like MONTAGE_INVALID's", () => {
    const some = Array.from({ length: MAX_MONTAGE_ISSUES }, () => cell);
    expect(EngineError.safeParse({ code: "PHOTO_UNAVAILABLE", issues: some }).success).toBe(true);
    expect(EngineError.safeParse({ code: "PHOTO_UNAVAILABLE", issues: [...some, cell] }).success).toBe(false);
  });
});

describe("EngineError for an unusable export folder", () => {
  test.each([...EXPORT_UNAVAILABLE_REASONS])("EXPORT_UNAVAILABLE says why: %s", (exportReason) => {
    expect(EngineError.safeParse({ code: "EXPORT_UNAVAILABLE", exportReason }).success).toBe(true);
  });

  test("the reasons are exactly: missing, not a directory, not writable, not enough space, overlaps the library, invalid marker (with or without records), newer marker", () => {
    const actual: string[] = [...EXPORT_UNAVAILABLE_REASONS].sort();
    expect(actual).toEqual(["invalid-marker", "invalid-marker-with-records", "missing", "newer-marker", "not-a-directory", "not-enough-space", "not-writable", "overlaps-library"]);
  });

  test("EXPORT_UNAVAILABLE without a reason is refused", () => {
    expect(EngineError.safeParse({ code: "EXPORT_UNAVAILABLE" }).success).toBe(false);
  });

  test("an unknown reason is refused", () => {
    expect(EngineError.safeParse({ code: "EXPORT_UNAVAILABLE", exportReason: "on-fire" }).success).toBe(false);
  });

  test("a reason on any other code is refused", () => {
    expect(EngineError.safeParse({ code: "NOT_FOUND", exportReason: "missing" }).success).toBe(false);
  });
});

describe("EngineError for a caption that cannot be drawn", () => {
  test("the issues are exactly the five of K19, in the order the engine reports them", () => {
    expect([...CAPTION_ISSUES]).toEqual(["charset", "emoji-missing", "emoji-text-style", "too-long", "too-many-lines"]);
  });

  test.each([...CAPTION_ISSUES])("TEXT_INVALID says what is wrong: %s", (captionIssue) => {
    expect(EngineError.safeParse({ code: "TEXT_INVALID", captionIssue }).success).toBe(true);
  });

  test("TEXT_INVALID without an issue is refused: the owner could not be told what to fix", () => {
    expect(EngineError.safeParse({ code: "TEXT_INVALID" }).success).toBe(false);
  });

  test("an unknown caption issue is refused", () => {
    expect(EngineError.safeParse({ code: "TEXT_INVALID", captionIssue: "ugly" }).success).toBe(false);
  });

  test("a caption issue on any other code is refused", () => {
    expect(EngineError.safeParse({ code: "RENDER_FAILED", captionIssue: "charset" }).success).toBe(false);
  });

  test("a caption issue next to an export reason is refused", () => {
    expect(EngineError.safeParse({ code: "EXPORT_UNAVAILABLE", exportReason: "missing", captionIssue: "charset" }).success).toBe(false);
  });
});

describe("CAPTION_ISSUES_RU", () => {
  test("has a text for exactly the caption issues", () => {
    expect(Object.keys(CAPTION_ISSUES_RU).sort()).toEqual([...CAPTION_ISSUES].sort());
  });

  test.each([...CAPTION_ISSUES])("the %s text is non-empty Russian", (issue) => {
    expect(CAPTION_ISSUES_RU[issue]).toMatch(/[А-Яа-яЁё]/);
  });

  test("the texts are all distinct", () => {
    const texts = Object.values(CAPTION_ISSUES_RU);
    expect(new Set(texts).size).toBe(texts.length);
  });

  test("the charset text names © ® ™ explicitly", () => {
    for (const sign of ["©", "®", "™"]) expect(CAPTION_ISSUES_RU.charset).toContain(sign);
  });

  test("the text-style text tells the owner what to do instead", () => {
    expect(CAPTION_ISSUES_RU["emoji-text-style"]).toMatch(/цветн/);
  });
});

describe("ERROR_MESSAGES_RU", () => {
  test("has a message for exactly the error codes, no more, no less", () => {
    expect(Object.keys(ERROR_MESSAGES_RU).sort()).toEqual([...EXPECTED_CODES].sort());
  });

  test.each(EXPECTED_CODES)("the %s message is non-empty Russian text", (code) => {
    const text = Object.entries(ERROR_MESSAGES_RU).find(([k]) => k === code)?.[1] ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/[А-Яа-яЁё]/);
  });

  test("messages are all distinct", () => {
    const texts = Object.values(ERROR_MESSAGES_RU);
    expect(new Set(texts).size).toBe(texts.length);
  });

  test("MUSIC_QUOTA_EXHAUSTED covers both causes: the local 30 in 31 days AND the server saying no requests remain", () => {
    expect(ERROR_MESSAGES_RU.MUSIC_QUOTA_EXHAUSTED).toMatch(/30 за 31 день/);
    expect(ERROR_MESSAGES_RU.MUSIC_QUOTA_EXHAUSTED).toMatch(/сервис|RapidAPI|сервер/);
    expect(ERROR_MESSAGES_RU.MUSIC_QUOTA_EXHAUSTED).toMatch(/не осталось/);
  });

  test("MUSIC_UNAVAILABLE does not claim a request was counted: it is also the code for a refusal before anything was sent", () => {
    expect(ERROR_MESSAGES_RU.MUSIC_UNAVAILABLE).not.toMatch(/мог быть засчитан/);
    expect(ERROR_MESSAGES_RU.MUSIC_UNAVAILABLE).toMatch(/если запрос (уже )?был отправлен/i);
  });

  test("the RATE_LIMITED message names «Продолжить» as the way to go on with a photo run, not a new run", () => {
    expect(ERROR_MESSAGES_RU.RATE_LIMITED).toContain("«Продолжить»");
    expect(ERROR_MESSAGES_RU.RATE_LIMITED).toMatch(/не нужно/);
  });

  test("the RATE_LIMITED message still tells an avatar action to be started again", () => {
    expect(ERROR_MESSAGES_RU.RATE_LIMITED).toMatch(/аватар/i);
    expect(ERROR_MESSAGES_RU.RATE_LIMITED).toMatch(/ещё раз/);
  });

  test("the AGE_GATE_UNAVAILABLE message does not offer a restart for a wiring defect a restart cannot fix", () => {
    expect(ERROR_MESSAGES_RU.AGE_GATE_UNAVAILABLE).not.toMatch(/перезапуст/i);
  });

  test("the AGE_GATE_UNAVAILABLE message still names the working way out: switch the age check off", () => {
    expect(ERROR_MESSAGES_RU.AGE_GATE_UNAVAILABLE).toMatch(/Выключите проверку в Настройках/);
  });

  test("the AGE_GATE_UNAVAILABLE message says the build itself is at fault", () => {
    expect(ERROR_MESSAGES_RU.AGE_GATE_UNAVAILABLE).toMatch(/сборк/);
  });
});

describe("MONTAGE_ISSUE_MESSAGES_RU", () => {
  test("has a message for exactly the issue codes, no more, no less", () => {
    const actual: string[] = Object.keys(MONTAGE_ISSUE_MESSAGES_RU).sort();
    const expected: string[] = [...MONTAGE_ISSUE_CODES].sort();
    expect(actual).toEqual(expected);
  });

  test.each([...MONTAGE_ISSUE_CODES])("the %s message is non-empty Russian text", (code) => {
    const text = Object.entries(MONTAGE_ISSUE_MESSAGES_RU).find(([k]) => k === code)?.[1] ?? "";
    expect(text).toMatch(/[А-Яа-яЁё]/);
  });

  test("the messages say «кадр», the editor's word, never «клип»", () => {
    for (const text of Object.values(MONTAGE_ISSUE_MESSAGES_RU)) expect(text).not.toMatch(/клип/i);
    expect(MONTAGE_ISSUE_MESSAGES_RU["no-clips"]).toMatch(/кадр/);
    expect(MONTAGE_ISSUE_MESSAGES_RU["cell-empty"]).toMatch(/кадр/);
    expect(MONTAGE_ISSUE_MESSAGES_RU["duplicate-clip-id"]).toMatch(/кадр/);
  });

  test.each(["caption-invalid", "media-unavailable", "sticker-unavailable", "track-unavailable", "track-too-short"] as const)("the engine-only code %s has its own text", (code) => {
    expect(MONTAGE_ISSUE_MESSAGES_RU[code]).toMatch(/[А-Яа-яЁё]/);
  });

  test("messages are all distinct", () => {
    const texts = Object.values(MONTAGE_ISSUE_MESSAGES_RU);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("EXPORT_UNAVAILABLE_REASONS_RU", () => {
  test("the newer-marker message does not tell the owner to delete the marker (that would orphan every record)", () => {
    expect(EXPORT_UNAVAILABLE_REASONS_RU["newer-marker"]).not.toMatch(/удал|повреж/i);
  });

  test("the invalid-marker-with-records message never tells the owner to delete the marker, or to move or rename it (every record of a video depends on its id)", () => {
    expect(EXPORT_UNAVAILABLE_REASONS_RU["invalid-marker-with-records"]).not.toMatch(/удал|убер|сотр|переим|перенес|перемест/i);
  });

  test("the invalid-marker message without records may still name the file, and differs from the one with records", () => {
    expect(EXPORT_UNAVAILABLE_REASONS_RU["invalid-marker"]).toContain(".studio-export.json");
    expect(EXPORT_UNAVAILABLE_REASONS_RU["invalid-marker-with-records"]).toContain(".studio-export.json");
    expect(EXPORT_UNAVAILABLE_REASONS_RU["invalid-marker-with-records"]).not.toBe(EXPORT_UNAVAILABLE_REASONS_RU["invalid-marker"]);
  });

  test("has a message for exactly the reasons, no more, no less", () => {
    const actual: string[] = Object.keys(EXPORT_UNAVAILABLE_REASONS_RU).sort();
    const expected: string[] = [...EXPORT_UNAVAILABLE_REASONS].sort();
    expect(actual).toEqual(expected);
  });

  test.each([...EXPORT_UNAVAILABLE_REASONS])("the %s message is non-empty Russian text", (reason) => {
    const text = Object.entries(EXPORT_UNAVAILABLE_REASONS_RU).find(([k]) => k === reason)?.[1] ?? "";
    expect(text).toMatch(/[А-Яа-яЁё]/);
  });
});

describe("the Stage 3 error messages", () => {
  test("EXPORT_UNAVAILABLE points to Settings and says nothing was spent", () => {
    expect(ERROR_MESSAGES_RU.EXPORT_UNAVAILABLE).toContain("Настройках");
    expect(ERROR_MESSAGES_RU.EXPORT_UNAVAILABLE).toMatch(/ничего не потрачено/);
  });

  test("PHOTO_UNAVAILABLE says only generated scene photos go into a video", () => {
    expect(ERROR_MESSAGES_RU.PHOTO_UNAVAILABLE).toMatch(/сгенерированные сцены/);
  });
});
