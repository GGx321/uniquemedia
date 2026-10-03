import { expect, test } from "bun:test";
import {
  AGE_CHECK_ALREADY_REFUSED_DETAIL,
  DRAFT_CHANGING_DETAIL,
  DRAFT_TOO_NEW_DETAIL,
  ERROR_MESSAGES_RU,
  EXPORT_CHANGING_DETAIL,
  EXPORT_UNAVAILABLE_REASONS_RU,
  NO_ANSWER_DETAIL_PREFIX,
  RENDER_NOT_QUEUED_DETAIL,
  renderQueueFullDetail,
} from "../../shared/engine";
import { errorSettingsFocus, errorText, settingsLinkLabel } from "./errors";
import { NBSP } from "./format";

// T6c review round 3, L8: the free re-pick's own wording (errors.ts:17)
// override was never directly tested — only reachable through the whole
// AvatarImport screen. A regression here (e.g. matching on the wrong detail,
// or on any AGE_CHECK_FAILED regardless of detail) would still let every
// screen-level test pass, since none of them assert this exact string.

test("AGE_CHECK_FAILED with the free re-pick's own detail gets its own Russian text, not the ordinary paid-refusal one", () => {
  const text = errorText({ code: "AGE_CHECK_FAILED", detail: AGE_CHECK_ALREADY_REFUSED_DETAIL });
  expect(text).toContain("уже не подтвердило возраст");
  expect(text).not.toContain("оплачена только проверка возраста");
});

test("AGE_CHECK_FAILED with any other detail (the ordinary, paid refusal) keeps the ordinary text", () => {
  const text = errorText({ code: "AGE_CHECK_FAILED", detail: "the one-time image age check did not confirm an adult (not-adult)" });
  expect(text).toContain("оплачена только проверка возраста");
  expect(text).not.toContain("уже не подтвердило возраст");
});

test("AGE_CHECK_FAILED with no detail at all keeps the ordinary text too", () => {
  const text = errorText({ code: "AGE_CHECK_FAILED" });
  expect(text).toContain("оплачена только проверка возраста");
});

test("the override still appends a retry wait when the engine gave one", () => {
  const text = errorText({ code: "AGE_CHECK_FAILED", detail: AGE_CHECK_ALREADY_REFUSED_DETAIL, retryAfterMs: 5_000 });
  expect(text).toContain("уже не подтвердило возраст");
  expect(text).toContain("Повторите через");
});

// 3d.2 (the 3d.1a review): a draft from a newer Studio answers INTERNAL, and «Внутренняя ошибка движка» would
// read as a broken app. It gets its own words: update Studio; the draft is not lost.
test("a draft written by a newer Studio says to update the app, not that the engine failed", () => {
  const text = errorText({ code: "INTERNAL", detail: DRAFT_TOO_NEW_DETAIL });
  expect(text).toContain("более новой версией Studio");
  expect(text).toContain("Обновите");
  expect(text).not.toBe(ERROR_MESSAGES_RU.INTERNAL);
});

test("a draft that changed while it was read says a retry will open it", () => {
  const text = errorText({ code: "INTERNAL", detail: DRAFT_CHANGING_DETAIL });
  expect(text).toContain("Повторите");
  expect(text).not.toBe(ERROR_MESSAGES_RU.INTERNAL);
});

test("any other INTERNAL keeps the engine's own text", () => {
  expect(errorText({ code: "INTERNAL", detail: "the draft cannot be read (not-a-file)" })).toBe(ERROR_MESSAGES_RU.INTERNAL);
});

// 3e.3: the notice behind EXPORT_UNAVAILABLE says why, and links to the Settings card where the folder is fixed.
test("EXPORT_UNAVAILABLE says why the folder cannot be used, after the general text", () => {
  const text = errorText({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" });
  expect(text).toContain(ERROR_MESSAGES_RU.EXPORT_UNAVAILABLE);
  expect(text).toContain(EXPORT_UNAVAILABLE_REASONS_RU["not-writable"]);
});

test("EXPORT_UNAVAILABLE for a damaged marker with records never tells the owner to delete the file", () => {
  const text = errorText({ code: "EXPORT_UNAVAILABLE", exportReason: "invalid-marker-with-records" });
  expect(text).toContain(EXPORT_UNAVAILABLE_REASONS_RU["invalid-marker-with-records"]);
  expect(text).not.toMatch(/(?<!не )(удал|убер|сотр|переим|перенес|перемест)/i);
});

test("EXPORT_UNAVAILABLE without a reason keeps the general text alone", () => {
  expect(errorText({ code: "EXPORT_UNAVAILABLE" })).toBe(ERROR_MESSAGES_RU.EXPORT_UNAVAILABLE);
});

test("EXPORT_UNAVAILABLE is fixed in Settings, on the export folder's card", () => {
  expect(errorSettingsFocus("EXPORT_UNAVAILABLE")).toBe("export");
  expect(settingsLinkLabel("export")).toBe("Открыть папку в Настройках");
});

// 3d.6: what a refused or failed render says. The generic texts are about paid requests and OpenRouter, which a render never touches.
test("RENDER_QUEUE_FULL names the limit the engine gave; without a readable limit it keeps the general text", () => {
  const text = errorText({ code: "RENDER_QUEUE_FULL", detail: renderQueueFullDetail(20) });
  expect(text).toContain(`20${NBSP}рендеров`);
  expect(text).toContain("Ничего не потрачено");
  expect(errorText({ code: "RENDER_QUEUE_FULL", detail: renderQueueFullDetail(1) })).toContain(`1${NBSP}рендер`);
  expect(errorText({ code: "RENDER_QUEUE_FULL", detail: "something else" })).toBe(ERROR_MESSAGES_RU.RENDER_QUEUE_FULL);
  expect(errorText({ code: "RENDER_QUEUE_FULL" })).toBe(ERROR_MESSAGES_RU.RENDER_QUEUE_FULL);
});

test("LIBRARY_TOO_NEW says to update the app and that new videos of the avatar are not made", () => {
  const text = errorText({ code: "LIBRARY_TOO_NEW" });
  expect(text).toContain("более новой версией Studio");
  expect(text).toContain("Обновите");
  expect(text).not.toContain("платных");
});

test("a render refused because the export folder is being switched has its own text, not the one about paid requests", () => {
  const text = errorText({ code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL });
  expect(text).toContain("Готовые видео");
  expect(text).toContain("повторите");
  expect(text).not.toContain("платных");
  // Any other IN_FLIGHT keeps its general text.
  expect(errorText({ code: "IN_FLIGHT" })).toBe(ERROR_MESSAGES_RU.IN_FLIGHT);
  expect(errorText({ code: "IN_FLIGHT", detail: "a photo run is running" })).toBe(ERROR_MESSAGES_RU.IN_FLIGHT);
});

test("a render that ran out of its budget before it was queued says nothing was queued; no answer at all says it may have been", () => {
  const notQueued = errorText({ code: "INTERNAL", detail: RENDER_NOT_QUEUED_DETAIL });
  expect(notQueued).toContain("Ничего не поставлено");
  expect(notQueued).not.toBe(ERROR_MESSAGES_RU.INTERNAL);
  const silent = errorText({ code: "INTERNAL", detail: `${NO_ANSWER_DETAIL_PREFIX}30 s` });
  expect(silent).toContain("не ответил вовремя");
  expect(silent).not.toBe(ERROR_MESSAGES_RU.INTERNAL);
});

test("PHOTO_UNAVAILABLE never shows the engine's detail", () => {
  const text = errorText({ code: "PHOTO_UNAVAILABLE", detail: "an unreadable video record: Lena/2026-09-29_photo_001.mp4", issues: [{ code: "photo-unavailable", path: ["clips", 0, "cell"] }] });
  expect(text).toBe(ERROR_MESSAGES_RU.PHOTO_UNAVAILABLE);
  expect(text).not.toContain("Lena");
});

test("MONTAGE_INVALID adds the first issue's own text to the general one", () => {
  const text = errorText({ code: "MONTAGE_INVALID", issues: [{ code: "no-clips", path: ["clips"] }, { code: "cell-empty", path: ["clips", 0, "cell"] }] });
  expect(text).toContain(ERROR_MESSAGES_RU.MONTAGE_INVALID);
  expect(text).toContain("В монтаже нет ни одного кадра.");
  expect(text).not.toContain("пустая ячейка");
});
