import { expect, test } from "bun:test";
import { AGE_CHECK_CALL, WRITER_CALL, estimateAvatarJob, estimateRun, type ImageChoice, type RunPlanInput } from "./estimate";
import { PriceBook } from "./prices";

const BOOK = PriceBook.fallback();

/** The Stage 2 default: grok-imagine-image-2.0, low, 1K, the master as the one reference ($0.05). */
const GROK_LOW_1K: ImageChoice = { model: "x-ai/grok-imagine-image-2.0", resolution: "1K", quality: "low", refs: 1 };
/** The one-attempt refusal fallback. */
const SEEDREAM_1K: ImageChoice = { model: "bytedance-seed/seedream-5-0-pro", resolution: "1K", quality: null, refs: 1 };

function plan(overrides: Partial<RunPlanInput> = {}): RunPlanInput {
  return {
    photos: 20,
    attemptsPerSlot: 3,
    route: [GROK_LOW_1K, SEEDREAM_1K],
    writer: WRITER_CALL,
    ageChecks: AGE_CHECK_CALL,
    ...overrides,
  };
}

const AGE_TYPICAL = 1_660; // 658 in × $1.25/M + 335 out × $2.50/M
const WRITER_TYPICAL_20 = 9_150; // 20 scenes × (106 in, 130 out)

test("the writer and age-check ceilings cost $0.03 and $0.005 at worst on grok-4.3", () => {
  expect(BOOK.chatWorstCase(WRITER_CALL)).toBe(30_000);
  expect(BOOK.chatWorstCase(AGE_CHECK_CALL)).toBe(5_000);
});

test("typical chat costs come from the spike's measured tokens", () => {
  const writer25 = { model: WRITER_CALL.model, images: 0, inputTokens: 25 * 106, outputTokens: 25 * 130 };

  expect(BOOK.chatCost({ model: AGE_CHECK_CALL.model, images: 1, ...AGE_CHECK_CALL.typical })).toBe(AGE_TYPICAL);
  expect(BOOK.chatCost(writer25)).toBe(11_438); // the spike's writer: $0.0112 for 25 scenes
});

test("20 photos × 3 attempts on the default route: worst $3.33, expected $1.04 for one attempt per slot", () => {
  expect(estimateRun(BOOK, plan())).toEqual({
    expectedMicros: 20 * (50_000 + AGE_TYPICAL) + WRITER_TYPICAL_20,
    worstMicros: 3_330_000,
    priceSource: "fallback",
  });
  expect(estimateRun(BOOK, plan()).expectedMicros).toBe(1_042_350);
});

test("the worst case takes the dearest model on the provider route, the expected cost the primary", () => {
  const grok2K: ImageChoice = { ...GROK_LOW_1K, resolution: "2K" }; // 60k + 10k
  const seedream2K: ImageChoice = { ...SEEDREAM_1K, resolution: "2K" }; // 90k + 3k

  expect(estimateRun(BOOK, plan({ photos: 1, route: [grok2K, seedream2K] }))).toEqual({
    expectedMicros: 70_000 + AGE_TYPICAL + 458,
    worstMicros: 3 * (93_000 + 5_000) + 30_000,
    priceSource: "fallback",
  });
});

test("the worst case scales with attempts per slot", () => {
  expect(estimateRun(BOOK, plan({ attemptsPerSlot: 1 })).worstMicros).toBe(20 * 55_000 + 30_000);
});

test("without age checks only the images and the writer count", () => {
  expect(estimateRun(BOOK, plan({ ageChecks: null }))).toMatchObject({ expectedMicros: 1_000_000 + WRITER_TYPICAL_20, worstMicros: 3_030_000 });
});

test("a single photo: one image, one age check and a one-scene writer", () => {
  expect(estimateRun(BOOK, plan({ photos: 1 }))).toMatchObject({ expectedMicros: 50_000 + AGE_TYPICAL + 458, worstMicros: 195_000 });
});

test("zero photos cost nothing, not even a writer call", () => {
  expect(estimateRun(BOOK, plan({ photos: 0 }))).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
});

test("attempts per slot must be between 1 and 3", () => {
  expect(() => estimateRun(BOOK, plan({ attemptsPerSlot: 0 }))).toThrow(RangeError);
  expect(() => estimateRun(BOOK, plan({ attemptsPerSlot: 4 }))).toThrow(RangeError);
  expect(estimateRun(BOOK, plan({ attemptsPerSlot: 3 })).worstMicros).toBe(3_330_000);
});

test("photos must be a non-negative integer", () => {
  expect(() => estimateRun(BOOK, plan({ photos: 1.5 }))).toThrow(TypeError);
  expect(() => estimateRun(BOOK, plan({ photos: -1 }))).toThrow(TypeError);
});

test("the provider route must name at least one model", () => {
  const route: ImageChoice[] = [];
  const empty = { ...plan(), route } as unknown as RunPlanInput; // the tuple type forbids it; a runtime caller might not

  expect(() => estimateRun(BOOK, empty)).toThrow("route");
});

test("the estimate reports live prices when the book has only live prices", () => {
  const live = new PriceBook(
    new Map([["acme/img", { price: { outputs: [{ variant: null, micros: 10_000 }], inputImageMicros: 0 }, source: "live" as const }]]),
    new Map([["acme/chat", { price: { promptPico: 1_000_000, completionPico: 1_000_000, imagePico: 0, requestPico: 0, overrides: [] }, source: "live" as const }]])
  );
  const chat = { model: "acme/chat", maxTokens: 1_000, inputTokens: 0, images: 0, typical: { inputTokens: 0, outputTokens: 100 } };
  const writer = { model: "acme/chat", maxTokens: 1_000, inputTokens: 0, images: 0, typicalPerScene: { inputTokens: 0, outputTokens: 10 } };

  expect(estimateRun(live, plan({ route: [{ model: "acme/img", resolution: "1K", quality: null, refs: 0 }], writer, ageChecks: chat }))).toEqual({
    expectedMicros: 20 * (10_000 + 100) + 200,
    worstMicros: 60 * (10_000 + 1_000) + 1_000,
    priceSource: "live",
  });
});

test("an avatar job: 4 candidates, a descriptor call and an age check per candidate (worst ≈ $0.23)", () => {
  const descriptor = { model: "x-ai/grok-4.3", maxTokens: 2_000, inputTokens: 2_000, images: 0, typical: { inputTokens: 600, outputTokens: 400 } };

  expect(
    estimateAvatarJob(BOOK, {
      candidates: 4,
      image: { model: "x-ai/grok-imagine-image-quality", resolution: "1K", quality: null, refs: 0 },
      descriptor,
      ageChecks: AGE_CHECK_CALL,
    })
  ).toEqual({ expectedMicros: 4 * (50_000 + AGE_TYPICAL) + 1_750, worstMicros: 227_500, priceSource: "fallback" });
});
