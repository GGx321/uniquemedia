import { expect, test } from "bun:test";
import { ERROR_MESSAGES_RU } from "../../shared/engine";
import { errorText } from "./errors";

// A refused category command says why (`categoryReason`): the sheet shows this text, so each reason names the cause and the way out.

test("a VALIDATION with no category reason keeps the general text", () => {
  expect(errorText({ code: "VALIDATION" })).toBe(ERROR_MESSAGES_RU.VALIDATION);
});

test("a full library says the limit and that one has to go first", () => {
  const text = errorText({ code: "VALIDATION", categoryReason: "limit" });
  expect(text).toContain("50");
  expect(text).toContain("Удалите");
});

test("a taken name says another category has it", () => {
  expect(errorText({ code: "VALIDATION", categoryReason: "name-taken" })).toContain("имя уже есть у другой категории");
});

test("a removal below the minimum says how many places and outfits a category keeps", () => {
  const text = errorText({ code: "VALIDATION", categoryReason: "below-minimum" });
  expect(text).toContain("5 мест");
  expect(text).toContain("3 образов");
});

test("a removal of the last mirror place says the deck needs one", () => {
  expect(errorText({ code: "VALIDATION", categoryReason: "mirror-needed" })).toContain("зеркал");
});

test("an item that is not there says the list changed", () => {
  expect(errorText({ code: "VALIDATION", categoryReason: "item-not-found" })).toContain("уже нет");
});

test("every reason has a text of its own, and none is the general one", () => {
  const reasons = ["limit", "name-taken", "below-minimum", "mirror-needed", "item-not-found"] as const;
  const texts = reasons.map((categoryReason) => errorText({ code: "VALIDATION", categoryReason }));
  expect(new Set(texts).size).toBe(reasons.length);
  for (const text of texts) expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
});
