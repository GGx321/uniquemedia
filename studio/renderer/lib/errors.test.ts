import { expect, test } from "bun:test";
import { AGE_CHECK_ALREADY_REFUSED_DETAIL, DRAFT_CHANGING_DETAIL, DRAFT_TOO_NEW_DETAIL, ERROR_MESSAGES_RU } from "../../shared/engine";
import { errorText } from "./errors";

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
