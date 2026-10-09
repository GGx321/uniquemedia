import { describe, expect, test } from "bun:test";
import { launchEstimate, MAX_GENERATED_PER_AVATAR } from "../../shared/autopilot/estimate";
import { composeEstimate } from "../sceneSets/estimate";
import { AGE_CHECK_CALL, WRITER_CALL } from "../money/estimate";
import type { PricedBook } from "../money/priceCache";
import { PriceBook, type ChatPrice, type ImagePrice, type PriceEntry } from "../money/prices";
import { runEstimateFromScenes, runPriceModels } from "../runs/plan";
import { launchPriceModels, unitPricesOf } from "./prices";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.2 (plan §4.2, invariant A18): the unit prices the launch estimate takes are read from the engine's own estimates, so for one avatar and every n in
// 1..100 the launch's worst and expected equal `composeEstimate(n) + runEstimateFromScenes(n)` on the same price book: on the live book and on the dated
// fallback book, with the age check off and on, with the primary model and with Seedream (a one-model route).

const MODELS = { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" };
const SEEDREAM = { imageModel: "bytedance-seed/seedream-5-0-pro", textModel: "x-ai/grok-4.3" };

const FALLBACK: PricedBook = { book: PriceBook.fallback(), asOf: "2026-09-24" };

/** A live book at the plan's worked-example prices: an image attempt of $0.06 plus a $0.01 reference image is $0.07. */
function liveBook(): PricedBook {
  const grok: ImagePrice = {
    outputs: [
      { variant: "low_1k", micros: 60_000 },
      { variant: "medium_1k", micros: 80_000 },
    ],
    inputImageMicros: 10_000,
  };
  const seedream: ImagePrice = { outputs: [{ variant: null, micros: 45_000 }], inputImageMicros: 3_000 };
  const chat: ChatPrice = {
    promptPico: 1_250_000,
    completionPico: 2_500_000,
    imagePico: 0,
    requestPico: 0,
    overrides: [{ minPromptTokens: 200_000, promptPico: 2_500_000, completionPico: 5_000_000, imagePico: 0, requestPico: 0 }],
  };
  const image = (price: ImagePrice): PriceEntry<ImagePrice> => ({ price, source: "live" });
  const book = new PriceBook(
    new Map([
      ["x-ai/grok-imagine-image-2.0", image(grok)],
      ["bytedance-seed/seedream-5-0-pro", image(seedream)],
    ]),
    new Map([["x-ai/grok-4.3", { price: chat, source: "live" as const }]]),
  );
  return { book, asOf: "2026-10-09" };
}

const BOOKS: [string, PricedBook][] = [
  ["the live book", liveBook()],
  ["the fallback book", FALLBACK],
];

describe("A18: the launch estimate equals the engine's compose plus draw estimates", () => {
  for (const [name, priced] of BOOKS) {
    for (const models of [MODELS, SEEDREAM]) {
      for (const ageCheck of ["off", "on"] as const) {
        test(`on ${name}, ${models.imageModel}, age check ${ageCheck}: n = 1..100 matches to the micro-dollar`, () => {
          const unit = unitPricesOf(priced, models, ageCheck);
          for (let n = 1; n <= MAX_GENERATED_PER_AVATAR; n++) {
            const launch = launchEstimate([{ avatarId: "a", photos: n }], unit);
            const compose = composeEstimate(priced, models.textModel, n);
            const draw = runEstimateFromScenes(priced, models, { count: n }, ageCheck);
            expect({ n, worst: launch.worstMicros, expected: launch.expectedMicros }).toEqual({
              n,
              worst: compose.worstMicros + draw.worstMicros,
              expected: compose.expectedMicros + draw.expectedMicros,
            });
            expect(launch.avatars[0]).toMatchObject({
              composeWorstMicros: compose.worstMicros,
              drawWorstMicros: draw.worstMicros,
              composeExpectedMicros: compose.expectedMicros,
              drawExpectedMicros: draw.expectedMicros,
            });
          }
        });
      }
    }
  }

  test("an avatar that needs nothing costs nothing on both books", () => {
    for (const [, priced] of BOOKS) {
      expect(launchEstimate([{ avatarId: "a", photos: 0 }], unitPricesOf(priced, MODELS, "off"))).toMatchObject({ worstMicros: 0, expectedMicros: 0 });
    }
  });
});

describe("the plan's worked example on the live book (§4.2)", () => {
  test("one avatar, 90 new photos: W is 19 200 000 µ$ and E is about $6.34", () => {
    const estimate = launchEstimate([{ avatarId: "mia", photos: 90 }], unitPricesOf(liveBook(), MODELS, "off"));
    expect(estimate.worstMicros).toBe(19_200_000);
    expect(estimate.expectedMicros).toBeGreaterThan(6_335_000);
    expect(estimate.expectedMicros).toBeLessThan(6_345_000);
  });

  test("an attempt reserves $0.07 and a photo's worst case is three of them", () => {
    const unit = unitPricesOf(liveBook(), MODELS, "off");
    expect(unit.photoExpectedMicros).toBe(70_000 + 0);
    expect(unit.photoWorstMicros).toBe(3 * 70_000);
  });

  test("the writer's ceiling is the per-call ceiling of the settings' text model, $0.0375", () => {
    expect(unitPricesOf(liveBook(), MODELS, "off").writerCeilingMicros).toBe(37_500);
  });
});

describe("unitPricesOf", () => {
  test("the dearer route model prices every attempt: a Seedream fallback dearer than the primary raises the photo's worst case", () => {
    const grok = unitPricesOf(FALLBACK, MODELS, "off");
    // Fallback table: grok low 40 000 + 10 000 reference = 50 000 per attempt, Seedream 45 000 + 3 000: the primary is dearer.
    expect(grok.photoWorstMicros).toBe(3 * 50_000);
    const seedream = unitPricesOf(FALLBACK, SEEDREAM, "off");
    expect(seedream.photoWorstMicros).toBe(3 * 48_000);
  });

  test("the age check adds its typical cost to the expected price and its ceiling to every attempt of the worst case", () => {
    const off = unitPricesOf(FALLBACK, MODELS, "off");
    const on = unitPricesOf(FALLBACK, MODELS, "on");
    const ceiling = FALLBACK.book.chatWorstCase({ model: AGE_CHECK_CALL.model, maxTokens: AGE_CHECK_CALL.maxTokens, inputTokens: AGE_CHECK_CALL.inputTokens, images: AGE_CHECK_CALL.images });
    expect(on.photoWorstMicros - off.photoWorstMicros).toBe(3 * ceiling);
    expect(on.photoExpectedMicros).toBeGreaterThan(off.photoExpectedMicros);
  });

  test("the writer's chunk and attempts are the writer call's own", () => {
    const unit = unitPricesOf(FALLBACK, MODELS, "off");
    expect(unit.writerChunkSlots).toBe(WRITER_CALL.slotsPerCall);
    expect(unit.writerMaxAttempts).toBe(WRITER_CALL.maxAttempts);
  });

  test("the price table has an entry for every count from 0 to 100 and none above", () => {
    const unit = unitPricesOf(FALLBACK, MODELS, "off");
    expect(unit.writerTypicalMicros.length).toBe(MAX_GENERATED_PER_AVATAR + 1);
    expect(unit.writerTypicalMicros[0]).toBe(0);
  });

  test("the price source and date are the book's", () => {
    expect(unitPricesOf(FALLBACK, MODELS, "off")).toMatchObject({ prices: "fallback", pricesAsOf: "2026-09-24" });
    expect(unitPricesOf(liveBook(), MODELS, "off")).toMatchObject({ prices: "live", pricesAsOf: "2026-10-09" });
  });
});

describe("launchPriceModels", () => {
  test("is the models a whole run prices: the route's images, the text model and, when on, the age check's", () => {
    expect(launchPriceModels(MODELS, "off")).toEqual(runPriceModels(MODELS, "off"));
    expect(launchPriceModels(MODELS, "on")).toEqual(runPriceModels(MODELS, "on"));
  });
});
