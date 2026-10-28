import { describe, expect, test } from "bun:test";
import { unitPricesOf } from "../../../engine/autopilot/prices";
import { PriceBook } from "../../../engine/money/prices";
import type { PricedBook } from "../../../engine/money/priceCache";
import { composeEstimate } from "../../../engine/sceneSets/estimate";
import { MICROS_PER_DOLLAR } from "../../../shared/engine/usd";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { formatUsdTiered } from "../../lib/money";
import { launchMonthLine, monthLine } from "./monthLine";
useNativeGlobals();

// 5a.4 (S5.BA8a, plan s5a4 §5.9 row 20, r2.3 M1, r2.2 D5): the month line under «Подача» at «Смелая». The photo's worst case is the launch math's own unit, `unitPricesOf(…, bold = true).photo`
// (three Seedream 2K attempts, plus the age check's call on each when it is on), never a figure of the UI's own. The fixtures read the engine; the expected strings are the plan's.

const MODELS = { imageModel: "x-ai/grok-imagine-image-quality", imageQuality: null, textModel: "x-ai/grok-4.3" } as const;
const PRICED: PricedBook = { book: PriceBook.fallback(), asOf: "2026-10-12" };
const photoUnit = (check: "off" | "on"): number => unitPricesOf(PRICED, MODELS, check, () => false, true).photoWorstMicros;
const BUDGET = 10 * MICROS_PER_DOLLAR;

describe("the month line (§5.9 row 20)", () => {
  test("with the age check off: «до $0.28», about 35 photos of a $10 month", () => {
    expect(monthLine({ unitMicros: photoUnit("off"), budgetMicros: BUDGET, ageCheck: false })).toBe(
      "Каждое фото «Смелой» — до $0.28 (3 попытки Seedream 2K по прайсу). Месячный бюджет $10 вмещает ≈ 35 таких фото; больше автопилот рисует частями, пока хватает остатка.",
    );
  });

  test("with the age check on: «до $0.30», about 33 photos, and the parenthesis names the age checks", () => {
    expect(monthLine({ unitMicros: photoUnit("on"), budgetMicros: BUDGET, ageCheck: true })).toBe(
      "Каждое фото «Смелой» — до $0.30 (3 попытки Seedream 2K и проверки возраста по прайсу). Месячный бюджет $10 вмещает ≈ 33 таких фото; больше автопилот рисует частями, пока хватает остатка.",
    );
  });

  test("reads the unit it is given: the same unit and budget give the same line whatever the check says about the words", () => {
    const unit = photoUnit("off");
    expect(monthLine({ unitMicros: unit, budgetMicros: BUDGET, ageCheck: false })).toContain(`до ${formatUsdTiered(unit, "up")} (`);
    expect(monthLine({ unitMicros: unit, budgetMicros: BUDGET, ageCheck: false })).toContain(`≈ ${Math.floor(BUDGET / unit)} таких фото`);
  });

  test("the count is the whole photos the budget holds: one micro-dollar under a whole photo is one photo fewer", () => {
    const unit = photoUnit("off");
    expect(monthLine({ unitMicros: unit, budgetMicros: 2 * unit, ageCheck: false })).toContain("≈ 2 таких фото");
    expect(monthLine({ unitMicros: unit, budgetMicros: 2 * unit - 1, ageCheck: false })).toContain("≈ 1 такое фото;");
  });

  // S5.BA8a review: the count agrees with its words — «≈ 1 такое фото» where n % 10 = 1 and n % 100 ≠ 11, «таких фото» everywhere else.
  test.each([
    [1, "≈ 1 такое фото;"],
    [21, "≈ 21 такое фото;"],
    [31, "≈ 31 такое фото;"],
    [101, "≈ 101 такое фото;"],
    [11, "≈ 11 таких фото;"],
    [111, "≈ 111 таких фото;"],
    [2, "≈ 2 таких фото;"],
    [4, "≈ 4 таких фото;"],
    [5, "≈ 5 таких фото;"],
    [12, "≈ 12 таких фото;"],
    [35, "≈ 35 таких фото;"],
  ] as const)("%i photos: «%s»", (photos, words) => {
    // Any unit will do: the words follow the count alone (a round one, not the bold unit, which no renderer module may hold).
    expect(monthLine({ unitMicros: 100_000, budgetMicros: photos * 100_000, ageCheck: false })).toContain(words);
  });

  test("a budget that holds no whole photo claims no count", () => {
    const line = monthLine({ unitMicros: photoUnit("off"), budgetMicros: 100_000, ageCheck: false });
    expect(line).toBe("Каждое фото «Смелой» — до $0.28 (3 попытки Seedream 2K по прайсу). Месячный бюджет $0.10 не вмещает ни одного такого фото.");
  });

  // S5.BA8a review: a unit the line cannot divide by (zero — the contract allows it —, or anything not a positive whole number of micro-dollars) says nothing rather than throw:
  // a throw here took «Автопилот» down.
  test("a unit that is not a positive whole number of micro-dollars gives no line, never a throw", () => {
    for (const unitMicros of [0, -1, 0.5, Number.NaN]) expect(monthLine({ unitMicros, budgetMicros: BUDGET, ageCheck: false })).toBe(null);
  });
});

describe("the figures the screens say with the app's rounding (r2.2 D5)", () => {
  test("the age check adds its call to the unit: 3 attempts at $0.093 and at $0.098", () => {
    expect([photoUnit("off"), photoUnit("on")]).toEqual([3 * 93_000, 3 * 98_250]);
  });

  test("a bold writer chunk or redraw reads «до $0.098»", () => {
    const chunk = composeEstimate(PRICED, MODELS.textModel, [{ ref: "cat-0123456789ab", count: 1 }], () => false, "bold").worstMicros;
    expect(formatUsdTiered(chunk, "up")).toBe("$0.098");
  });
});

// 5a.4 (S5.BA8a): the screen's line is the preview's own unit and budget; with no unit (the plan draws no new photo, or an older engine) there is no line, and the window computes none.
describe("launchMonthLine: the line a plan shows", () => {
  const plan = { unitPhotoWorstMicros: photoUnit("off"), month: { budgetMicros: BUDGET } };

  test("at «Смелая» with a unit: the month line over the preview's unit and budget", () => {
    expect(launchMonthLine("bold", plan, false)).toBe(monthLine({ unitMicros: photoUnit("off"), budgetMicros: BUDGET, ageCheck: false }));
  });

  test("says the age checks when the age check is on", () => {
    expect(launchMonthLine("bold", { ...plan, unitPhotoWorstMicros: photoUnit("on") }, true)).toContain("проверки возраста");
  });

  test.each(["ordinary", "flirty"] as const)("at %s: none", (level) => {
    expect(launchMonthLine(level, plan, false)).toBe(null);
  });

  test("with no plan, or a plan without a unit: none", () => {
    expect(launchMonthLine("bold", null, false)).toBe(null);
    expect(launchMonthLine("bold", { month: { budgetMicros: BUDGET } }, false)).toBe(null);
  });

  test("a plan whose unit is 0: none, and no throw", () => {
    expect(launchMonthLine("bold", { ...plan, unitPhotoWorstMicros: 0 }, false)).toBe(null);
  });
});
