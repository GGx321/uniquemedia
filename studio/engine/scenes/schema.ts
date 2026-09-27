import { z } from "zod";
import { CATEGORIES, SHOTS } from "./types";

// The plan's on-disk/on-wire contract (T5a, item 4, invariant 6). Kept
// engine-internal for now: T6 (the job queue) is the only planned consumer,
// persisting it as the run's plan.json (studio/engine/library/library.ts's
// createRun) and reading it back unchanged on resume ("resume uses the plan
// and never re-plans"). It is not added to studio/shared/engine because
// nothing there needs it through the contract yet — T8b's review table can be
// served by a dedicated command/event once T6 exists, the same way other
// engine-only shapes are surfaced today. Revisit if T6 or T8b's review needs
// this exact shape on the wire.

const NonEmpty = z.string().min(1);

export const CategorySchema = z.enum(CATEGORIES);
export const ShotSchema = z.enum(SHOTS);

/**
 * `slot-<slotIndex>`. T6 turns this into the ledger's real, globally-unique
 * attempt ids: `${runId}:${attemptIdBase}#${attempt}`, attempt 1..3
 * (MAX_ATTEMPTS_PER_SLOT, studio/engine/money/estimate.ts) — invariant 7. The
 * plan only pre-allocates the base, so a resume after a crash reads the same
 * plan.json and reuses the same bases instead of re-planning (invariant 6).
 */
export const AttemptIdBaseSchema = z.string().regex(/^slot-[1-9][0-9]*$/, "must be slot-<positive integer>");

/** One slot of the plan, in the order T6's queue will send it (invariant 6).
 *  Carries everything T5b's writer and assembler need: category, location,
 *  time, activity, outfit, shot type, the attempt id base and the slot's
 *  position in the plan. `repeatedPair` makes the soft exclusion visible:
 *  true only when `excludePairs` named this slot's (location, outfit) and
 *  every alternative outfit for that location was also excluded, so the
 *  planner had to keep a pair it was asked to avoid (T6/T8b can surface this,
 *  e.g. in the review table); false whenever there was nothing to avoid or
 *  avoidance succeeded. */
export const PlanSlotSchema = z.strictObject({
  slotIndex: z.int().positive(),
  category: CategorySchema,
  location: NonEmpty,
  timeOfDay: NonEmpty,
  activity: NonEmpty,
  outfit: NonEmpty,
  shot: ShotSchema,
  attemptIdBase: AttemptIdBaseSchema,
  repeatedPair: z.boolean(),
});
export type PlanSlot = z.infer<typeof PlanSlotSchema>;

/** The whole plan: a stable, serialisable value T6 can persist for resume and
 *  T8b can show as a review table (T5a, item 4). `slots` is already in send
 *  order — no separate ordering field. */
export const ScenePlanSchema = z.strictObject({
  version: z.literal(1),
  seed: z.int(),
  slots: z.array(PlanSlotSchema),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;
