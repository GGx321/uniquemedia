import { z } from "zod";
import { CustomCategoryId, isCustomCategory, PoolText, SceneText, TimeOfDay } from "../../shared/engine";
import { FacePoseSchema } from "../face/config";
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
/** A slot's category: one of the five built-ins, or a custom category's id (`cat-…`). */
export const PlannerCategorySchema = z.union([CategorySchema, CustomCategoryId]);
export const ShotSchema = z.enum(SHOTS);

/**
 * T5c: the same pose vocabulary the face gate's policy already takes
 * (studio/engine/face/config.ts's `FacePoseSchema` — front/three-quarter get
 * a full identity check, profile is skipped, back is skipped unless a
 * confident face turns up). Re-exported here rather than redeclared, so the
 * planner's own `pose` value and the face gate's `pose` input can never
 * drift into two different enums.
 */
export const PoseSchema = FacePoseSchema;
export type Pose = z.infer<typeof PoseSchema>;

/** A selfie/mirror shot always holds the phone in one hand, so her face is
 *  always toward the camera: profile and back are never valid poses there
 *  (owner decision, 2026-09-27). Shared by PlanSlotSchema's own refine below
 *  and by the planner/writer/assembler, so the rule lives in exactly one
 *  place. */
export function isPhoneInHandShot(shot: (typeof SHOTS)[number]): boolean {
  return shot === "selfie" || shot === "mirror";
}

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
export const PlanSlotSchema = z
  .strictObject({
    // Only positive here: that it is also at most the run's count, and unique, is the run plan's own check (runs/plan.ts RunPlanSchema).
    slotIndex: z.int().positive(),
    category: PlannerCategorySchema,
    location: NonEmpty,
    timeOfDay: NonEmpty,
    activity: NonEmpty,
    outfit: NonEmpty,
    shot: ShotSchema,
    pose: PoseSchema,
    attemptIdBase: AttemptIdBaseSchema,
    repeatedPair: z.boolean(),
    // Additive (CS.5): the sentence a reviewed scene set already holds for this slot. Present on every slot of a run made from a set, never otherwise
    // (runs/plan.ts's invariant); a writer's sentence has no upper bound, so neither has this.
    sentence: SceneText.optional(),
  })
  .refine((slot) => !isPhoneInHandShot(slot.shot) || slot.pose === "front" || slot.pose === "three-quarter", {
    message: "a selfie or mirror shot always faces the camera: pose must be front or three-quarter",
    path: ["pose"],
  })
  // A plan.json is read back on every resume: a custom slot's texts are held to the bounds a custom pool is, so a hand-edited
  // file cannot grow the writer's prompt past the ceiling its reserve was priced at. Built-in slots are not held to them.
  .superRefine((slot, ctx) => {
    if (!isCustomCategory(slot.category)) return;
    for (const field of ["location", "activity", "outfit"] as const) {
      if (!PoolText.safeParse(slot[field]).success) ctx.addIssue({ code: "custom", message: `a custom slot's ${field} must be a pool text: plain printable ASCII, at most the pool text bound`, path: [field] });
    }
    if (!TimeOfDay.safeParse(slot.timeOfDay).success) ctx.addIssue({ code: "custom", message: "a custom slot's timeOfDay must be plain printable ASCII, at most the time-of-day bound", path: ["timeOfDay"] });
  });
export type PlanSlot = z.infer<typeof PlanSlotSchema>;

/**
 * CS.5: a slot of the owner's own scene (made by idea in a scene set). It has no place, time, activity or outfit: only a shot, a pose and the sentence
 * the model wrote from the idea, under the category `"own"`. It lives only in a run made from a scene set (runs/plan.ts's invariant), so it always
 * carries its sentence.
 */
export const OwnPlanSlotSchema = z
  .strictObject({
    kind: z.literal("own"),
    slotIndex: z.int().positive(),
    category: z.literal("own"),
    shot: ShotSchema,
    pose: PoseSchema,
    attemptIdBase: AttemptIdBaseSchema,
    sentence: SceneText,
  })
  .refine((slot) => !isPhoneInHandShot(slot.shot) || slot.pose === "front" || slot.pose === "three-quarter", {
    message: "a selfie or mirror shot always faces the camera: pose must be front or three-quarter",
    path: ["pose"],
  });
export type OwnPlanSlot = z.infer<typeof OwnPlanSlotSchema>;

/** Any slot a run's plan may hold. */
export type RunSlot = PlanSlot | OwnPlanSlot;

export function isOwnSlot(slot: RunSlot): slot is OwnPlanSlot {
  return slot.category === "own";
}

/** The whole plan: a stable, serialisable value T6 can persist for resume and
 *  T8b can show as a review table (T5a, item 4). `slots` is already in send
 *  order — no separate ordering field. */
export const ScenePlanSchema = z.strictObject({
  version: z.literal(1),
  seed: z.int(),
  slots: z.array(PlanSlotSchema),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;
