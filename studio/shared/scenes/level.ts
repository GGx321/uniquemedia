import type { Level } from "./banks/types";

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
