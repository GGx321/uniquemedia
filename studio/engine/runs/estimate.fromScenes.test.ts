import { describe, expect, test } from "bun:test";
import { AGE_CHECK_CALL, estimateRun, WRITER_CALL } from "../money/estimate";
import { PriceBook } from "../money/prices";
import { runEstimate, runEstimateFromScenes, runPriceModels, runRoute, sceneRunPriceModels } from "./plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.5: what a run made from a reviewed scene set could cost. Every sentence exists, so there is no writer term: M photos, three attempts each at the
// dearest image of the route, plus an age check per attempt when the check is on. Fallback prices: one image attempt 50_000 micros, a writer call 37_500,
// an age check 1_000 or so (read from the book below, never copied).

const PRICED = { book: PriceBook.fallback(), asOf: "2026-10-07" };
const MODELS = { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" };
const IMAGE_WORST = 50_000;
const WRITER_WORST = 37_500;

describe("estimateRun with no writer", () => {
  test("a null writer takes the writer term out of both figures", () => {
    const route = runRoute(MODELS.imageModel);
    const withWriter = estimateRun(PRICED.book, { photos: 18, attemptsPerSlot: 3, route, writer: { ...WRITER_CALL, model: MODELS.textModel }, ageChecks: null });
    const without = estimateRun(PRICED.book, { photos: 18, attemptsPerSlot: 3, route, writer: null, ageChecks: null });
    expect(withWriter.worstMicros - without.worstMicros).toBe(1 * 2 * WRITER_WORST);
    expect(withWriter.expectedMicros).toBeGreaterThan(without.expectedMicros);
  });
});

describe("runEstimateFromScenes", () => {
  test("18 photos: three attempts each at the dearest image, nothing for a writer", () => {
    const estimate = runEstimateFromScenes(PRICED, MODELS, { count: 18 }, "off");
    expect(estimate.worstMicros).toBe(18 * 3 * IMAGE_WORST);
    expect(estimate.expectedMicros).toBe(18 * IMAGE_WORST);
  });

  test("is exactly the whole run's estimate less its writer", () => {
    for (const count of [1, 5, 25, 26, 100]) {
      const whole = runEstimate(PRICED, MODELS, { count }, "off");
      const scenes = runEstimateFromScenes(PRICED, MODELS, { count }, "off");
      expect(whole.worstMicros - scenes.worstMicros).toBe(Math.ceil(count / 25) * 2 * WRITER_WORST);
    }
  });

  test("a removed scene lowers the worst case by exactly its three attempts", () => {
    const twenty = runEstimateFromScenes(PRICED, MODELS, { count: 20 }, "off");
    const eighteen = runEstimateFromScenes(PRICED, MODELS, { count: 18 }, "off");
    expect(twenty.worstMicros - eighteen.worstMicros).toBe(2 * 3 * IMAGE_WORST);
  });

  test("an age check on adds the check's ceiling to every attempt, still with no writer", () => {
    const off = runEstimateFromScenes(PRICED, MODELS, { count: 4 }, "off");
    const on = runEstimateFromScenes(PRICED, MODELS, { count: 4 }, "on");
    const ageCeiling = PRICED.book.chatWorstCase({ model: AGE_CHECK_CALL.model, maxTokens: AGE_CHECK_CALL.maxTokens, inputTokens: AGE_CHECK_CALL.inputTokens, images: AGE_CHECK_CALL.images });
    expect(on.worstMicros - off.worstMicros).toBe(4 * 3 * ageCeiling);
    expect(on.worstMicros).toBe(whole(4, "on") - 1 * 2 * WRITER_WORST);
  });

  test("the expected figure never exceeds the worst", () => {
    const estimate = runEstimateFromScenes(PRICED, MODELS, { count: 7 }, "on");
    expect(estimate.expectedMicros).toBeLessThanOrEqual(estimate.worstMicros);
  });

  test("zero photos cost nothing", () => {
    expect(runEstimateFromScenes(PRICED, MODELS, { count: 0 }, "off")).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });

  test("a Seedream run has no fallback to add: its route is its one model", () => {
    const seedream = runEstimateFromScenes(PRICED, { imageModel: "bytedance-seed/seedream-5-0-pro", textModel: MODELS.textModel }, { count: 3 }, "off");
    expect(seedream.worstMicros).toBe(3 * 3 * PRICED.book.imageWorstCase({ model: "bytedance-seed/seedream-5-0-pro", quality: null, refs: 1 }));
  });
});

function whole(count: number, age: "on" | "off"): number {
  return runEstimate(PRICED, MODELS, { count }, age).worstMicros;
}

describe("sceneRunPriceModels", () => {
  test("asks for no chat price when the age check is off: a run from a set has no writer", () => {
    expect(sceneRunPriceModels(MODELS, "off").chatModels).toEqual([]);
  });

  test("asks for the age check's model alone when it is on, never the text model", () => {
    expect(sceneRunPriceModels(MODELS, "on").chatModels).toEqual([AGE_CHECK_CALL.model]);
  });

  test("prices the same image models as a whole run and rechecks their endpoints", () => {
    const whole = runPriceModels(MODELS, "off");
    expect(sceneRunPriceModels(MODELS, "off")).toMatchObject({ imageModels: whole.imageModels, checkRequestShape: true });
  });
});
