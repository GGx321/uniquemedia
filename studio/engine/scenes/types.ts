// Shared enums for the scene planner (T5a) and its schema, kept in their own
// module so pools.ts (the data) and schema.ts (the zod contract) can both
// import them without a circular dependency.

import type { CustomCategoryId } from "../../shared/engine";

/** Product decision, fixed: Home, Travel, Photoshoot, Glamour (the going-out
 *  outfits category, non-revealing in Stage 2), Fitness; then (5a.3, S5.9b2) the two «Смелая» categories, «Ночнушки и бельё» and «Пляж и бассейн», named as
 *  their contract ids. Order here is canonical: a plan always emits its slots grouped by category in this order (planner.ts, "plan order"). */
export const CATEGORIES = ["home", "travel", "photoshoot", "glamour", "fitness", "nightwear", "beach"] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * 5a.3 (S5.9b2, plan s5a3 §6.4 r3): the five ordinary built-ins, by name, beside `CATEGORIES`, which the two «Смелая» categories join. The sweeps that hold a
 * plan to the ordinary and flirty word lists and the owner's rules run over these five; the «Смелая» banks have sweeps of their own.
 */
export const ORDINARY_BUILT_INS = ["home", "travel", "photoshoot", "glamour", "fitness"] as const satisfies readonly Category[];
export type OrdinaryBuiltIn = (typeof ORDINARY_BUILT_INS)[number];

/** What a plan slot names as its category: one of the five built-ins (by the engine's own names), or a custom category's id. */
export type PlannerCategory = Category | CustomCategoryId;

/** Who/what took the photo. Photoshoot draws only "photographer" and "candid"
 *  (its own deck, pools.ts); every other category draws from the default deck. */
export const SHOTS = ["friend", "selfie", "mirror", "candid", "photographer"] as const;
export type Shot = (typeof SHOTS)[number];
