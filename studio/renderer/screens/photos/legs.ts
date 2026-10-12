import { isCustomCategory, splitCount, type CategoryRef, type LegsShare } from "../../../shared/engine";
import { LEGS_CAP_TENTHS, legsCountOf } from "../../../shared/scenes/level";
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

/** The custom category's sheet, under its angles (mockup 35). */
export const LEGS_CUSTOM_NOTE = "«Ножки» в своих категориях не рисуются.";

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

// ---------- «Автопилот» ----------

/** The fewest new photos of an avatar that can hold a legs frame: the cap ⌊0.3 × count⌋ is 0 below it (I5.29). */
export const LEGS_MIN_PHOTOS = Math.ceil(10 / LEGS_CAP_TENTHS);

/** Why the chips are off when no avatar of the plan draws enough new photos (mockup 34#few). */
export const LEGS_FEW = `Ножки — от ${LEGS_MIN_PHOTOS} фото`;

/** «Автопилот»'s row caption, lower-case like every caption of that column (mockup 34). */
export const LEGS_ROW_HINT = "только во встроенных категориях";

/** What `launchLegsRow` reads of a launch's plan (`LaunchPreview`). */
interface LaunchPlanCounts {
  readonly avatars: readonly { readonly toGenerate: number; readonly blocked: unknown }[];
  readonly totals: { readonly toGenerate: number };
}

/** «Автопилот»'s «Ножки» row: the chip that reads on, whether the chips are off, and the caption. */
export interface LegsRow {
  readonly shown: LegsShare;
  readonly off: boolean;
  readonly caption: LegsLine | null;
}

/**
 * «Автопилот»'s «Ножки» row (mockups 34, 34#few). With no built-in category on, the chips are off on «Нет» and say why. When no avatar of the plan draws
 * `LEGS_MIN_PHOTOS` new photos, they are off on the pick, which is kept: it just draws nothing this time. Else a pick says «≈ {L} из {M} новых кадров — …»:
 * each avatar composes its own new photos, so L sums `legsFrames` per avatar that is not blocked (the plan's totals leave those out); «≈», as the engine splits
 * an avatar's photos by its own seeded order. With no plan yet, or nothing new to draw, what the frames are, without a count.
 */
export function launchLegsRow(share: LegsShare, plan: LaunchPlanCounts | null, categories: readonly CategoryRef[]): LegsRow {
  if (!hasBuiltIn(categories)) return { shown: 0, off: true, caption: { text: LEGS_BUILT_IN_ONLY, why: true } };
  const drawing = plan === null ? [] : plan.avatars.filter((avatar) => avatar.blocked === null && avatar.toGenerate > 0);
  if (plan !== null && plan.totals.toGenerate > 0 && drawing.every((avatar) => avatar.toGenerate < LEGS_MIN_PHOTOS)) return { shown: share, off: true, caption: { text: LEGS_FEW, why: true } };
  if (share === 0) return { shown: 0, off: false, caption: null };
  if (plan === null || plan.totals.toGenerate === 0) return { shown: share, off: false, caption: { text: `${LEGS_WHAT.charAt(0).toUpperCase()}${LEGS_WHAT.slice(1)}`, why: false } };
  const legs = drawing.reduce((sum, avatar) => sum + legsFrames(share, avatar.toGenerate, categories), 0);
  return {
    shown: share,
    off: false,
    caption: { text: `≈ ${legs} из ${countOf(plan.totals.toGenerate, ["нового кадра", "новых кадров", "новых кадров"])} — ${LEGS_WHAT}`, why: false },
  };
}
