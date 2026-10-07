import { z } from "zod";
import { AttemptId, CategorySnapshot, Id, ImageAgeCheck, ImageQuality, isCustomCategory, Micros, ModelId, RunRequest, SceneId, type CategoryRef, type Estimate } from "../../shared/engine";
import { AGE_CHECK_CALL, estimateRun, MAX_ATTEMPTS_PER_SLOT, WRITER_CALL, type ImageChoice } from "../money/estimate";
import type { PricedBook, PriceModels } from "../money/priceCache";
import { categoryLabelOf, categoryRefOf, OwnPlanSlotSchema, plannerCategoryOf, PlanSlotSchema, writerMessages, type PlannerCategory, type PlanSlot, type ScenePlan } from "../scenes";
import { chunkSlots } from "../scenes/writer";
import type { WriterPhase } from "./writerPhase";

// T6: what a photo run is before anything is sent. One place for the
// provider route, the estimate (the run's own cap: invariant 3), the attempt
// ids every slot and writer chunk may ever use (invariants 5-7), and the
// plan persisted as runs/<runId>/plan.json before the writer's first call
// (invariant 6). A resume reads that plan back and never re-plans.

export type RunCategory = RunRequest["categories"][number];

/** The one-attempt fallback on a moderation refusal (fixed decision, "Refusal fallback"). */
export const FALLBACK_IMAGE_MODEL = "bytedance-seed/seedream-5-0-pro";

/** Invariant 7: every slot may use at most this many paid attempts, across QA retries and the fallback. */
export const RUN_ATTEMPTS_PER_SLOT = MAX_ATTEMPTS_PER_SLOT;

/**
 * Writer ids per chunk beyond its answered attempts (review H1/L10): an
 * attempt that got no answer — a final 429 or 5xx (free), a network error —
 * stops the run for a resume, and must not use up the chunk's only two ids.
 * Only answered (paid) attempts count against WRITER_CALL.maxAttempts, which
 * is what the estimate prices; these spares cost nothing unless a request
 * may have been billed, and then it counts as answered.
 */
export const WRITER_SPARE_IDS = 2;

/**
 * Slot ids beyond its three paid attempts (review round 3), for the same
 * reason as the writer's: an attempt that got no answer — a final 429 or 5xx
 * (free), a request released unsent — stops the run for a resume, and must
 * not use up one of the slot's three. Invariant 7 counts PAID attempts
 * (journal.ts's paidAttempts); the cap stays `count × 3 × the dearest model`.
 */
export const SLOT_SPARE_IDS = 2;

/** Every id a slot may ever use: its paid attempts plus the spares. */
export const SLOT_ATTEMPT_IDS = RUN_ATTEMPTS_PER_SLOT + SLOT_SPARE_IDS;

/** Every scene render is vertical (the spike's renders, and the Reels it feeds). */
export const RUN_ASPECT_RATIO = "9:16";

/** The settings' models a run uses: the image model for every slot, the text model for the scene writer. */
export interface RunModels {
  imageModel: string;
  /** The image model's quality (settings.imageQuality); `null` for a model with no quality knob. Absent: `low`, what every run sent before the choice existed. */
  imageQuality?: ImageQuality | null;
  textModel: string;
}

/** The planner's name for a contract category (a custom id stays what it is); scenes/categories.ts owns the table. */
export function sceneCategory(category: RunCategory): PlannerCategory {
  return plannerCategoryOf(category);
}

/** The contract's name for a planner category (a custom id stays what it is); plan.test.ts pins that the two round-trip. */
export function contractCategory(category: PlannerCategory): CategoryRef {
  return categoryRefOf(category);
}

/**
 * Every slot's provider route: the settings' image model (at the chosen
 * quality, `low` unless told otherwise; `null` sends none; the master portrait
 * as its one reference), then Seedream for one attempt after a moderation
 * refusal. No fallback when the image model already is Seedream (which has no
 * quality knob). The estimate prices every attempt at the dearest of the route.
 */
export function runRoute(imageModel: string, quality: ImageQuality | null = "low"): [ImageChoice, ...ImageChoice[]] {
  const fallback: ImageChoice = { model: FALLBACK_IMAGE_MODEL, quality: null, refs: 1 };
  if (imageModel === FALLBACK_IMAGE_MODEL) return [fallback];
  return [{ model: imageModel, quality, refs: 1 }, fallback];
}

/** The route a persisted plan was made with: its image model at its own quality (a plan without one is a `low` run). */
export function planRoute(plan: { models: { image: string; imageQuality?: ImageQuality | null | undefined } }): [ImageChoice, ...ImageChoice[]] {
  return runRoute(plan.models.image, plan.models.imageQuality === undefined ? "low" : plan.models.imageQuality);
}

/**
 * What a run hands its writer phase: the call shape (exactly money/estimate.ts's
 * WRITER_CALL ceilings and attempts, the one source of truth the estimate prices)
 * and the messages builder, naming each slot's category by the plan's own
 * snapshot (never the category library). Everything else of the phase is the
 * run's; a scene set (phase 2) passes its own.
 */
export function runWriterConfig(snapshots: readonly CategorySnapshot[] | undefined): Pick<WriterPhase, "call" | "messages"> {
  const labelOf = categoryLabelOf(snapshots ?? []);
  return {
    call: { maxTokens: WRITER_CALL.maxTokens, inputTokens: WRITER_CALL.inputTokens, maxAttempts: WRITER_CALL.maxAttempts },
    messages: (slots, feedback) => writerMessages(slots, feedback, labelOf),
  };
}

/** The writer's call on the settings' text model, with the one source of truth's limits (money/estimate.ts). */
function writerCall(textModel: string): typeof WRITER_CALL {
  return { ...WRITER_CALL, model: textModel };
}

/** The models a run's estimate needs priced: the route's image models, the writer's text model and, when on, the age check's. */
export function runPriceModels(models: RunModels, imageAgeCheck: ImageAgeCheck): PriceModels {
  const imageModels = [...new Set(runRoute(models.imageModel, models.imageQuality).map((c) => c.model))];
  const chatModels = imageAgeCheck === "on" ? [models.textModel, AGE_CHECK_CALL.model] : [models.textModel];
  // A run sends photo requests: its image models' endpoints are rechecked when the price loads.
  return { imageModels, chatModels: [...new Set(chatModels)], checkRequestShape: true };
}

/**
 * The run's expected and worst cost in the contract's shape (money/estimate.ts's
 * `estimateRun`): every slot's every attempt at the dearest model of its route
 * plus, when the image age check is on, an age check per attempt, and the
 * writer chunked and retried (`writerWorstMicros`). The worst case is the run's
 * cap. The age checks are priced now, with the toggle, so the cap the owner
 * accepts already covers T7a's age gate when it is wired.
 */
export function runEstimate(priced: PricedBook, models: RunModels, request: Pick<RunRequest, "count">, imageAgeCheck: ImageAgeCheck): Estimate {
  const estimate = estimateRun(priced.book, {
    photos: request.count,
    attemptsPerSlot: RUN_ATTEMPTS_PER_SLOT,
    route: runRoute(models.imageModel, models.imageQuality),
    writer: writerCall(models.textModel),
    ageChecks: imageAgeCheck === "on" ? AGE_CHECK_CALL : null,
  });
  return { expectedMicros: estimate.expectedMicros, worstMicros: estimate.worstMicros, prices: estimate.priceSource, pricesAsOf: priced.asOf };
}

/**
 * A run made from a reviewed scene set (CS.5): `runEstimate` with no writer, because every sentence already exists. `count` is the active scenes with text.
 * The route, the attempts per slot and the age checks are the whole run's own, so removing a scene lowers the worst case by exactly its attempts.
 */
export function runEstimateFromScenes(priced: PricedBook, models: RunModels, request: Pick<RunRequest, "count">, imageAgeCheck: ImageAgeCheck): Estimate {
  const estimate = estimateRun(priced.book, {
    photos: request.count,
    attemptsPerSlot: RUN_ATTEMPTS_PER_SLOT,
    route: runRoute(models.imageModel, models.imageQuality),
    writer: null,
    ageChecks: imageAgeCheck === "on" ? AGE_CHECK_CALL : null,
  });
  return { expectedMicros: estimate.expectedMicros, worstMicros: estimate.worstMicros, prices: estimate.priceSource, pricesAsOf: priced.asOf };
}

/** A slot's pre-allocated attempt ids: `${runId}:${attemptIdBase}#N`, N = 1..ids (its three paid attempts plus the spares by default). */
export function slotAttemptIds(runId: string, attemptIdBase: string, ids: number = SLOT_ATTEMPT_IDS): string[] {
  if (!Number.isSafeInteger(ids) || ids < 1 || ids > SLOT_ATTEMPT_IDS) {
    throw new RangeError(`ids per slot must be 1..${SLOT_ATTEMPT_IDS}, got ${ids}`);
  }
  return Array.from({ length: ids }, (_, i) => `${runId}:${attemptIdBase}#${i + 1}`);
}

/** A writer chunk's attempt ids, in the scene writer's own shape `${runId}:writer-${chunk}#N`: its answered attempts plus WRITER_SPARE_IDS. */
export function writerAttemptIds(runId: string, chunk: number): string[] {
  return Array.from({ length: WRITER_CALL.maxAttempts + WRITER_SPARE_IDS }, (_, i) => `${runId}:writer-${chunk}#${i + 1}`);
}

const SlotAttemptsSchema = z.strictObject({
  slotIndex: z.int().positive(),
  attemptIds: z.array(AttemptId).min(1).max(SLOT_ATTEMPT_IDS),
});

const WriterChunkSchema = z.strictObject({
  chunk: z.int().positive(),
  slotIndexes: z.array(z.int().positive()).min(1).max(WRITER_CALL.slotsPerCall),
  attemptIds: z.array(AttemptId).min(1).max(WRITER_CALL.maxAttempts + WRITER_SPARE_IDS),
});

/**
 * A plan.json written while a run still chose 1K or 2K carries
 * `request.resolution`. 2K was removed on 2026-09-29 (owner decision), but
 * such a run must stay listable and resumable: the field is dropped on read
 * (a resume renders at 1K, at or below the price its cap was set at). Any
 * value other than the two old ones is still refused.
 */
function dropLegacyResolution(request: unknown): unknown {
  if (typeof request !== "object" || request === null || !("resolution" in request)) return request;
  const { resolution, ...rest } = request;
  return resolution === "1k" || resolution === "2k" ? rest : request;
}

/**
 * runs/<runId>/plan.json. `scenes` is the planner's own ScenePlanSchema,
 * reused rather than copied, so a field the planner adds to its slots (T5c's
 * `pose`) is carried and validated by the planner's rules, never refused
 * here. `capMicros` is the run's cap for its whole life, resumes included;
 * `plannedWorstMicros` is the estimate's worst case when the run was planned,
 * which the cap may never exceed. The file is read back on every resume, so
 * it is checked like any other input from disk (review L4): the slots number
 * exactly the request's count, belong to the plan's avatar, and never repeat.
 */
/**
 * The plan's scenes: the planner's own `ScenePlan` (its slots validated by its own `PlanSlotSchema`), or — in a run made from a scene set — slots that
 * carry their sentence, some of them the owner's own scenes (`OwnPlanSlotSchema`). Only the run's plan knows the second kind; the planner never draws one.
 */
const RunScenesSchema = z.strictObject({
  version: z.literal(1),
  seed: z.int(),
  slots: z.array(z.union([PlanSlotSchema, OwnPlanSlotSchema])),
});

export const RunPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId: Id,
    avatarId: Id,
    createdAt: z.iso.datetime(),
    // Absent exactly when the run was made from a scene set (`sceneSetId`): its slots, not a request, say what is drawn.
    request: z.preprocess(dropLegacyResolution, RunRequest).optional(),
    /** CS.5: the scene set this run was made from. Present <=> every slot has its sentence <=> no writer chunks. */
    sceneSetId: Id.optional(),
    /** CS.5: the set's scene id of each slot, in slot order (the slots are renumbered 1..M; a removed scene leaves a gap in the ids). */
    sceneIds: z.array(SceneId).optional(),
    /** A snapshot of every custom category the run uses, so a resume never reads the category library. Absent for a built-in-only run. */
    categories: z.array(CategorySnapshot).optional(),
    imageAgeCheck: ImageAgeCheck,
    // Additive: «Реализм камеры» as it was when the run started. A plan.json without it is a run without the clause.
    cameraRealism: z.boolean().optional(),
    // `imageQuality` is additive too: a plan.json written before the image-model choice has none, and is a `low` run (planRoute).
    models: z.strictObject({ image: ModelId, imageQuality: ImageQuality.nullable().optional(), fallback: ModelId.nullable(), text: ModelId }),
    capMicros: Micros,
    plannedWorstMicros: Micros,
    scenes: RunScenesSchema,
    slotAttempts: z.array(SlotAttemptsSchema),
    writerChunks: z.array(WriterChunkSchema),
  })
  .superRefine((run, ctx) => {
    const slots = run.scenes.slots;
    // A run made from a scene set has no request: its count is its slots.
    const count = run.request?.count ?? slots.length;
    if (run.request !== undefined) {
      if (slots.length !== count) ctx.addIssue({ code: "custom", message: `the plan has ${slots.length} slots for a request of ${count}`, path: ["scenes", "slots"] });
      if (run.request.avatarId !== run.avatarId) ctx.addIssue({ code: "custom", message: "the request must name the plan's own avatar", path: ["request", "avatarId"] });
    }
    if (new Set(slots.map((s) => s.slotIndex)).size !== slots.length) ctx.addIssue({ code: "custom", message: "a slot index must never repeat", path: ["scenes", "slots"] });
    // The planner numbers the slots 1..count, and everything downstream (the writer's chunks, the attempt ids) is keyed by that number.
    if (slots.some((s) => s.slotIndex > count)) ctx.addIssue({ code: "custom", message: `a slot index must be between 1 and the request's count (${count})`, path: ["scenes", "slots"] });
    if (run.capMicros > run.plannedWorstMicros) ctx.addIssue({ code: "custom", message: "the cap must not exceed the worst case estimated when the run was planned", path: ["capMicros"] });
    const sameSlots = run.slotAttempts.length === slots.length && slots.every((s, i) => run.slotAttempts[i]?.slotIndex === s.slotIndex);
    if (!sameSlots) ctx.addIssue({ code: "custom", message: "every planned slot needs its own pre-allocated attempts, in plan order", path: ["slotAttempts"] });
    for (const [i, slot] of slots.entries()) {
      const prefix = `${run.runId}:${slot.attemptIdBase}#`;
      if (!(run.slotAttempts[i]?.attemptIds ?? []).every((id) => id.startsWith(prefix))) {
        ctx.addIssue({ code: "custom", message: `slot ${slot.slotIndex}'s attempt ids must start with ${prefix}`, path: ["slotAttempts", i] });
      }
    }
    const snapshotRefs = (run.categories ?? []).map((c) => c.ref);
    if (new Set(snapshotRefs).size !== snapshotRefs.length) ctx.addIssue({ code: "custom", message: "a custom category must have one snapshot entry at most", path: ["categories"] });
    const used = new Set([...(run.request?.categories ?? []), ...slots.map((s) => s.category)].filter(isCustomCategory));
    for (const ref of used) {
      if (!snapshotRefs.includes(ref)) ctx.addIssue({ code: "custom", message: `the plan names custom category ${ref} without a snapshot of it`, path: ["categories"] });
    }
    // `sceneSetId` <=> every slot has its sentence <=> no writer chunks <=> no request. Never a mixed plan: a slot with a sentence the writer would also be asked
    // for, or one with neither, is a document no start writes and no resume trusts.
    const written = slots.filter((s) => s.sentence !== undefined).length;
    if (run.sceneSetId === undefined) {
      if (written > 0) ctx.addIssue({ code: "custom", message: "only a run made from a scene set has sentences in its slots", path: ["scenes", "slots"] });
      if (run.request === undefined) ctx.addIssue({ code: "custom", message: "a run that names no scene set needs its request", path: ["request"] });
      if (run.sceneIds !== undefined) ctx.addIssue({ code: "custom", message: "only a run made from a scene set has scene ids", path: ["sceneIds"] });
    } else {
      if (written !== slots.length) ctx.addIssue({ code: "custom", message: "every slot of a run made from a scene set needs its sentence", path: ["scenes", "slots"] });
      if (slots.length === 0) ctx.addIssue({ code: "custom", message: "a run made from a scene set needs at least one scene", path: ["scenes", "slots"] });
      if (run.writerChunks.length > 0) ctx.addIssue({ code: "custom", message: "a run made from a scene set has no writer chunks: every sentence is already written", path: ["writerChunks"] });
      if (run.request !== undefined) ctx.addIssue({ code: "custom", message: "a run made from a scene set has no request", path: ["request"] });
      const sceneIds = run.sceneIds ?? [];
      if (sceneIds.length !== slots.length || new Set(sceneIds).size !== sceneIds.length) ctx.addIssue({ code: "custom", message: "a scene set's run names one distinct scene for every slot", path: ["sceneIds"] });
    }
    const covered = run.writerChunks.flatMap((c) => c.slotIndexes);
    if (run.sceneSetId === undefined && (covered.length !== slots.length || slots.some((s, i) => covered[i] !== s.slotIndex))) {
      ctx.addIssue({ code: "custom", message: "the writer's chunks must cover every slot once, in plan order", path: ["writerChunks"] });
    }
    const ids = [...run.slotAttempts.flatMap((s) => s.attemptIds), ...run.writerChunks.flatMap((c) => c.attemptIds)];
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "an attempt id must never repeat within a run", path: ["slotAttempts"] });
  });
export type RunPlan = z.infer<typeof RunPlanSchema>;

/** The slots the planner drew, without the owner's own scenes (a run made from a scene set may hold both): the ones that have a place, an outfit and a writer. */
export function plannedSlots(plan: Pick<RunPlan, "scenes">): PlanSlot[] {
  return plan.scenes.slots.filter((s): s is PlanSlot => s.category !== "own");
}

export interface NewRunPlan {
  runId: string;
  avatarId: string;
  createdAt: string;
  request: RunRequest;
  /** A snapshot of every custom category the run uses (none for a built-in-only run). */
  categories?: readonly CategorySnapshot[] | undefined;
  imageAgeCheck: ImageAgeCheck;
  models: RunModels;
  capMicros: number;
  /** The estimate's worst case at plan time; the cap may never exceed it. */
  plannedWorstMicros: number;
  scenes: ScenePlan;
  /** «Реализм камеры» when the run starts; off when absent. */
  cameraRealism?: boolean;
}

/** The plan to persist: the planner's slots with every attempt id pre-allocated, and the writer's chunks with theirs. */
export function buildRunPlan(input: NewRunPlan): RunPlan {
  const route = runRoute(input.models.imageModel, input.models.imageQuality);
  return RunPlanSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    avatarId: input.avatarId,
    createdAt: input.createdAt,
    request: input.request,
    // Omitted, not empty, for a built-in-only run: its plan.json is the document main wrote.
    ...(input.categories === undefined || input.categories.length === 0 ? {} : { categories: input.categories }),
    imageAgeCheck: input.imageAgeCheck,
    // Written only when it differs from what a plan without the key means (no clause; `low`, or none for Seedream), so a default run's
    // plan.json is byte-for-byte the one written before the image-model choice existed.
    ...(input.cameraRealism === true ? { cameraRealism: true } : {}),
    models: { image: route[0].model, ...(route[0].quality === "low" || route[0].model === FALLBACK_IMAGE_MODEL ? {} : { imageQuality: route[0].quality }), fallback: route[1]?.model ?? null, text: input.models.textModel },
    capMicros: input.capMicros,
    plannedWorstMicros: input.plannedWorstMicros,
    scenes: input.scenes,
    slotAttempts: input.scenes.slots.map((slot) => ({ slotIndex: slot.slotIndex, attemptIds: slotAttemptIds(input.runId, slot.attemptIdBase) })),
    writerChunks: chunkSlots(input.scenes.slots).map((chunk, i) => ({
      chunk: i + 1,
      slotIndexes: chunk.map((slot) => slot.slotIndex),
      attemptIds: writerAttemptIds(input.runId, i + 1),
    })),
  });
}

/** What a scene of a reviewed set hands the run: its text, and either the slot the planner drew or the shot and pose of an own scene (made by idea). */
export type SceneRunSource = { sceneId: number; text: string; slot: PlanSlot | { kind: "own"; shot: PlanSlot["shot"]; pose: PlanSlot["pose"] } };

export interface NewSceneRunPlan {
  runId: string;
  avatarId: string;
  createdAt: string;
  sceneSetId: string;
  imageAgeCheck: ImageAgeCheck;
  models: RunModels;
  /** The accepted images-only worst case, for the run's whole life. */
  capMicros: number;
  plannedWorstMicros: number;
  /** The set's active scenes with text, in the set's order. */
  scenes: readonly SceneRunSource[];
  /** A snapshot of every custom category the active scenes use (none for built-in and own scenes only). */
  categories?: readonly CategorySnapshot[] | undefined;
  cameraRealism?: boolean;
}

/**
 * The plan of a run made from a reviewed scene set (CS.5): the active scenes renumbered into slots 1..M in the set's order (the set's scene ids stay in
 * `sceneIds`), each with the sentence the set already holds, and no writer chunks: nothing is asked of the writer, so only images are paid.
 */
export function buildSceneRunPlan(input: NewSceneRunPlan): RunPlan {
  const slots = input.scenes.map(({ slot, text }, i) => {
    const slotIndex = i + 1;
    const attemptIdBase = `slot-${slotIndex}`;
    if ("kind" in slot) return { kind: "own" as const, slotIndex, category: "own" as const, shot: slot.shot, pose: slot.pose, attemptIdBase, sentence: text };
    const { slotIndex: _drawn, attemptIdBase: _base, sentence: _written, ...place } = slot;
    return { ...place, slotIndex, attemptIdBase, sentence: text };
  });
  const route = runRoute(input.models.imageModel, input.models.imageQuality);
  return RunPlanSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    avatarId: input.avatarId,
    createdAt: input.createdAt,
    sceneSetId: input.sceneSetId,
    sceneIds: input.scenes.map((s) => s.sceneId),
    ...(input.categories === undefined || input.categories.length === 0 ? {} : { categories: input.categories }),
    imageAgeCheck: input.imageAgeCheck,
    ...(input.cameraRealism === true ? { cameraRealism: true } : {}),
    models: { image: route[0].model, ...(route[0].quality === "low" || route[0].model === FALLBACK_IMAGE_MODEL ? {} : { imageQuality: route[0].quality }), fallback: route[1]?.model ?? null, text: input.models.textModel },
    capMicros: input.capMicros,
    plannedWorstMicros: input.plannedWorstMicros,
    scenes: { version: 1, seed: 0, slots },
    slotAttempts: slots.map((slot) => ({ slotIndex: slot.slotIndex, attemptIds: slotAttemptIds(input.runId, slot.attemptIdBase) })),
    writerChunks: [],
  });
}
