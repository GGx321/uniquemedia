import { isCustomCategory, splitCount, type CategoryRef, type LegsShare } from "../../../shared/engine";
import { legsCountOf } from "../../../shared/scenes/level";
import { countOf, NBSP } from "../../lib/format";

// S5.8b (plan s5a2 §7, I5.29; mockups 33 and 34): «Ножки» on the window's side — legs and feet filling the frame, drawn from the five built-in categories only.
// The card and «Автопилот» share the words below. The share is the owner's pick and stays in the form while a category list without a built-in shows
// «Нет» (the engine would refuse it, `legs-built-in-only`); a built-in back brings the pick back (README «S5.2», «Интерактив»).

/** The three chips: «Нет · Немного 15 % · Много 30 %». */
export const LEGS_OPTIONS = [
  { value: 0, label: "Нет", share: null },
  { value: 15, label: "Немного", share: `15${NBSP}%` },
  { value: 30, label: "Много", share: `30${NBSP}%` },
] as const satisfies readonly { value: LegsShare; label: string; share: string | null }[];

/** Why the chips are off with no built-in category on (mockup 34#card, 34). */
export const LEGS_BUILT_IN_ONLY = "Ножки — только во встроенных категориях";

/** What «Ножки» means, after the count of such frames (mockup 33). */
const LEGS_WHAT = "ножки и стопы крупно; лицо может не попасть в кадр, сходство на таких кадрах только отмечается.";

/** Whether `categories` hold a built-in one, the only kind «Ножки» draws from. */
export function hasBuiltIn(categories: readonly CategoryRef[]): boolean {
  return categories.some((ref) => !isCustomCategory(ref));
}

/**
 * How many of `count` photos over `categories` are legs frames at `share`: the planner's own rule, `legsCountOf` (I5.29), over the built-in photos of the
 * planner's own split (`splitCount`).
 */
export function legsFrames(share: LegsShare, count: number, categories: readonly CategoryRef[]): number {
  if (count === 0 || categories.length === 0) return 0;
  const builtIn = splitCount(count, categories).reduce((sum, { ref, count: n }) => sum + (isCustomCategory(ref) ? 0 : n), 0);
  return legsCountOf(share, builtIn, count);
}

/** «3 из 20 кадров — ножки и стопы крупно; …» (mockup 33). */
export function legsCaption(legs: number, count: number): string {
  return `${legs} из ${countOf(count, ["кадра", "кадров", "кадров"])} — ${LEGS_WHAT}`;
}

/** A row's caption: what the pick draws, or (`why`) why the chips are off. */
export interface LegsLine {
  readonly text: string;
  readonly why: boolean;
}

/**
 * The card's caption (mockups 33, 34#card): with no built-in category on, why the chips are off; with «Нет», or nothing to draw (an empty set), none; else
 * how many of the frames are legs.
 */
export function cardLegsLine(share: LegsShare, count: number, categories: readonly CategoryRef[]): LegsLine | null {
  if (!hasBuiltIn(categories)) return { text: LEGS_BUILT_IN_ONLY, why: true };
  if (share === 0 || count === 0) return null;
  return { text: legsCaption(legsFrames(share, count, categories), count), why: false };
}
