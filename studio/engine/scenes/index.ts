// Public surface of the scene planner (T5a). T6 (the job queue) is the
// intended consumer: it calls `plan()`, persists the result as the run's
// plan.json (Library.createRun) and turns each slot's `attemptIdBase` into
// real ledger attempt ids.
export { CATEGORIES, SHOTS, type Category, type Shot } from "./types";
export { POOLS, PoolSchema, validatePools, type Activity, type Place, type Pool } from "./pools";
export { AttemptIdBaseSchema, CategorySchema, PlanSlotSchema, ScenePlanSchema, ShotSchema, type PlanSlot, type ScenePlan } from "./schema";
export { plan, placeMirrorShots, type ExcludedPair, type PlanInput } from "./planner";
