import type { SceneLevel } from "../engine";
import type { Level } from "./banks/types";

/**
 * The level a request draws at (5a.3, S5.9a). «Смелая» is accepted everywhere a level is, but only the two «Смелая» categories (S5.9b2) have anything bolder than «Кокетливая»: the five
 * ordinary built-ins under `bold` draw exactly as `flirty`, byte for byte, so the contract never yields a half-built plan. The planner and the mock both draw at this level.
 */
export function drawLevelOf(level: SceneLevel | undefined): Level {
  return level === "flirty" || level === "bold" ? "flirty" : "ordinary";
}

/** 5a.3 (S5.9b2, I5.37): the order of the levels. An item of the banks is drawn on a slot of its own level or above, never below. */
const LEVEL_RANK: Readonly<Record<Level, number>> = { ordinary: 0, flirty: 1, bold: 2 };

/** Whether an item at `item` (absent: ordinary) may be drawn on a slot at `slot`. */
export function atOrBelow(item: Level | undefined, slot: Level): boolean {
  return LEVEL_RANK[item ?? "ordinary"] <= LEVEL_RANK[slot];
}

// 5a.2b (S5.7b, plan s5a2 I5.28): «Подача». Under «Кокетливая» exactly round(0.6 × n) of a built-in category's n slots are flirty; under «Обычная» none is. The one
// rule, for the planner and for the card's «{F} из {N} кадров» line (the mock reads it too). Integers only: 0.6 × n is 6n / 10, which never ends in .5, so there is no
// half-way case to round and no float to drift.

/** The share of a category's slots «Кокетливая» makes flirty, in tenths. */
export const FLIRTY_TENTHS = 6;

/** How many of a category's `slots` slots are flirty at this level. */
export function flirtyCountOf(slots: number, level: Level = "ordinary"): number {
  if (!Number.isInteger(slots) || slots < 0) throw new RangeError(`a slot count is a non-negative integer, got ${slots}`);
  return level === "flirty" ? Math.floor((FLIRTY_TENTHS * slots + 5) / 10) : 0;
}

// 5a.2c (S5.8a, plan s5a2 I5.29): «Ножки». The legs slots of a run are min(round-half-up(share × B), ⌊0.3 × count⌋): B is the run's built-in slots (a custom category draws no
// legs), count all its slots, share the chip in whole percent. Integers only, so the rounding is (share × B + 50) div 100 and the cap (3 × count) div 10. The one rule, for
// the planner and for the card's «{L} из {N} кадров» line.

/** The most of a run that may be legs slots, in tenths. */
export const LEGS_CAP_TENTHS = 3;

/** How many of a run's `total` slots, `builtIn` of them in a built-in category, are legs slots at this share (in percent). */
export function legsCountOf(share: 0 | 15 | 30, builtIn: number, total: number): number {
  if (share !== 0 && share !== 15 && share !== 30) throw new RangeError(`a legs share is 0, 15 or 30, got ${String(share)}`);
  if (!Number.isInteger(builtIn) || !Number.isInteger(total) || builtIn < 0 || total < builtIn) throw new RangeError(`the slot counts are integers with 0 <= built-in <= total, got ${builtIn} of ${total}`);
  const wanted = Math.floor((share * builtIn + 50) / 100);
  const cap = Math.floor((LEGS_CAP_TENTHS * total) / 10);
  return Math.min(wanted, cap);
}

/**
 * The `total` legs slots over the built-in categories, in proportion to each one's slots (largest remainder, in integers): every part is the floor or the ceiling of its
 * exact quota and no part is above its category's slots. The categories whose remainders are equal are served in `tieOrder` (a list of category indices, first first;
 * the order given by default), which is where the planner's `legs:` stream breaks the tie.
 */
export function apportionLegs(total: number, counts: readonly number[], tieOrder?: readonly number[]): number[] {
  const built = counts.reduce((sum, n) => sum + n, 0);
  if (!Number.isInteger(total) || total < 0 || total > built) throw new RangeError(`${total} legs slots do not fit ${built} built-in slots`);
  const parts = counts.map((n) => (built === 0 ? 0 : Math.floor((total * n) / built)));
  const remainder = counts.map((n) => (built === 0 ? 0 : (total * n) % built));
  const rank = new Map((tieOrder ?? counts.map((_, i) => i)).map((index, place) => [index, place] as const));
  const order = counts.map((_, i) => i).sort((a, b) => (remainder[b] ?? 0) - (remainder[a] ?? 0) || (rank.get(a) ?? a) - (rank.get(b) ?? b));
  let left = total - parts.reduce((sum, n) => sum + n, 0);
  for (const index of order) {
    if (left === 0) break;
    if ((remainder[index] ?? 0) === 0) continue;
    parts[index] = (parts[index] ?? 0) + 1;
    left--;
  }
  return parts;
}
