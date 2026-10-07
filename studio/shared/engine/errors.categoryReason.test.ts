import { describe, expect, test } from "bun:test";
import { CATEGORY_REASONS, EngineError } from "./errors";
import { CATEGORY_REASONS_RU, ERROR_MESSAGES_RU } from "./errorMessagesRu";

// Why a category command was refused (`EngineError.categoryReason`, additive in v5): the sheet's text depends on it, so it travels as a closed
// code, never as free text.

describe("EngineError.categoryReason", () => {
  test.each(["limit", "name-taken", "below-minimum", "mirror-needed", "item-not-found"])("VALIDATION carries the reason %s", (categoryReason) => {
    expect(EngineError.safeParse({ code: "VALIDATION", categoryReason }).success).toBe(true);
  });

  test("VALIDATION without a reason is still valid: not every refusal is a category's", () => {
    expect(EngineError.safeParse({ code: "VALIDATION" }).success).toBe(true);
  });

  test("a failed paid call carries its reason together with what it spent", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", categoryReason: "name-taken", spentMicros: 5_000 }).success).toBe(true);
  });

  test("a reason outside the closed set is refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", categoryReason: "exists" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", categoryReason: "looks-wrong" }).success).toBe(false);
  });

  test("a reason on any other code is refused", () => {
    expect(EngineError.safeParse({ code: "NOT_FOUND", categoryReason: "limit" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "POOL_REJECTED", categoryReason: "name-taken" }).success).toBe(false);
  });
});

describe("library-unreadable (CS.7 fix round 2)", () => {
  test("is a category reason of its own: the check for a new name could not read the library", () => {
    expect(CATEGORY_REASONS).toContain("library-unreadable");
    expect(EngineError.safeParse({ code: "VALIDATION", categoryReason: "library-unreadable" }).success).toBe(true);
  });

  test("every category reason has a text of its own, and none is the general one", () => {
    const texts = CATEGORY_REASONS.map((reason) => CATEGORY_REASONS_RU[reason]);
    expect(new Set(texts).size).toBe(CATEGORY_REASONS.length);
    for (const text of texts) expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
  });

  test("its text says nothing was created or spent, and to retry", () => {
    expect(CATEGORY_REASONS_RU["library-unreadable"]).toContain("Ничего не создано");
    expect(CATEGORY_REASONS_RU["library-unreadable"]).toContain("повторите");
  });
});
