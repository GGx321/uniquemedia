import { z } from "zod";
import { AttemptId, CategorySnapshot, Id, ImageAgeCheck, isCustomCategory, Micros, ModelId, RunRequest, type CategoryRef, type Estimate } from "../../shared/engine";
import { AGE_CHECK_CALL, estimateRun, MAX_ATTEMPTS_PER_SLOT, WRITER_CALL, type ImageChoice } from "../money/estimate";
import type { PricedBook, PriceModels } from "../money/priceCache";
import { categoryLabelOf, categoryRefOf, plannerCategoryOf, ScenePlanSchema, writerMessages, type PlannerCategory, type ScenePlan } from "../scenes";
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
 * Every slot's provider route: the settings' image model (quality low, the
 * master portrait as its one reference), then Seedream for one attempt
 * after a moderation refusal. No fallback when the image model already is
 * Seedream. The estimate prices every attempt at the dearest of the route.
 */
export function runRoute(imageModel: string): [ImageChoice, ...ImageChoice[]] {
  const fallback: ImageChoice = { model: FALLBACK_IMAGE_MODEL, quality: null, refs: 1 };
  if (imageModel === FALLBACK_IMAGE_MODEL) return [fallback];
  return [{ model: imageModel, quality: "low", refs: 1 }, fallback];
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
  const imageModels = [...new Set(runRoute(models.imageModel).map((c) => c.model))];
  const chatModels = imageAgeCheck === "on" ? [models.textModel, AGE_CHECK_CALL.model] : [models.textModel];
  return { imageModels, chatModels: [...new Set(chatModels)] };
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
    route: runRoute(models.imageModel),
    writer: writerCall(models.textModel),
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
export const RunPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId: Id,
    avatarId: Id,
    createdAt: z.iso.datetime(),
    request: z.preprocess(dropLegacyResolution, RunRequest),
    /** A snapshot of every custom category the run uses, so a resume never reads the category library. Absent for a built-in-only run. */
    categories: z.array(CategorySnapshot).optional(),
    imageAgeCheck: ImageAgeCheck,
    models: z.strictObject({ image: ModelId, fallback: ModelId.nullable(), text: ModelId }),
    capMicros: Micros,
    plannedWorstMicros: Micros,
    scenes: ScenePlanSchema,
    slotAttempts: z.array(SlotAttemptsSchema),
    writerChunks: z.array(WriterChunkSchema),
  })
  .superRefine((run, ctx) => {
    const slots = run.scenes.slots;
    if (slots.length !== run.request.count) ctx.addIssue({ code: "custom", message: `the plan has ${slots.length} slots for a request of ${run.request.count}`, path: ["scenes", "slots"] });
    if (run.request.avatarId !== run.avatarId) ctx.addIssue({ code: "custom", message: "the request must name the plan's own avatar", path: ["request", "avatarId"] });
    if (new Set(slots.map((s) => s.slotIndex)).size !== slots.length) ctx.addIssue({ code: "custom", message: "a slot index must never repeat", path: ["scenes", "slots"] });
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
    const used = new Set([...run.request.categories, ...slots.map((s) => s.category)].filter(isCustomCategory));
    for (const ref of used) {
      if (!snapshotRefs.includes(ref)) ctx.addIssue({ code: "custom", message: `the plan names custom category ${ref} without a snapshot of it`, path: ["categories"] });
    }
    const covered = run.writerChunks.flatMap((c) => c.slotIndexes);
    if (covered.length !== slots.length || slots.some((s, i) => covered[i] !== s.slotIndex)) {
      ctx.addIssue({ code: "custom", message: "the writer's chunks must cover every slot once, in plan order", path: ["writerChunks"] });
    }
    const ids = [...run.slotAttempts.flatMap((s) => s.attemptIds), ...run.writerChunks.flatMap((c) => c.attemptIds)];
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "an attempt id must never repeat within a run", path: ["slotAttempts"] });
  });
export type RunPlan = z.infer<typeof RunPlanSchema>;

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
}

/** The plan to persist: the planner's slots with every attempt id pre-allocated, and the writer's chunks with theirs. */
export function buildRunPlan(input: NewRunPlan): RunPlan {
  const route = runRoute(input.models.imageModel);
  return RunPlanSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    avatarId: input.avatarId,
    createdAt: input.createdAt,
    request: input.request,
    // Omitted, not empty, for a built-in-only run: its plan.json is the document main wrote.
    ...(input.categories === undefined || input.categories.length === 0 ? {} : { categories: input.categories }),
    imageAgeCheck: input.imageAgeCheck,
    models: { image: route[0].model, fallback: route[1]?.model ?? null, text: input.models.textModel },
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
