import { describe, expect, test } from "bun:test";
import { WRITER_BOLD_CALL, WRITER_CALL, writerExpectedMicros, writerWorstMicros } from "../money/estimate";
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
      expect(reviewWriteEstimate(PRICED, MODEL, scenes, 2, scenes, "ordinary").worstMicros).toBe(2 * CEILING);
    }
  });

  test("agrees with the writer's own worst case for one chunk, the figure a run's estimate carries", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 3, 2, 3, "ordinary").worstMicros).toBe(writerWorstMicros(PRICED.book, { ...WRITER_CALL, model: MODEL }, 3));
  });

  test("a write with one attempt left (after an open or reconciled reserve) is one ceiling", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 2, 1, 2, "ordinary").worstMicros).toBe(CEILING);
  });

  test("a write with none left costs nothing and prices nothing", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 2, 0, 2, "ordinary")).toEqual({ expectedMicros: 0, worstMicros: 0, prices: PRICED.book.source, pricesAsOf: PRICED.asOf });
  });

  test("expects the writer's typical tokens per scene, never above the worst", () => {
    const one = reviewWriteEstimate(PRICED, MODEL, 1, 2, 1, "ordinary");
    const five = reviewWriteEstimate(PRICED, MODEL, 5, 2, 5, "ordinary");
    expect(one.expectedMicros).toBeGreaterThan(0);
    expect(five.expectedMicros).toBeGreaterThan(one.expectedMicros);
    expect(five.expectedMicros).toBeLessThanOrEqual(five.worstMicros);
  });

  test("a single scene's rewrite expects about two thousandths of a dollar, as the design says («≈ $0.002»)", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 1, 2, 1, "ordinary").expectedMicros).toBeLessThan(2_500);
    expect(reviewWriteEstimate(PRICED, MODEL, 1, 2, 1, "ordinary").expectedMicros).toBeGreaterThan(300);
  });

  test("carries the price source and date of the book, like every estimate", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 1, 2, 1, "ordinary")).toMatchObject({ prices: PRICED.book.source, pricesAsOf: PRICED.asOf });
  });

  // 5a.2 (S5.6c2): priced from the write's actual slots. The code template writes every scene it can at $0, so a write whose scenes all render costs nothing and
  // asks no price; one scene the template cannot write puts the whole request (the model's scenes alone) back at its attempts × the ceiling.
  test("a write whose every scene the template writes costs nothing and prices nothing", () => {
    expect(reviewWriteEstimate(PRICED, "vendor/unlisted-model", 3, 2, 0, "ordinary")).toEqual({ expectedMicros: 0, worstMicros: 0, prices: PRICED.book.source, pricesAsOf: PRICED.asOf });
  });

  test("one scene for the model keeps the request at its attempts × the ceiling, whatever the template writes beside it", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 5, 2, 1, "ordinary").worstMicros).toBe(2 * CEILING);
    expect(reviewWriteEstimate(PRICED, MODEL, 5, 1, 1, "ordinary").worstMicros).toBe(CEILING);
  });

  test("expects the typical tokens of the model's scenes only", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 5, 2, 2, "ordinary").expectedMicros).toBe(reviewWriteEstimate(PRICED, MODEL, 2, 2, 2, "ordinary").expectedMicros);
  });

  test("with no model count given every scene is the model's, as before", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 3, 2, 3, "ordinary")).toEqual(reviewWriteEstimate(PRICED, MODEL, 3, 2, 3, "ordinary"));
  });

  test("refuses more scenes for the model than the write covers", () => {
    expect(() => reviewWriteEstimate(PRICED, MODEL, 2, 2, 3, "ordinary")).toThrow();
    expect(() => reviewWriteEstimate(PRICED, MODEL, 2, 2, -1, "ordinary")).toThrow();
  });

  test("refuses a count that is not one to five scenes, or attempts that are not 0..2", () => {
    expect(() => reviewWriteEstimate(PRICED, MODEL, 0, 2, 0, "ordinary")).toThrow();
    expect(() => reviewWriteEstimate(PRICED, MODEL, 6, 2, 6, "ordinary")).toThrow();
    expect(() => reviewWriteEstimate(PRICED, MODEL, 1, 3, 1, "ordinary")).toThrow();
    expect(() => reviewWriteEstimate(PRICED, MODEL, 1, -1, 1, "ordinary")).toThrow();
  });
});

// 5a.4 (S5.BA5, plan s5a4 I5.77, r2.1 L3; BA5a review L4): a rewrite is priced in the mode its job asks it in: a write whose scenes for the model hold a «Смелая» frame at the bold
// call (48 750 µ$ an attempt), any other at the ordinary one. The mode is a required argument, so a caller cannot price a bold write as an ordinary one by leaving it out.
describe("reviewWriteEstimate by mode", () => {
  const BOLD_CEILING = 48_750;

  test("a fresh bold write is two bold attempts: 97 500 µ$", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 1, 2, 1, "bold").worstMicros).toBe(2 * BOLD_CEILING);
  });

  test("a bold write with one attempt left is one bold ceiling", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 3, 1, 3, "bold").worstMicros).toBe(BOLD_CEILING);
  });

  test("a bold write expects the bold call's typical tokens for one request", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 2, 2, 2, "bold").expectedMicros).toBe(writerExpectedMicros(PRICED.book, { ...WRITER_BOLD_CALL, model: MODEL }, 1, 2));
  });

  test("a bold write the template writes whole costs nothing, as an ordinary one", () => {
    expect(reviewWriteEstimate(PRICED, MODEL, 2, 2, 0, "bold")).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });

  test("the mode is required, and a write without one is not priced as the cheaper call", () => {
    // @ts-expect-error a review write names its mode (plan s5a4 M3): an ordinary one says "ordinary"
    expect(() => reviewWriteEstimate(PRICED, MODEL, 1, 2, 1)).toThrow(RangeError);
  });
});
