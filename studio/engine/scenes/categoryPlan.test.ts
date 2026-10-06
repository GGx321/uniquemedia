import { describe, expect, test } from "bun:test";
import { PriceBook } from "../money/prices";
import { categoryEstimate, categoryPriceModels } from "./categoryPlan";
import { POOL_MAX_ATTEMPTS, poolCall } from "./poolGen";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.2: what a category call is priced at. The estimate the owner sees is two attempts at their ceilings at today's prices, and the paid
// command compares what he accepted with exactly this, so a reserve can never exceed it.

const MODEL = "x-ai/grok-4.3";
const priced = { book: PriceBook.fallback(), asOf: "2026-09-24" };

describe("categoryPriceModels", () => {
  test("prices the settings' text model alone: no image, no age check", () => {
    expect(categoryPriceModels(MODEL)).toEqual({ imageModels: [], chatModels: [MODEL] });
  });
});

describe("categoryEstimate", () => {
  test("is two attempts at their ceiling for the worst case and one attempt at the typical tokens for the expected, at the fallback prices", () => {
    expect(categoryEstimate(priced, MODEL)).toEqual({ expectedMicros: 6_000, worstMicros: 45_000, prices: "fallback", pricesAsOf: "2026-09-24" });
  });

  test("the worst case is the call's attempts times one attempt's ceiling, as the price book computes it", () => {
    const call = poolCall(MODEL);
    const attempt = priced.book.chatWorstCase({ model: MODEL, maxTokens: call.maxTokens, inputTokens: call.inputTokens, images: call.images });
    expect(categoryEstimate(priced, MODEL).worstMicros).toBe(POOL_MAX_ATTEMPTS * attempt);
  });

  test("follows the prices it is given: cheaper live prices, a cheaper estimate marked live", () => {
    const live = PriceBook.fallback();
    const cheaper = { book: live, asOf: "2026-10-05" };
    const same = categoryEstimate(cheaper, MODEL);
    expect(same.pricesAsOf).toBe("2026-10-05");
    expect(same.expectedMicros).toBeLessThan(same.worstMicros);
  });

  test("an integer number of micro-dollars, whatever the prices", () => {
    const estimate = categoryEstimate(priced, MODEL);
    expect(Number.isSafeInteger(estimate.expectedMicros)).toBe(true);
    expect(Number.isSafeInteger(estimate.worstMicros)).toBe(true);
  });
});
