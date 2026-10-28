import type { SceneLevel } from "../../../shared/engine";
import { formatUsdTiered } from "../../lib/money";
import { wholeUsd } from "./planModel";

// 5a.4 (S5.BA8a, plan s5a4 §5.9 row 20, r2.3 M1, r2.2 D5): the month line under «Подача» at «Смелая». The figure is the launch math's own photo unit, never one of the UI's: the photo's worst
// case at the Seedream 2K unit (`unitPricesOf(…, bold = true).photoWorstMicros`), which includes the age check's call on each attempt when it is on.

/** The inputs of the month line: the unit and the budget in micro-dollars, and whether the age check is on (it changes the parenthesis, and is already in the unit). */
export interface MonthLineInput {
  readonly unitMicros: number;
  readonly budgetMicros: number;
  readonly ageCheck: boolean;
}

/**
 * «Каждое фото «Смелой» — до {X} (3 попытки Seedream 2K по прайсу). Месячный бюджет ${budget} вмещает ≈ {k} таких фото; больше автопилот рисует частями, пока хватает остатка.»
 * X = the unit rounded up (the app's `до`), k = ⌊budget / unit⌋. A budget that holds no whole photo claims no count.
 */
export function monthLine({ unitMicros, budgetMicros, ageCheck }: MonthLineInput): string {
  if (!Number.isInteger(unitMicros) || unitMicros <= 0) throw new RangeError(`a photo's unit is a positive whole number of micro-dollars, got ${unitMicros}`);
  const photos = Math.floor(budgetMicros / unitMicros);
  const how = ageCheck ? "3 попытки Seedream 2K и проверки возраста по прайсу" : "3 попытки Seedream 2K по прайсу";
  const first = `Каждое фото «Смелой» — до ${formatUsdTiered(unitMicros, "up")} (${how}).`;
  const budget = wholeUsd(budgetMicros);
  return photos === 0
    ? `${first} Месячный бюджет ${budget} не вмещает ни одного такого фото.`
    : `${first} Месячный бюджет ${budget} вмещает ≈ ${photos} таких фото; больше автопилот рисует частями, пока хватает остатка.`;
}

/** The line a launch plan shows under «Подача»: at «Смелая» only, from the plan's own unit and budget; none when the plan names no unit (it draws no new photo). */
export function launchMonthLine(level: SceneLevel, plan: { readonly unitPhotoWorstMicros?: number; readonly month: { readonly budgetMicros: number } } | null, ageCheck: boolean): string | null {
  if (level !== "bold" || plan === null || plan.unitPhotoWorstMicros === undefined) return null;
  return monthLine({ unitMicros: plan.unitPhotoWorstMicros, budgetMicros: plan.month.budgetMicros, ageCheck });
}
