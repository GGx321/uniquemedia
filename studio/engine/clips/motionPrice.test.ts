import { describe, expect, test } from "bun:test";
import { Estimate, MOTION_SUGGEST_EXPECTED_MICROS, MOTION_SUGGEST_WORST_MICROS, MOTION_TRANSLATE_EXPECTED_MICROS, MOTION_TRANSLATE_WORST_MICROS, MOTION_MAX_ATTEMPTS } from "../../shared/engine";
import { chatAttemptWorstMicros } from "../openrouter/chat";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { PriceBook } from "../money/prices";
import { SUGGEST_ATTEMPT, TRANSLATE_ATTEMPT, motionPriceModels } from "../money/motionEstimate";
import { suggestPrice as suggestEstimate, translatePrice as translateEstimate } from "./motionPrice";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3 «Money per call», I5.68): the two estimates of part C, on the settings' text model. The worst case is two attempts, each priced as the chat client reserves
// it (`chatAttemptWorstMicros`: the caller's ceilings, the prompt never below its byte floor), so a call's reserve can never exceed the price the owner accepted.

const PRICED = { book: PriceBook.fallback(), asOf: "2026-09-24" };
const MODEL = "x-ai/grok-4.3";
const SMALL = { messages: [{ role: "system" as const, content: "s".repeat(600) }, { role: "user" as const, content: "u".repeat(300) }], jsonSchema: { name: "x", schema: { type: "object" } } };
const HUGE = { messages: [{ role: "system" as const, content: "s".repeat(9_000) }, { role: "user" as const, content: "u".repeat(2_000) }], jsonSchema: { name: "x", schema: { type: "object" } } };

describe("motionPriceModels", () => {
  test("prices the settings' text model alone", () => {
    expect(motionPriceModels(MODEL)).toEqual({ imageModels: [], chatModels: [MODEL] });
  });
});

describe("suggestEstimate", () => {
  test("is the design figure for a prompt within the ceiling: about $0.0034 expected, $0.0125 worst (two attempts)", () => {
    const estimate = suggestEstimate(PRICED, MODEL, { ...SMALL, messages: [{ role: "system", content: "s".repeat(800) }, { role: "user", content: "u".repeat(300) }] });
    expect(estimate).toMatchObject({ expectedMicros: MOTION_SUGGEST_EXPECTED_MICROS, worstMicros: MOTION_SUGGEST_WORST_MICROS, prices: "fallback", pricesAsOf: "2026-09-24" });
    expect(Estimate.safeParse(estimate).success).toBe(true);
  });

  test("the worst case is MOTION_MAX_ATTEMPTS attempts, each exactly what the chat client would reserve for that message", () => {
    const attempt = chatAttemptWorstMicros(PRICED.book, { model: MODEL, ...HUGE, maxTokens: SUGGEST_ATTEMPT.maxTokens, inputTokens: SUGGEST_ATTEMPT.inputTokens, images: 1 });
    expect(suggestEstimate(PRICED, MODEL, HUGE).worstMicros).toBe(MOTION_MAX_ATTEMPTS * attempt);
  });

  test("a bigger prompt raises the worst case, never lowers the figure below the ceilings", () => {
    expect(suggestEstimate(PRICED, MODEL, HUGE).worstMicros).toBeGreaterThan(suggestEstimate(PRICED, MODEL, SMALL).worstMicros);
    expect(suggestEstimate(PRICED, MODEL, SMALL).worstMicros).toBeGreaterThanOrEqual(MOTION_SUGGEST_WORST_MICROS);
  });

  test("counts one image: the photo", () => {
    expect(SUGGEST_ATTEMPT.images).toBe(1);
  });

  test("whole micro-dollars, expected not above worst", () => {
    const estimate = suggestEstimate(PRICED, MODEL, SMALL);
    expect(Number.isInteger(estimate.expectedMicros) && Number.isInteger(estimate.worstMicros)).toBe(true);
    expect(estimate.expectedMicros).toBeLessThanOrEqual(estimate.worstMicros);
  });
});

describe("translateEstimate", () => {
  test("is the design figure for a prompt within the ceiling: about $0.001 expected, $0.005 worst", () => {
    const tiny = { messages: [{ role: "system" as const, content: "s".repeat(300) }, { role: "user" as const, content: "u".repeat(100) }], jsonSchema: { name: "x", schema: { type: "object" } } };
    expect(translateEstimate(PRICED, MODEL, tiny)).toMatchObject({ expectedMicros: MOTION_TRANSLATE_EXPECTED_MICROS, worstMicros: MOTION_TRANSLATE_WORST_MICROS, prices: "fallback" });
  });

  test("carries no image", () => {
    expect(TRANSLATE_ATTEMPT.images).toBe(0);
  });

  test("the worst case is MOTION_MAX_ATTEMPTS attempts of what the chat client would reserve", () => {
    const attempt = chatAttemptWorstMicros(PRICED.book, { model: MODEL, ...HUGE, maxTokens: TRANSLATE_ATTEMPT.maxTokens, inputTokens: TRANSLATE_ATTEMPT.inputTokens, images: 0 });
    expect(translateEstimate(PRICED, MODEL, HUGE).worstMicros).toBe(MOTION_MAX_ATTEMPTS * attempt);
  });
});
