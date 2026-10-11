import { describe, expect, test } from "bun:test";
import { WRITER_CALL, writerWorstMicros } from "../money/estimate";
import { PriceBook } from "../money/prices";
import { reviewWriteEstimate } from "./estimate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: what a rewrite or an idea write could cost. It is ONE writer request (at most five scenes), asked at most twice: the estimate is the writer's
// ceiling times the attempts the write has left, and it is the accepted worst the job's cap is set to, so no reserve can exceed what the owner was shown.

const MODEL = "x-ai/grok-4.3";
const PRICED = { book: PriceBook.fallback(), asOf: "2026-09-24" };
/** One writer attempt at its ceilings (14K in, 8K out) at the fallback prices. */
const CEILING = 37_500;

describe("reviewWriteEstimate", () => {
  test("a fresh write is WRITER_CALL × 2: two attempts at the ceiling, for one to five scenes alike", () => {
    for (const scenes of [1, 2, 5]) {
      expect(reviewWriteEstimate(PRICED, MODEL, scenes, 2).worstMicros).toBe(2 * CEILING);
    }
  });

  test("agrees with the writer's own worst case for one chunk, the figure a run's estimate carries", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 3, 2).worstMicros).toBe(writerWorstMicros(PRICED.book, { ...WRITER_CALL, model: MODEL }, 3));
  });

  test("a write with one attempt left (after an open or reconciled reserve) is one ceiling", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 2, 1).worstMicros).toBe(CEILING);
  });

  test("a write with none left costs nothing and prices nothing", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 2, 0)).toEqual({ expectedMicros: 0, worstMicros: 0, prices: PRICED.book.source, pricesAsOf: PRICED.asOf });
  });

  test("expects the writer's typical tokens per scene, never above the worst", () => {
    const one = reviewWriteEstimate(PRICED, MODEL, 1, 2);
    const five = reviewWriteEstimate(PRICED, MODEL, 5, 2);
    expect(one.expectedMicros).toBeGreaterThan(0);
    expect(five.expectedMicros).toBeGreaterThan(one.expectedMicros);
    expect(five.expectedMicros).toBeLessThanOrEqual(five.worstMicros);
  });

  test("a single scene's rewrite expects about two thousandths of a dollar, as the design says («≈ $0.002»)", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 1, 2).expectedMicros).toBeLessThan(2_500);
    expect(reviewWriteEstimate(PRICED, MODEL, 1, 2).expectedMicros).toBeGreaterThan(300);
  });

  test("carries the price source and date of the book, like every estimate", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 1, 2)).toMatchObject({ prices: PRICED.book.source, pricesAsOf: PRICED.asOf });
  });

  // 5a.2 (S5.6c2): priced from the write's actual slots. The code template writes every scene it can at $0, so a write whose scenes all render costs nothing and
  // asks no price; one scene the template cannot write puts the whole request (the model's scenes alone) back at its attempts × the ceiling.
  test("a write whose every scene the template writes costs nothing and prices nothing", () => {
    expect(reviewWriteEstimate(PRICED, "vendor/unlisted-model", 3, 2, 0)).toEqual({ expectedMicros: 0, worstMicros: 0, prices: PRICED.book.source, pricesAsOf: PRICED.asOf });
  });

  test("one scene for the model keeps the request at its attempts × the ceiling, whatever the template writes beside it", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 5, 2, 1).worstMicros).toBe(2 * CEILING);
    expect(reviewWriteEstimate(PRICED, MODEL, 5, 1, 1).worstMicros).toBe(CEILING);
  });

  test("expects the typical tokens of the model's scenes only", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 5, 2, 2).expectedMicros).toBe(reviewWriteEstimate(PRICED, MODEL, 2, 2).expectedMicros);
  });

  test("with no model count given every scene is the model's, as before", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 3, 2)).toEqual(reviewWriteEstimate(PRICED, MODEL, 3, 2, 3));
  });

  test("refuses more scenes for the model than the write covers", () => {
    expect(() => reviewWriteEstimate(PRICED, MODEL, 2, 2, 3)).toThrow();
    expect(() => reviewWriteEstimate(PRICED, MODEL, 2, 2, -1)).toThrow();
  });

  test("refuses a count that is not one to five scenes, or attempts that are not 0..2", () => {
    expect(() => reviewWriteEstimate(PRICED, MODEL, 0, 2)).toThrow();
    expect(() => reviewWriteEstimate(PRICED, MODEL, 6, 2)).toThrow();
    expect(() => reviewWriteEstimate(PRICED, MODEL, 1, 3)).toThrow();
    expect(() => reviewWriteEstimate(PRICED, MODEL, 1, -1)).toThrow();
  });
});
