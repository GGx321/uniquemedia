import { isCustomCategory, OWN_CATEGORY, type PhotoCategory, type CategoryRef, type CategorySnapshot, type CategoryStyle, type SceneCategory } from "../../shared/engine";
import type { Category, PlannerCategory } from "./types";

// CS.1: the engine's two names for a category, and what a plan's snapshot
// says about the custom ones. The five built-ins keep the engine's own names
// ("photoshoot", "glamour", "fitness") inside the planner and the contract's
// short ones ("shoot", "glam", "fit") on the wire; a custom category's id is
// the same on both sides.

/** The contract's short names for the planner's categories (the Photos mockup's own labels). */
const PLANNER_OF_REF = {
  home: "home",
  travel: "travel",
  shoot: "photoshoot",
  glam: "glamour",
  fit: "fitness",
} as const satisfies Record<SceneCategory, Category>;

/** The inverse of PLANNER_OF_REF; plan.test.ts pins that the two round-trip. */
const REF_OF_PLANNER = {
  home: "home",
  travel: "travel",
  photoshoot: "shoot",
  glamour: "glam",
  fitness: "fit",
} as const satisfies Record<Category, SceneCategory>;

/** The planner's name for a contract category; a custom id stays what it is. */
export function plannerCategoryOf(ref: CategoryRef): PlannerCategory {
  return isCustomCategory(ref) ? ref : PLANNER_OF_REF[ref];
}

/** The contract's name for a planner category; a custom id stays what it is. */
export function categoryRefOf(category: PlannerCategory): CategoryRef {
  return isCustomCategory(category) ? category : REF_OF_PLANNER[category];
}

/** What a photo carries as its category: the contract's name for a slot's category, or `"own"` for an own scene (CS.5). */
export function photoCategoryOf(category: PlannerCategory | "own"): PhotoCategory {
  return category === "own" ? OWN_CATEGORY : categoryRefOf(category);
}

/** The English name the writer is told each built-in category is. Byte-pinned: a built-in run's prompt never changes. */
export const BUILT_IN_LABEL: Record<Category, string> = {
  home: "Home",
  travel: "Travel",
  photoshoot: "Own phone photos",
  glamour: "Glamour",
  fitness: "Fitness",
};

/** What the writer is told a slot's category is. */
export type CategoryLabelOf = (category: PlannerCategory) => string;

function snapshotOf(snapshots: readonly CategorySnapshot[], category: PlannerCategory): CategorySnapshot {
  const found = snapshots.find((s) => s.ref === category);
  if (found === undefined) throw new RangeError(`the plan has no snapshot of custom category ${category}`);
  return found;
}

/**
 * The label resolver of a plan: a built-in's fixed English name, or a custom
 * category's own `label` from the plan's snapshot (never from the category
 * library, which may have changed since). A custom category the snapshot
 * lacks is a bug in the plan and throws.
 */
export function categoryLabelOf(snapshots: readonly CategorySnapshot[] = []): CategoryLabelOf {
  return (category) => (isCustomCategory(category) ? snapshotOf(snapshots, category).label : BUILT_IN_LABEL[category]);
}

/**
 * How a slot's photo is finished: the photoshoot is editorial, the other
 * built-ins are phone photos, and a custom category carries its own style in
 * the plan's snapshot.
 */
export function categoryStyleOf(category: PlannerCategory | "own", snapshots: readonly CategorySnapshot[] = []): CategoryStyle {
  // An own scene (CS.5) has no category of its own to carry a style: it is finished like a phone photo.
  if (category === "own") return "phone";
  if (isCustomCategory(category)) return snapshotOf(snapshots, category).style;
  return category === "photoshoot" ? "editorial" : "phone";
}
