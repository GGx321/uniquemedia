import type { SceneLevel } from "../engine";
import type { LegwearSlot, Level } from "./banks/types";

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

/**
 * 5a.3 (S5.9c, plan s5a3 §7.2): the items a slot at `slot` draws from. Never one above its level (a hard filter); among the rest the slot's own level is preferred, so it takes the
 * items of the highest level at or below its own that has any. A list with no level on any item (the five ordinary banks') comes back whole and in its order, which is what keeps
 * their plans byte for byte what they were.
 */
export function atSlotLevel<T>(items: readonly T[], levelOf: (item: T) => Level | undefined, slot: Level): readonly T[] {
  for (let rank = LEVEL_RANK[slot]; rank >= 0; rank--) {
    const here = items.filter((item) => LEVEL_RANK[levelOf(item) ?? "ordinary"] === rank);
    if (here.length > 0) return here;
  }
  return [];
}

/** The legwear a slot of one level draws from: the items, the share of the slots that wear any, and (the «Смелая» stockings) the outfits they go with and their route. */
export interface LegwearAt {
  items: readonly string[];
  share: number;
  /** Absent: any outfit that shows her legs. Present (the bold stockings): only these. */
  outfits?: readonly string[];
  route?: "seedream";
}

/**
 * 5a.3 (S5.9c, plan s5a3 §7.3, M3): the legwear list of a slot's level. A bold slot of a bank that has bold stockings reads that list (its outfits, its share, its route); every
 * other slot reads the bank's own list, so stockings are drawn on bold slots only, and a bank without bold stockings reads as it always did.
 */
export function legwearAt(legwear: LegwearSlot | undefined, level: Level): LegwearAt | undefined {
  if (legwear === undefined) return undefined;
  if (level === "bold" && legwear.bold !== undefined) return { items: legwear.bold.items, share: legwear.bold.share, outfits: legwear.bold.outfits, route: legwear.bold.route };
  return { items: legwear.items, share: legwear.share };
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

/** How a «Смелая» category's slots divide over the three levels. */
export interface LevelCounts {
  ordinary: number;
  flirty: number;
  bold: number;
}

/**
 * 5a.3 (S5.9c, plan s5a3 I5.36): the mix inside a «Смелая» category, 20 / 40 / 40 (ordinary / flirty / bold) of its `slots` slots. Bold is ⌊(4n + 5) / 10⌋ and the non-ordinary
 * slots ⌊(8n + 5) / 10⌋, so each share is rounded half up in integers (no float to drift) and the three counts always add up to n. The one rule, for the planner, the mock and the
 * card's caption.
 */
export function levelCountsOf(slots: number): LevelCounts {
  if (!Number.isInteger(slots) || slots < 0) throw new RangeError(`a slot count is a non-negative integer, got ${slots}`);
  const bold = Math.floor((4 * slots + 5) / 10);
  const notOrdinary = Math.floor((8 * slots + 5) / 10);
  return { ordinary: slots - notOrdinary, flirty: notOrdinary - bold, bold };
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

/**
 * 5a.3 (S5.9c, I5.38): whether a slot is drawn on Seedream. It is exactly when one of the items it drew is: the moment, the outfit or the bold stockings (their route is passed in only
 * when the slot wears them). Absent: the owner's image model.
 */
export function seedreamRoute(moment: { route?: "seedream" | undefined }, outfit: { route?: "seedream" | undefined } | undefined, stockings?: "seedream" | undefined): "seedream" | undefined {
  return moment.route === "seedream" || outfit?.route === "seedream" || stockings === "seedream" ? "seedream" : undefined;
}
