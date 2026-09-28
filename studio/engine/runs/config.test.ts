import { describe, expect, test } from "bun:test";
import { defaultQaConfig, QaConfigSchema } from "./config";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T7a: the QA gates' own tunable thresholds, zod-validated like face/config.ts.

describe("defaultQaConfig", () => {
  test("the documented defaults: 20 of 256 bits for pdq's near-duplicate threshold, 200 for its gradient-energy floor", () => {
    expect(defaultQaConfig()).toEqual({ pdq: { maxHammingDistance: 20, minGradientEnergy: 200 } });
  });

  test("the default parses against its own schema (it is not hand-built past validation)", () => {
    expect(QaConfigSchema.safeParse(defaultQaConfig()).success).toBe(true);
  });
});

describe("QaConfigSchema: maxHammingDistance", () => {
  test("accepts a distance at the boundaries, 0 and 256", () => {
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: 0, minGradientEnergy: 0 } }).success).toBe(true);
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: 256, minGradientEnergy: 0 } }).success).toBe(true);
  });

  test("rejects a distance one past either boundary", () => {
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: -1, minGradientEnergy: 0 } }).success).toBe(false);
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: 257, minGradientEnergy: 0 } }).success).toBe(false);
  });

  test("rejects a non-integer distance", () => {
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: 20.5, minGradientEnergy: 0 } }).success).toBe(false);
  });
});

describe("QaConfigSchema: minGradientEnergy", () => {
  test("accepts 0 (no quality floor at all)", () => {
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: 20, minGradientEnergy: 0 } }).success).toBe(true);
  });

  test("rejects a negative value", () => {
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: 20, minGradientEnergy: -1 } }).success).toBe(false);
  });

  test("rejects a non-integer value", () => {
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: 20, minGradientEnergy: 1.5 } }).success).toBe(false);
  });

  test("is required: missing entirely is refused, not defaulted", () => {
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: 20 } }).success).toBe(false);
  });
});

describe("QaConfigSchema: object shape", () => {
  test("rejects an unknown top-level key (strict, like face/config.ts)", () => {
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: 20, minGradientEnergy: 0 }, extra: 1 }).success).toBe(false);
  });

  test("rejects an unknown key under pdq", () => {
    expect(QaConfigSchema.safeParse({ pdq: { maxHammingDistance: 20, minGradientEnergy: 0, other: 1 } }).success).toBe(false);
  });

  test("rejects a missing pdq section", () => {
    expect(QaConfigSchema.safeParse({}).success).toBe(false);
  });
});
