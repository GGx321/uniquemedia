import { describe, expect, test } from "bun:test";
import { launchEstimate, MAX_GENERATED_PER_AVATAR } from "../../shared/autopilot/estimate";
import type { CoversOf, SplitEntry } from "../../shared/scenes/writerBound";
import type { PricedBook } from "../money/priceCache";
import { PriceBook } from "../money/prices";
import { composeEstimate } from "../sceneSets/estimate";
import { isBoldLook, runEstimateFromScenes } from "../runs/plan";
import { launchPriceModels, unitPricesOf } from "./prices";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, plan s5a3 §10.2, option B): a launch whose draft is «Смелая» with a «Смелая» category prices EVERY photo at the bold unit, so the launch math (A1–A21)
// stays untouched and only reads a different unit. A18 for such a launch: launchEstimate(n) = composeEstimate(n) + runEstimateFromScenes(n, boldPhotos = n).

const MODELS = { imageModel: "x-ai/grok-imagine-image-quality", imageQuality: null, textModel: "x-ai/grok-4.3" } as const;
const PRICED: PricedBook = { book: PriceBook.fallback(), asOf: "2026-10-12" };
const COVERED: CoversOf = () => true;
const GROK_UNIT = 3 * 60_000;
const BOLD_UNIT = 3 * 93_000;

describe("isBoldLook", () => {
  test("is true for «Смелая» with a «Смелая» category", () => {
    expect(isBoldLook({ level: "bold", categories: ["home", "nightwear"] })).toBe(true);
  });

  test("is true for «Смелая» with only a «Смелая» category", () => {
    expect(isBoldLook({ level: "bold", categories: ["beach"] })).toBe(true);
  });

  test("is false for «Смелая» with only the five: they draw as «Кокетливая» on the owner's model", () => {
    expect(isBoldLook({ level: "bold", categories: ["home", "travel", "glam"] })).toBe(false);
  });

  test("is false at any other level, whatever the categories", () => {
    expect([undefined, "ordinary", "flirty"].map((level) => isBoldLook({ level: level as "flirty" | undefined, categories: ["nightwear"] }))).toEqual([false, false, false]);
  });

  test("is false for a custom category beside the five", () => {
    expect(isBoldLook({ level: "bold", categories: ["home", "cat-0123456789ab"] })).toBe(false);
  });
});

describe("launchPriceModels", () => {
  test("for a bold launch asks for the 2K shape of the Seedream endpoint", () => {
    expect(launchPriceModels(MODELS, "off", true)).toMatchObject({ checkRequestShape: true, boldShape: true });
  });

  test("for any other launch is what it always was", () => {
    expect("boldShape" in launchPriceModels(MODELS, "off", false)).toBe(false);
    expect("boldShape" in launchPriceModels(MODELS, "off")).toBe(false);
  });
});

describe("unitPricesOf for a bold launch", () => {
  test("prices a photo's worst case at three 2K attempts and its expected cost at one", () => {
    const unit = unitPricesOf(PRICED, MODELS, "off", COVERED, true);
    expect([unit.photoWorstMicros, unit.photoExpectedMicros]).toEqual([BOLD_UNIT, 93_000]);
  });

  test("for a launch that is not bold is the unit it always was", () => {
    const unit = unitPricesOf(PRICED, MODELS, "off", COVERED);
    expect([unit.photoWorstMicros, unit.photoExpectedMicros]).toEqual([GROK_UNIT, 60_000]);
    expect(unitPricesOf(PRICED, MODELS, "off", COVERED, false)).toEqual(unit);
  });

  test("changes nothing but the photo's two prices", () => {
    const { photoWorstMicros: _w, photoExpectedMicros: _e, ...bold } = unitPricesOf(PRICED, MODELS, "off", COVERED, true);
    const { photoWorstMicros: _w2, photoExpectedMicros: _e2, ...plain } = unitPricesOf(PRICED, MODELS, "off", COVERED);
    expect(bold).toEqual(plain);
  });

  test("a mixed 10 + 10 launch over-reserves only the ordinary photo, by 10 × 3 × (93 000 − 60 000) = +$0.99 worst", () => {
    const bold = launchEstimate([{ avatarId: "a", photos: 20, split: [{ ref: "home", count: 10 }, { ref: "nightwear", count: 10 }] }], unitPricesOf(PRICED, MODELS, "off", COVERED, true));
    const exact = runEstimateFromScenes(PRICED, MODELS, { count: 20, boldPhotos: 10 }, "off");
    expect(bold.worstMicros - exact.worstMicros).toBe(10 * 3 * (93_000 - 60_000));
  });

  test("a mixed 10 + 10 launch expects +$0.33 at list", () => {
    const bold = launchEstimate([{ avatarId: "a", photos: 20, split: [{ ref: "home", count: 10 }, { ref: "nightwear", count: 10 }] }], unitPricesOf(PRICED, MODELS, "off", COVERED, true));
    const exact = runEstimateFromScenes(PRICED, MODELS, { count: 20, boldPhotos: 10 }, "off");
    expect(bold.expectedMicros - exact.expectedMicros).toBe(10 * (93_000 - 60_000));
  });
});

describe("A18 for a bold launch", () => {
  const SPLITS: [string, (n: number) => SplitEntry[]][] = [
    ["a single bold category", (n) => [{ ref: "nightwear", count: n }]],
    ["two bold categories", (n) => [{ ref: "nightwear", count: Math.ceil(n / 2) }, { ref: "beach", count: Math.floor(n / 2) }]],
    ["a built-in beside a bold one", (n) => [{ ref: "home", count: Math.ceil(n / 2) }, { ref: "nightwear", count: Math.floor(n / 2) }]],
  ];
  for (const ageCheck of ["off", "on"] as const) {
    for (const [name, split] of SPLITS) {
      test(`launchEstimate(n) = composeEstimate(n) + runEstimateFromScenes(n, boldPhotos = n), ${name}, age check ${ageCheck}, n = 1..100`, () => {
        const unit = unitPricesOf(PRICED, MODELS, ageCheck, COVERED, true);
        for (let n = 1; n <= MAX_GENERATED_PER_AVATAR; n++) {
          const entries = split(n).filter((entry) => entry.count > 0);
          const launch = launchEstimate([{ avatarId: "a", photos: n, split: entries }], unit);
          const compose = composeEstimate(PRICED, MODELS.textModel, entries, COVERED);
          const draw = runEstimateFromScenes(PRICED, MODELS, { count: n, boldPhotos: n }, ageCheck);
          expect({ n, worst: launch.worstMicros, expected: launch.expectedMicros }).toEqual({ n, worst: compose.worstMicros + draw.worstMicros, expected: compose.expectedMicros + draw.expectedMicros });
        }
      });
    }
  }

  test("a launch that is not bold keeps A18 against the plain draw", () => {
    const unit = unitPricesOf(PRICED, MODELS, "off", COVERED);
    for (const n of [1, 7, 100]) {
      const launch = launchEstimate([{ avatarId: "a", photos: n, split: [{ ref: "home", count: n }] }], unit);
      expect(launch.worstMicros).toBe(runEstimateFromScenes(PRICED, MODELS, { count: n }, "off").worstMicros);
    }
  });
});
