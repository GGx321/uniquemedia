import { describe, expect, test } from "bun:test";
import { EngineError } from "./errors";

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
