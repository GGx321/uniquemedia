import { describe, expect, test } from "bun:test";
import { DESCRIPTOR_REASONS, EngineError } from "./errors";
import { DESCRIPTOR_REASONS_RU, ERROR_MESSAGES_RU, descriptorReasonRu } from "./errorMessagesRu";

// Why `avatars.editDescriptor` refused the owner's text (`EngineError.descriptorReason`, additive in Stage 5): the window's text depends on it, so it
// travels as a closed code, never as free text.

describe("EngineError.descriptorReason", () => {
  test.each([...DESCRIPTOR_REASONS])("VALIDATION carries the reason %s", (descriptorReason) => {
    expect(EngineError.safeParse({ code: "VALIDATION", descriptorReason }).success).toBe(true);
  });

  test("a youth-word refusal carries the owner's own words", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", descriptorReason: "youth-word", descriptorWords: ["petite"] }).success).toBe(true);
  });

  test("a reason outside the closed set is refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", descriptorReason: "looks-wrong" }).success).toBe(false);
  });

  test("a reason on any other code is refused", () => {
    expect(EngineError.safeParse({ code: "IN_FLIGHT", descriptorReason: "stale" }).success).toBe(false);
  });

  test("words without a youth-word reason are refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", descriptorReason: "script", descriptorWords: ["x"] }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", descriptorWords: ["x"] }).success).toBe(false);
  });

  test("a refusal has one reason: a descriptor reason beside a category reason is refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", descriptorReason: "stale", categoryReason: "limit" }).success).toBe(false);
  });

  test("has a reason of the same name for every AdultTextProblem", () => {
    for (const problem of ["script", "non-ascii-digits", "other-age", "under-21-bound", "youth-word", "number", "too-long"]) {
      expect(DESCRIPTOR_REASONS as readonly string[]).toContain(problem);
    }
  });
});

describe("DESCRIPTOR_REASONS_RU", () => {
  test("every reason has a text of its own, and none is the general one", () => {
    const texts = DESCRIPTOR_REASONS.map((reason) => DESCRIPTOR_REASONS_RU[reason]);
    expect(new Set(texts).size).toBe(DESCRIPTOR_REASONS.length);
    for (const text of texts) expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
  });

  test.each([
    ["no-anchor", "-year-old"],
    ["script", "латиницей"],
    ["non-ascii-digits", "0–9"],
    ["other-age", "другой возраст"],
    ["number", "Других чисел"],
    ["under-21-bound", "возрастные пределы"],
    ["too-long", "600"],
    ["empty", "пустое"],
    ["hidden-chars", "скрытые символы"],
    ["stale", "уже изменилось"],
  ] as const)("the text for %s says what to fix", (reason, fragment) => {
    expect(DESCRIPTOR_REASONS_RU[reason]).toContain(fragment);
  });

  test("the youth-word text quotes the owner's words", () => {
    expect(descriptorReasonRu("youth-word", ["petite", "tiny"])).toBe("Слово, которое мы не используем: «petite», «tiny»");
  });

  test("the youth-word text still reads without words", () => {
    expect(descriptorReasonRu("youth-word", [])).toContain("Слово, которое мы не используем");
  });

  test("a reason without words is its table text", () => {
    expect(descriptorReasonRu("empty", [])).toBe(DESCRIPTOR_REASONS_RU.empty);
  });
});
