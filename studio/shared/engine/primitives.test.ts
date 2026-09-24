import { describe, expect, test } from "bun:test";
import { AbsolutePath, ApiKey, Count, Id, Micros, ModelId, redactSecrets, SafeText } from "./primitives";

describe("Id", () => {
  test.each(["abcdefgh", "a1b2c3d4-e5f6", "0".repeat(64), crypto.randomUUID()])(
    "accepts lowercase alphanumerics and dashes: %s",
    (id) => {
      expect(Id.safeParse(id).success).toBe(true);
    },
  );

  test.each([
    ["uppercase", "ABCDEFGH"],
    ["mixed case", "abcdEfgh"],
    ["parent traversal", "../abcdefgh"],
    ["slash", "abcd/efgh"],
    ["backslash", "abcd\\efgh"],
    ["dot", "abcd.efgh"],
    ["underscore", "abcd_efgh"],
    ["space", "abcd efgh"],
    ["one below the minimum length", "a".repeat(7)],
    ["one above the maximum length", "a".repeat(65)],
    ["empty", ""],
  ])("rejects an id with %s", (_label, id) => {
    expect(Id.safeParse(id).success).toBe(false);
  });

  test("rejects a non-string id", () => {
    expect(Id.safeParse(12345678).success).toBe(false);
  });
});

describe("Micros", () => {
  test.each([0, 1, 50_000, Number.MAX_SAFE_INTEGER])("accepts the integer %p", (n) => {
    expect(Micros.safeParse(n).success).toBe(true);
  });

  test.each([
    ["a float", 0.5],
    ["a float dollar amount", 0.05],
    ["a negative integer", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["a numeric string", "50000"],
    ["a bigint", 50_000n],
  ])("rejects %s", (_label, value) => {
    expect(Micros.safeParse(value).success).toBe(false);
  });
});

describe("Count", () => {
  test("accepts zero", () => {
    expect(Count.safeParse(0).success).toBe(true);
  });

  test.each([-1, 1.5])("rejects %p", (n) => {
    expect(Count.safeParse(n).success).toBe(false);
  });
});

describe("ModelId", () => {
  test.each(["x-ai/grok-imagine-image-2.0", "x-ai/grok-4.3", "bytedance/seedream-5-pro", "meta-llama/llama-3:free"])(
    "accepts the OpenRouter model id %s",
    (id) => {
      expect(ModelId.safeParse(id).success).toBe(true);
    },
  );

  test.each([
    ["no vendor", "grok-4.3"],
    ["uppercase", "X-AI/Grok"],
    ["two slashes", "x-ai/grok/4"],
    ["a space", "x-ai/grok 4"],
    ["too long", `x-ai/${"a".repeat(130)}`],
  ])("rejects a model id with %s", (_label, id) => {
    expect(ModelId.safeParse(id).success).toBe(false);
  });
});

describe("AbsolutePath", () => {
  test.each(["/Users/alex/Studio/library", "C:\\Users\\alex\\Studio", "D:/Studio", "\\\\server\\share\\studio"])(
    "accepts the absolute path %s",
    (p) => {
      expect(AbsolutePath.safeParse(p).success).toBe(true);
    },
  );

  test.each([
    ["relative", "Studio/library"],
    ["dot-relative", "./library"],
    ["empty", ""],
    ["carrying a NUL byte", "/Users/alex\0/lib"],
    ["using a parent segment", "/Users/alex/../root"],
    ["using a Windows parent segment", "C:\\Users\\..\\Admin"],
    ["over 4096 chars", `/${"a".repeat(4096)}`],
  ])("rejects a path that is %s", (_label, p) => {
    expect(AbsolutePath.safeParse(p).success).toBe(false);
  });
});

describe("ApiKey", () => {
  test("accepts an OpenRouter-shaped key", () => {
    expect(ApiKey.safeParse(`sk-or-v1-${"0a".repeat(32)}`).success).toBe(true);
  });

  test.each([
    ["empty", ""],
    ["shorter than 8 chars", "sk-or-1"],
    ["whitespace inside", "sk-or-v1 abc123"],
    ["a trailing newline", "sk-or-v1-abc123\n"],
    ["non-ASCII", "sk-or-v1-ключ1234"],
    ["over 256 chars", "a".repeat(257)],
  ])("rejects a key that is %s", (_label, key) => {
    expect(ApiKey.safeParse(key).success).toBe(false);
  });
});

describe("redactSecrets", () => {
  test.each([
    ["an OpenRouter key", "auth failed for sk-or-v1-deadbeefdeadbeef", "auth failed for [redacted]"],
    ["a short OpenRouter-prefixed key", "key sk-or-abc", "key [redacted]"],
    ["another provider's key", "used sk-ant-api03-AbCdEfGh_1234567890", "used [redacted]"],
    ["a bearer token", "header Authorization: Bearer abc.def-123 sent", "header Authorization: Bearer [redacted] sent"],
    ["a lowercase bearer token", "bearer xyz789", "bearer [redacted]"],
  ])("removes %s", (_label, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  test.each(["desk-organizer-with-drawers", "task-sk-short", "provider returned 503"])(
    "leaves ordinary text %p alone",
    (text) => {
      expect(redactSecrets(text)).toBe(text);
    },
  );
});

describe("SafeText", () => {
  test("accepts ordinary diagnostic text unchanged", () => {
    expect(SafeText.parse("provider returned 503: upstream overloaded")).toBe("provider returned 503: upstream overloaded");
  });

  test("strips an OpenRouter key instead of carrying it", () => {
    expect(SafeText.parse("auth failed for sk-or-v1-deadbeefdeadbeef")).toBe("auth failed for [redacted]");
  });

  test("strips a bearer token", () => {
    expect(SafeText.parse("Bearer sk-or-v1-deadbeef refused")).not.toContain("deadbeef");
  });

  test("rejects text over 500 chars", () => {
    expect(SafeText.safeParse("a".repeat(501)).success).toBe(false);
  });

  test("accepts text of exactly 500 chars", () => {
    expect(SafeText.safeParse("a".repeat(500)).success).toBe(true);
  });
});
