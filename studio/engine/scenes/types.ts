// Shared enums for the scene planner (T5a) and its schema, kept in their own
// module so pools.ts (the data) and schema.ts (the zod contract) can both
// import them without a circular dependency.

/** Product decision, fixed: Home, Travel, Photoshoot, Glamour (18+, non-revealing
 *  in Stage 2), Fitness. Order here is canonical: a plan always emits its
 *  slots grouped by category in this order (planner.ts, "plan order"). */
export const CATEGORIES = ["home", "travel", "photoshoot", "glamour", "fitness"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Who/what took the photo. Photoshoot draws only "photographer" and "candid"
 *  (its own deck, pools.ts); every other category draws from the default deck. */
export const SHOTS = ["friend", "selfie", "mirror", "candid", "photographer"] as const;
export type Shot = (typeof SHOTS)[number];
