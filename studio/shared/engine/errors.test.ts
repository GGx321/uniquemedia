import { describe, expect, test } from "bun:test";
import { ERROR_MESSAGES_RU } from "./errorMessagesRu";
import { ERROR_CODES, EngineError, ErrorCode } from "./errors";

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
];

describe("ErrorCode", () => {
  test("is exactly the closed set of twenty-two codes", () => {
    const actual: string[] = [...ERROR_CODES].sort();
    expect(actual).toEqual([...EXPECTED_CODES].sort());
  });

  test("rejects a code outside the set", () => {
    expect(ErrorCode.safeParse("PAYMENT_REQUIRED").success).toBe(false);
  });
});

describe("EngineError", () => {
  test.each(EXPECTED_CODES)("accepts a bare %s error", (code) => {
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
});
