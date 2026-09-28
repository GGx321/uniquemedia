import { z } from "zod";
import { AttemptId, Id, ImageAgeCheck, Micros, ModelId, RunRequest, type Estimate } from "../../shared/engine";
import { AGE_CHECK_CALL, estimateRun, MAX_ATTEMPTS_PER_SLOT, WRITER_CALL, type ImageChoice } from "../money/estimate";
import type { PricedBook, PriceModels } from "../money/priceCache";
import { ScenePlanSchema, type Category, type ScenePlan } from "../scenes";
import { chunkSlots } from "../scenes/writer";

// T6: what a photo run is before anything is sent. One place for the
// provider route, the estimate (the run's own cap: invariant 3), the attempt
// ids every slot and writer chunk may ever use (invariants 5-7), and the
// plan persisted as runs/<runId>/plan.json before the writer's first call
// (invariant 6). A resume reads that plan back and never re-plans.

export type RunResolution = RunRequest["resolution"];
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

const PRICE_RESOLUTION = { "1k": "1K", "2k": "2K" } as const satisfies Record<RunResolution, ImageChoice["resolution"]>;

/** The contract's short names for the planner's categories (the Photos mockup's own labels). */
const SCENE_CATEGORY = {
  home: "home",
  travel: "travel",
  shoot: "photoshoot",
  glam: "glamour",
  fit: "fitness",
} as const satisfies Record<RunCategory, Category>;

/** The inverse of SCENE_CATEGORY; plan.test.ts pins that the two round-trip. */
const CONTRACT_CATEGORY = {
  home: "home",
  travel: "travel",
  photoshoot: "shoot",
  glamour: "glam",
  fitness: "fit",
} as const satisfies Record<Category, RunCategory>;

export function sceneCategory(category: RunCategory): Category {
  return SCENE_CATEGORY[category];
}

export function contractCategory(category: Category): RunCategory {
  return CONTRACT_CATEGORY[category];
}

/**
 * Every slot's provider route: the settings' image model (quality low, the
 * master portrait as its one reference), then Seedream for one attempt
 * after a moderation refusal. No fallback when the image model already is
 * Seedream. The estimate prices every attempt at the dearest of the route.
 */
export function runRoute(imageModel: string, resolution: RunResolution): [ImageChoice, ...ImageChoice[]] {
  const size = PRICE_RESOLUTION[resolution];
  const fallback: ImageChoice = { model: FALLBACK_IMAGE_MODEL, resolution: size, quality: null, refs: 1 };
  if (imageModel === FALLBACK_IMAGE_MODEL) return [fallback];
  return [{ model: imageModel, resolution: size, quality: "low", refs: 1 }, fallback];
}

/** The writer's call on the settings' text model, with the one source of truth's limits (money/estimate.ts). */
function writerCall(textModel: string): typeof WRITER_CALL {
  return { ...WRITER_CALL, model: textModel };
}

/** The models a run's estimate needs priced: the route's image models, the writer's text model and, when on, the age check's. */
export function runPriceModels(models: RunModels, imageAgeCheck: ImageAgeCheck): PriceModels {
  const imageModels = [...new Set(runRoute(models.imageModel, "1k").map((c) => c.model))];
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
export function runEstimate(priced: PricedBook, models: RunModels, request: Pick<RunRequest, "count" | "resolution">, imageAgeCheck: ImageAgeCheck): Estimate {
  const estimate = estimateRun(priced.book, {
    photos: request.count,
    attemptsPerSlot: RUN_ATTEMPTS_PER_SLOT,
    route: runRoute(models.imageModel, request.resolution),
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
    request: RunRequest,
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
  imageAgeCheck: ImageAgeCheck;
  models: RunModels;
  capMicros: number;
  /** The estimate's worst case at plan time; the cap may never exceed it. */
  plannedWorstMicros: number;
  scenes: ScenePlan;
}

/** The plan to persist: the planner's slots with every attempt id pre-allocated, and the writer's chunks with theirs. */
export function buildRunPlan(input: NewRunPlan): RunPlan {
  const route = runRoute(input.models.imageModel, input.request.resolution);
  return RunPlanSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    avatarId: input.avatarId,
    createdAt: input.createdAt,
    request: input.request,
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
