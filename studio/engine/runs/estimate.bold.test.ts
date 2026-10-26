import { describe, expect, test } from "bun:test";
import type { RunRequest, SceneLevel } from "../../shared/engine";
import type { CoversOf } from "../../shared/scenes/writerBound";
import { AGE_CHECK_CALL, estimateRun, WRITER_BOLD_CALL, WRITER_CALL, writerExpectedMicros, type ImageChoice } from "../money/estimate";
import { MoneyError } from "../money/errors";
import { FALLBACK_IMAGE, PriceBook, type ImagePrice, type PriceEntry } from "../money/prices";
import { BOLD_IMAGE_MODEL, BOLD_RESOLUTION, boldRoute, FALLBACK_IMAGE_MODEL, runEstimate, runEstimateFromScenes, runPriceModels, sceneRunPriceModels, type BoldRequest } from "./plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, plan s5a3 §10): what a «Смелая» run could cost. A Seedream slot is priced at the 2K list price (93 000 µ$ with the master as its reference), three
// attempts, against the 1K route of every other slot. The §10.3 examples are pinned here on the models they were worked on: Grok quality, 60 000 µ$ an attempt.

const PRICED = { book: PriceBook.fallback(), asOf: "2026-10-12" };
const MODELS = { imageModel: "x-ai/grok-imagine-image-quality", imageQuality: null, textModel: "x-ai/grok-4.3" } as const;
const GROK_QUALITY = 60_000;
const BOLD_ATTEMPT = 93_000;
const AGE_CEILING = PRICED.book.chatWorstCase(AGE_CHECK_CALL);
const AGE_TYPICAL = PRICED.book.chatCost({ model: AGE_CHECK_CALL.model, images: AGE_CHECK_CALL.images, ...AGE_CHECK_CALL.typical });
const COVERED: CoversOf = () => true;

function fallbackImages(): [string, PriceEntry<ImagePrice>][] {
  return [...FALLBACK_IMAGE].map(([model, price]) => [model, { price, source: "fallback" as const }]);
}

/** A request at «Смелая» unless told otherwise: the two «Смелая» categories are drawn only there (I5.42). */
function request(categories: RunRequest["categories"], count: number, level: SceneLevel | undefined = "bold"): BoldRequest {
  return { count, categories, level };
}

describe("the bold route", () => {
  test("is the Seedream model the 1K moderation fallback also uses", () => {
    expect(BOLD_IMAGE_MODEL).toBe(FALLBACK_IMAGE_MODEL);
  });

  test("asks for 2K, no quality and one reference", () => {
    expect(boldRoute(BOLD_IMAGE_MODEL)).toEqual({ model: BOLD_IMAGE_MODEL, quality: null, refs: 1, resolution: BOLD_RESOLUTION });
    expect(BOLD_RESOLUTION).toBe("2K");
  });
});

describe("estimateRun with bold photos", () => {
  const route: [ImageChoice, ...ImageChoice[]] = [{ model: "x-ai/grok-imagine-image-quality", quality: null, refs: 1 }];
  const bold = boldRoute(BOLD_IMAGE_MODEL);
  const base = { attemptsPerSlot: 3, route, writer: null, ageChecks: null } as const;

  test("prices a bold photo at the 2K list price, three attempts", () => {
    expect(estimateRun(PRICED.book, { ...base, photos: 10, bold: { photos: 10, image: bold } })).toEqual({ expectedMicros: 10 * BOLD_ATTEMPT, worstMicros: 10 * 3 * BOLD_ATTEMPT, priceSource: "fallback", boldAttemptMicros: BOLD_ATTEMPT });
  });

  test("prices the other photos at the route as before", () => {
    const estimate = estimateRun(PRICED.book, { ...base, photos: 20, bold: { photos: 10, image: bold } });
    expect(estimate).toMatchObject({ expectedMicros: 10 * GROK_QUALITY + 10 * BOLD_ATTEMPT, worstMicros: 10 * 3 * GROK_QUALITY + 10 * 3 * BOLD_ATTEMPT });
  });

  test("with no bold photos the figures are the ones a run had before the route", () => {
    expect(estimateRun(PRICED.book, { ...base, photos: 20, bold: { photos: 0, image: bold } })).toEqual(estimateRun(PRICED.book, { ...base, photos: 20 }));
  });

  test("never prices a bold photo below the dearest model of the route", () => {
    const dear: ImagePrice = { outputs: [{ variant: "1k", micros: 120_000 }], inputImageMicros: 10_000 };
    const book = new PriceBook(new Map([...fallbackImages(), ["x-ai/grok-imagine-image-quality", { price: dear, source: "live" as const }]]), new Map());
    const estimate = estimateRun(book, { ...base, photos: 4, bold: { photos: 4, image: bold } });
    expect(estimate.worstMicros).toBe(4 * 3 * 130_000);
  });

  test("never shows an expected figure for a bold photo below the owner's model either", () => {
    const dear: ImagePrice = { outputs: [{ variant: "1k", micros: 120_000 }], inputImageMicros: 10_000 };
    const book = new PriceBook(new Map([...fallbackImages(), ["x-ai/grok-imagine-image-quality", { price: dear, source: "live" as const }]]), new Map());
    const estimate = estimateRun(book, { ...base, photos: 4, bold: { photos: 4, image: bold } });
    expect(estimate.expectedMicros).toBe(4 * 130_000);
  });

  test("adds the age check to every bold attempt, at its ceiling for the worst and its typical cost for the expected", () => {
    const estimate = estimateRun(PRICED.book, { ...base, photos: 10, ageChecks: AGE_CHECK_CALL, bold: { photos: 10, image: bold } });
    expect(estimate).toMatchObject({ expectedMicros: 10 * (BOLD_ATTEMPT + AGE_TYPICAL), worstMicros: 10 * 3 * (BOLD_ATTEMPT + AGE_CEILING) });
  });

  test("refuses more bold photos than photos", () => {
    expect(() => estimateRun(PRICED.book, { ...base, photos: 3, bold: { photos: 4, image: bold } })).toThrow(RangeError);
  });

  test("refuses a bold photo count that is not a whole number", () => {
    expect(() => estimateRun(PRICED.book, { ...base, photos: 3, bold: { photos: 1.5, image: bold } })).toThrow(TypeError);
  });

  test("a price list with no 2K line is PRICE_UNAVAILABLE for the bold scope, and only when a photo is bold", () => {
    const flat: ImagePrice = { outputs: [{ variant: null, micros: 45_000 }], inputImageMicros: 3_000 };
    const book = new PriceBook(new Map([...fallbackImages(), [BOLD_IMAGE_MODEL, { price: flat, source: "live" as const }]]), new Map());
    const thrown = (() => {
      try {
        estimateRun(book, { ...base, photos: 2, bold: { photos: 1, image: bold } });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(thrown).toBeInstanceOf(MoneyError);
    expect(thrown instanceof MoneyError && [thrown.code, thrown.scope]).toEqual(["PRICE_UNAVAILABLE", "bold"]);
    expect(estimateRun(book, { ...base, photos: 2, bold: { photos: 0, image: bold } }).worstMicros).toBe(2 * 3 * GROK_QUALITY);
  });
});

describe("the §10.3 examples (age check off, at list)", () => {
  test("«Ночнушки и бельё» 10: worst 2 790 000 µ$, expected 930 000 µ$", () => {
    const estimate = runEstimate(PRICED, MODELS, request(["nightwear"], 10), "off", COVERED);
    expect([estimate.worstMicros, estimate.expectedMicros]).toEqual([2_790_000, 930_000]);
  });

  // 5a.4 (S5.BA5, 2026-10-26, plan s5a4 §5.7, I5.77, BA3 review H-1): «Дом» at «Смелая» is on the route too, so all 20 are priced at the 2K attempt. This row told the pre-5a.4 figure
  // («Дом» on the owner's model): worst 4 590 000 µ$, expected 1 530 000 µ$.
  test("«Дом» 10 + «Ночнушки и бельё» 10: worst 5 580 000 µ$, expected 1 860 000 µ$", () => {
    const estimate = runEstimate(PRICED, MODELS, request(["home", "nightwear"], 20), "off", COVERED);
    expect([estimate.worstMicros, estimate.expectedMicros]).toEqual([5_580_000, 1_860_000]);
  });

  test("the five 20: worst 5 580 000 µ$, expected 1 860 000 µ$ (was 3 600 000 / 1 200 000 on the owner's model)", () => {
    const estimate = runEstimate(PRICED, MODELS, request(["home", "travel", "shoot", "glam", "fit"], 20), "off", COVERED);
    expect([estimate.worstMicros, estimate.expectedMicros, estimate.boldAttemptMicros]).toEqual([5_580_000, 1_860_000, BOLD_ATTEMPT]);
  });

  test("the five 20 at «Кокетливая»: 3 600 000 / 1 200 000 µ$, as they always were", () => {
    const estimate = runEstimate(PRICED, MODELS, request(["home", "travel", "shoot", "glam", "fit"], 20, "flirty"), "off", COVERED);
    expect([estimate.worstMicros, estimate.expectedMicros, "boldAttemptMicros" in estimate]).toEqual([3_600_000, 1_200_000, false]);
  });

  test("«Ночнушки и бельё» 10 + «Пляж и бассейн» 10: worst 5 580 000 µ$, expected 1 860 000 µ$", () => {
    const estimate = runEstimate(PRICED, MODELS, request(["nightwear", "beach"], 20), "off", COVERED);
    expect([estimate.worstMicros, estimate.expectedMicros]).toEqual([5_580_000, 1_860_000]);
  });

  test("with the age check on, every photo adds its three checks as it did before", () => {
    const off = runEstimate(PRICED, MODELS, request(["nightwear"], 10), "off", COVERED);
    const on = runEstimate(PRICED, MODELS, request(["nightwear"], 10), "on", COVERED);
    expect(on.worstMicros - off.worstMicros).toBe(10 * 3 * AGE_CEILING);
  });

  // 5a.4 (S5.BA5, 2026-10-26, BA3 review H-1): this row told the pre-5a.4 split (7 over [home, nightwear]: home's 4 on the owner's model, nightwear's 3 on the route); every photo of a
  // «Смелая» request is on the route now, whatever the split.
  test("every photo of an odd count is priced at the 2K attempt, whatever the split", () => {
    const estimate = runEstimate(PRICED, MODELS, request(["home", "nightwear"], 7), "off", COVERED);
    expect(estimate.worstMicros).toBe(7 * 3 * BOLD_ATTEMPT);
  });
});

describe("Estimate.boldAttemptMicros", () => {
  test("is the 2K attempt of the price book when the run has bold photos", () => {
    expect(runEstimate(PRICED, MODELS, request(["home", "beach"], 10), "off", COVERED).boldAttemptMicros).toBe(BOLD_ATTEMPT);
  });

  // 5a.4 (S5.BA5, 2026-10-26, BA3 review H-1): this row asked «Смелая» over «Дом» and «Виды», priced on the owner's model before 5a.4; the run with no photo on the route is «Кокетливая» now.
  test("is absent on a run below «Смелая»", () => {
    expect("boldAttemptMicros" in runEstimate(PRICED, MODELS, request(["home", "travel"], 10, "flirty"), "off", COVERED)).toBe(false);
    expect("boldAttemptMicros" in runEstimate(PRICED, MODELS, { count: 10, categories: ["home", "travel"], level: undefined }, "off", COVERED)).toBe(false);
  });

  test("is present on a run of the five at «Смелая»", () => {
    expect(runEstimate(PRICED, MODELS, request(["home", "travel"], 10), "off", COVERED).boldAttemptMicros).toBe(BOLD_ATTEMPT);
  });

  test("is absent on a run from scenes with no Seedream scene", () => {
    expect("boldAttemptMicros" in runEstimateFromScenes(PRICED, MODELS, { count: 10 }, "off")).toBe(false);
  });

  test("is present on a run from scenes when some scene is on the route", () => {
    expect(runEstimateFromScenes(PRICED, MODELS, { count: 10, boldPhotos: 3 }, "off").boldAttemptMicros).toBe(BOLD_ATTEMPT);
  });

  test("does not carry the age check", () => {
    expect(runEstimate(PRICED, MODELS, request(["nightwear"], 4), "on", COVERED).boldAttemptMicros).toBe(BOLD_ATTEMPT);
  });
});

describe("runEstimateFromScenes with bold scenes", () => {
  test("prices the scenes on the route at 2K and the rest at the route", () => {
    const estimate = runEstimateFromScenes(PRICED, MODELS, { count: 20, boldPhotos: 10 }, "off");
    expect([estimate.worstMicros, estimate.expectedMicros]).toEqual([4_590_000, 1_530_000]);
  });

  test("a count with no boldPhotos is the figure it always was", () => {
    expect(runEstimateFromScenes(PRICED, MODELS, { count: 20 }, "off").worstMicros).toBe(20 * 3 * GROK_QUALITY);
  });

  test("a scene removed from the route lowers the worst case by exactly its three 2K attempts", () => {
    const four = runEstimateFromScenes(PRICED, MODELS, { count: 4, boldPhotos: 4 }, "off");
    const three = runEstimateFromScenes(PRICED, MODELS, { count: 3, boldPhotos: 3 }, "off");
    expect(four.worstMicros - three.worstMicros).toBe(3 * BOLD_ATTEMPT);
  });

  test("never prices a bold launch's photo below a plain one", () => {
    for (const count of [1, 5, 25, 100]) {
      expect(runEstimateFromScenes(PRICED, MODELS, { count, boldPhotos: count }, "off").worstMicros).toBeGreaterThanOrEqual(runEstimateFromScenes(PRICED, MODELS, { count }, "off").worstMicros);
    }
  });
});

describe("the models a bold estimate needs priced", () => {
  test("a run with a bold photo asks for the 2K shape of the Seedream endpoint", () => {
    expect(runPriceModels(MODELS, "off", 1)).toMatchObject({ checkRequestShape: true, boldShape: true });
  });

  test("a run with no bold photo asks for what it always did", () => {
    expect(runPriceModels(MODELS, "off", 0)).toEqual(runPriceModels(MODELS, "off"));
    expect("boldShape" in runPriceModels(MODELS, "off")).toBe(false);
  });

  test("a run from scenes with a bold scene asks for the 2K shape and still no text model", () => {
    const models = sceneRunPriceModels(MODELS, "off", 2);
    expect([models.boldShape, models.chatModels]).toEqual([true, []]);
  });

  test("always lists the Seedream model, whatever the settings' model is", () => {
    expect(runPriceModels({ ...MODELS, imageModel: BOLD_IMAGE_MODEL }, "off", 1).imageModels).toEqual([BOLD_IMAGE_MODEL]);
    expect(runPriceModels(MODELS, "off", 1).imageModels).toContain(BOLD_IMAGE_MODEL);
  });
});

// 5a.4 (S5.BA5, plan s5a4 I5.77, §5.7 «a custom category, 20 photos», BA3 review M-1): at «Смелая» a custom category's slots are on the route and the template renders none of
// them, so the run's estimate carries the writer for them whatever the pool's coverage below «Смелая», at the bold writer call (writerCallOf("bold"): 48 750 µ$ an attempt, two
// attempts a chunk). A custom 20 is 5 580 000 µ$ of photos and one bold chunk, 97 500 µ$: «до $5.68».
describe("a custom category at «Смелая»", () => {
  const CUSTOM = "cat-covered-fixture" as const;
  const BOLD_CHUNK = 2 * 48_750;
  const boldExpected = (requests: number, scenes: number) => writerExpectedMicros(PRICED.book, { ...WRITER_BOLD_CALL, model: MODELS.textModel }, requests, scenes);

  test("a custom 20 the template covers below «Смелая»: worst 5 677 500 µ$, the photos and one bold chunk", () => {
    const estimate = runEstimate(PRICED, MODELS, request([CUSTOM], 20), "off", COVERED);
    expect([estimate.worstMicros, estimate.expectedMicros]).toEqual([20 * 3 * BOLD_ATTEMPT + BOLD_CHUNK, 20 * BOLD_ATTEMPT + boldExpected(1, 20)]);
    expect(estimate.worstMicros).toBe(5_677_500);
  });

  test("a custom 20 the template does not cover is priced the same: its writer is the bold one", () => {
    const uncovered = runEstimate(PRICED, MODELS, request([CUSTOM], 20), "off", () => false);
    expect(uncovered).toEqual(runEstimate(PRICED, MODELS, request([CUSTOM], 20), "off", COVERED));
  });

  test("100 photos of a custom category at «Смелая» carry four bold chunks", () => {
    expect(runEstimate(PRICED, MODELS, request([CUSTOM], 100), "off", COVERED).worstMicros).toBe(100 * 3 * BOLD_ATTEMPT + 4 * BOLD_CHUNK);
  });

  test("«Дом» 10 beside a custom 10 at «Смелая»: the custom block may touch two chunks", () => {
    expect(runEstimate(PRICED, MODELS, request(["home", CUSTOM], 20), "off", COVERED).worstMicros).toBe(20 * 3 * BOLD_ATTEMPT + 1 * BOLD_CHUNK);
    expect(runEstimate(PRICED, MODELS, request(["home", CUSTOM], 40), "off", COVERED).worstMicros).toBe(40 * 3 * BOLD_ATTEMPT + 2 * BOLD_CHUNK);
  });

  test("at «Кокетливая» the covered custom 20 asks no writer and the uncovered one the ordinary chunk, as before", () => {
    expect(runEstimate(PRICED, MODELS, request([CUSTOM], 20, "flirty"), "off", COVERED).worstMicros).toBe(20 * 3 * GROK_QUALITY);
    const uncovered = runEstimate(PRICED, MODELS, request([CUSTOM], 20, "flirty"), "off", () => false);
    expect([uncovered.worstMicros, uncovered.expectedMicros]).toEqual([20 * 3 * GROK_QUALITY + 2 * 37_500, 20 * GROK_QUALITY + writerExpectedMicros(PRICED.book, { ...WRITER_CALL, model: MODELS.textModel }, 1, 20)]);
  });
});
