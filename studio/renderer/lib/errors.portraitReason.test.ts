import { expect, test } from "bun:test";
import { ERROR_MESSAGES_RU, PORTRAIT_REASONS, PORTRAIT_REASONS_RU } from "../../shared/engine";
import { errorText } from "./errors";

// S5.3d: a reference-portrait command the engine refused says why (`portraitReason`): the window shows the reason's own text, never the general one.

test.each(PORTRAIT_REASONS.filter((reason) => reason !== "source-unavailable"))("the VALIDATION reason %s shows its own text", (portraitReason) => {
  const text = errorText({ code: "VALIDATION", portraitReason });
  expect(text).toBe(PORTRAIT_REASONS_RU[portraitReason]);
  expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
});

test("too many waiting is the contract's own text, and it names the window's real button, not «Оставить как есть» (review L4)", () => {
  const text = errorText({ code: "VALIDATION", portraitReason: "too-many-candidates" });
  expect(text).toBe(PORTRAIT_REASONS_RU["too-many-candidates"]);
  expect(text).toBe(
    "Невыбранных вариантов слишком много: ещё 5 превысят предел в 15 (считаются и скрытые проверкой возраста). Выберите один или нажмите «Удалить варианты», потом повторите. Ничего не потрачено.",
  );
  expect(text).not.toContain("Оставить как есть");
});

test("the imported photo gone (INTERNAL source-unavailable) says so, not «Внутренняя ошибка движка»", () => {
  const text = errorText({ code: "INTERNAL", portraitReason: "source-unavailable" });
  expect(text).toBe("Исходное фото недоступно — проверьте папку библиотеки.");
  expect(text).not.toBe(ERROR_MESSAGES_RU.INTERNAL);
});

test("an INTERNAL and a VALIDATION without a portrait reason keep their general texts", () => {
  expect(errorText({ code: "INTERNAL" })).toBe(ERROR_MESSAGES_RU.INTERNAL);
  expect(errorText({ code: "VALIDATION" })).toBe(ERROR_MESSAGES_RU.VALIDATION);
});
