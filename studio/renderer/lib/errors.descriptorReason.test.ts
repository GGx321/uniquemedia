import { expect, test } from "bun:test";
import { DESCRIPTOR_REASONS, DESCRIPTOR_REASONS_RU, ERROR_MESSAGES_RU } from "../../shared/engine";
import { errorText } from "./errors";

// A descriptor the owner typed and the engine refused says why (`descriptorReason`, Stage 5): the window shows this text, so each reason names the rule to fix.

test("a VALIDATION with no descriptor reason keeps the general text", () => {
  expect(errorText({ code: "VALIDATION" })).toBe(ERROR_MESSAGES_RU.VALIDATION);
});

test.each(DESCRIPTOR_REASONS.filter((reason) => reason !== "youth-word"))("the reason %s shows its own text, not the general one", (descriptorReason) => {
  const text = errorText({ code: "VALIDATION", descriptorReason });
  expect(text).toBe(DESCRIPTOR_REASONS_RU[descriptorReason]);
  expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
});

test("a youth-word refusal quotes the owner's own words", () => {
  expect(errorText({ code: "VALIDATION", descriptorReason: "youth-word", descriptorWords: ["petite", "tiny"] })).toBe(
    "Слова, которые мы не используем: «petite», «tiny»",
  );
});

test("a youth-word refusal without words still reads", () => {
  expect(errorText({ code: "VALIDATION", descriptorReason: "youth-word" })).toBe(DESCRIPTOR_REASONS_RU["youth-word"]);
});
