import { describe, expect, test } from "bun:test";
import { SceneCategory, type RunRequest } from "../../shared/engine";
import { MAX_ATTEMPTS_PER_SLOT, WRITER_CALL } from "../money/estimate";
import { PriceBook } from "../money/prices";
import { CATEGORIES, plan } from "../scenes";
import {
  buildRunPlan,
  contractCategory,
  FALLBACK_IMAGE_MODEL,
  RUN_ATTEMPTS_PER_SLOT,
  RunPlanSchema,
  runEstimate,
  runPriceModels,
  runRoute,
  sceneCategory,
  slotAttemptIds,
  writerAttemptIds,
  SLOT_ATTEMPT_IDS,
  SLOT_SPARE_IDS,
  WRITER_SPARE_IDS,
  type NewRunPlan,
} from "./plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6: what a photo run is, before anything is sent — its provider route,
// its estimate (the run's own cap), the attempt ids it pre-allocates, and
// the plan it persists as runs/<runId>/plan.json (invariant 6).

const MODELS = { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" };
const FALLBACK_PRICES = { book: PriceBook.fallback(), asOf: "2026-09-24" };
const RUN_ID = "run-00000001";

describe("runRoute", () => {
  test("is the settings' image model at quality low with the master as its one reference, then Seedream as the refusal fallback", () => {
    expect(runRoute(MODELS.imageModel)).toEqual([
      { model: "x-ai/grok-imagine-image-2.0", quality: "low", refs: 1 },
      { model: FALLBACK_IMAGE_MODEL, quality: null, refs: 1 },
    ]);
  });

  test("has no fallback when the settings' image model already is Seedream", () => {
    expect(runRoute(FALLBACK_IMAGE_MODEL)).toEqual([{ model: FALLBACK_IMAGE_MODEL, quality: null, refs: 1 }]);
  });
});

describe("runPriceModels", () => {
  test("prices both image models of the route and the settings' text model for the writer", () => {
    expect(runPriceModels(MODELS, "off")).toEqual({ imageModels: [MODELS.imageModel, FALLBACK_IMAGE_MODEL], chatModels: ["x-ai/grok-4.3"] });
  });

  test("adds the age check's own model when the image age check is on, once", () => {
    expect(runPriceModels({ ...MODELS, textModel: "openai/gpt-5-mini" }, "on").chatModels).toEqual(["openai/gpt-5-mini", "x-ai/grok-4.3"]);
    expect(runPriceModels(MODELS, "on").chatModels).toEqual(["x-ai/grok-4.3"]);
  });
});

describe("runEstimate (the plan's money model, at the dated fallback prices)", () => {
  // Primary: grok-imagine-image-2.0 low 1K $0.04 + one reference $0.01 = 50_000 µ$.
  // Seedream 1K $0.045 + one reference $0.003 = 48_000 µ$: the primary is the dearest attempt.
  // Writer on grok-4.3: 14K in, 8K out at the ceiling = 37_500 µ$ per attempt, 2 attempts per chunk of 25 slots (T5c).

  test("20 photos with the image age check off: cap ≈ $3.075 (20 × 3 × $0.05 + 1 chunk × 2 × $0.0375)", () => {
    const estimate = runEstimate(FALLBACK_PRICES, MODELS, { count: 20 }, "off");
    expect(estimate).toEqual({ expectedMicros: 1_009_150, worstMicros: 3_075_000, prices: "fallback", pricesAsOf: "2026-09-24" });
  });

  test("20 photos with the image age check on: cap ≈ $3.39 (every attempt carries its age check)", () => {
    const estimate = runEstimate(FALLBACK_PRICES, MODELS, { count: 20 }, "on");
    expect(estimate).toMatchObject({ expectedMicros: 1_042_350, worstMicros: 3_390_000 });
  });

  test("100 photos (four writer chunks): ≈ $15.30 off, ≈ $16.875 on", () => {
    expect(runEstimate(FALLBACK_PRICES, MODELS, { count: 100 }, "off").worstMicros).toBe(15_300_000);
    expect(runEstimate(FALLBACK_PRICES, MODELS, { count: 100 }, "on").worstMicros).toBe(16_875_000);
  });

  test("attempts per slot are the invariant's maximum", () => {
    expect(RUN_ATTEMPTS_PER_SLOT).toBe(MAX_ATTEMPTS_PER_SLOT);
  });
});

describe("categories", () => {
  test("every contract category maps to a planner category and back", () => {
    for (const category of SceneCategory.options) expect(contractCategory(sceneCategory(category))).toBe(category);
    expect(SceneCategory.options.map(sceneCategory).sort()).toEqual([...CATEGORIES].sort());
  });

  test("shoot, glam and fit are the planner's photoshoot, glamour and fitness", () => {
    expect([sceneCategory("shoot"), sceneCategory("glam"), sceneCategory("fit")]).toEqual(["photoshoot", "glamour", "fitness"]);
  });
});

describe("attempt ids", () => {
  test("a slot's ids are `${runId}:${attemptIdBase}#N`, N = 1..5: its three paid attempts plus two spares for attempts that got no answer", () => {
    expect(slotAttemptIds(RUN_ID, "slot-7")).toEqual([1, 2, 3, 4, 5].map((n) => `${RUN_ID}:slot-7#${n}`));
    expect(SLOT_ATTEMPT_IDS).toBe(MAX_ATTEMPTS_PER_SLOT + SLOT_SPARE_IDS);
    expect(SLOT_SPARE_IDS).toBe(2);
  });

  test("fewer ids per slot are allowed; none, or more than the paid attempts plus the spares, are refused", () => {
    expect(slotAttemptIds(RUN_ID, "slot-1", 1)).toEqual([`${RUN_ID}:slot-1#1`]);
    expect(() => slotAttemptIds(RUN_ID, "slot-1", 0)).toThrow(RangeError);
    expect(() => slotAttemptIds(RUN_ID, "slot-1", SLOT_ATTEMPT_IDS + 1)).toThrow(RangeError);
  });

  test("a writer chunk's ids stay `${runId}:writer-${chunk}#N`: one per answered attempt plus spares for attempts that got no answer", () => {
    expect(writerAttemptIds(RUN_ID, 2)).toEqual([1, 2, 3, 4].map((n) => `${RUN_ID}:writer-2#${n}`));
    expect(writerAttemptIds(RUN_ID, 1)).toHaveLength(WRITER_CALL.maxAttempts + WRITER_SPARE_IDS);
    expect(WRITER_SPARE_IDS).toBe(2);
  });
});

function newRun(count: number, request: Partial<RunRequest> = {}): NewRunPlan {
  const categories = request.categories ?? ["home", "travel"];
  return {
    runId: RUN_ID,
    avatarId: "avatar-0001",
    createdAt: "2026-09-24T12:00:00.000Z",
    request: { avatarId: "avatar-0001", count, categories, poses: { profile: false, back: false }, ...request },
    imageAgeCheck: "off",
    models: MODELS,
    capMicros: 3_070_000,
    plannedWorstMicros: 3_070_000,
    scenes: plan({ seed: 7, count, categories: categories.map(sceneCategory) }),
  };
}

describe("buildRunPlan", () => {
  test("pre-allocates every slot's attempt ids from its own attemptIdBase, in plan order", () => {
    const run = buildRunPlan(newRun(4));
    expect(run.slotAttempts).toEqual(run.scenes.slots.map((s) => ({ slotIndex: s.slotIndex, attemptIds: slotAttemptIds(RUN_ID, s.attemptIdBase) })));
  });

  test("pre-allocates the writer's chunks of at most 25 slots, each with its own attempt ids", () => {
    const run = buildRunPlan(newRun(60, { categories: ["home"] }));
    expect(run.writerChunks.map((c) => c.slotIndexes.length)).toEqual([25, 25, 10]);
    expect(run.writerChunks.map((c) => c.attemptIds)).toEqual([1, 2, 3].map((chunk) => writerAttemptIds(RUN_ID, chunk)));
    expect(run.writerChunks.flatMap((c) => c.slotIndexes)).toEqual(run.scenes.slots.map((s) => s.slotIndex));
  });

  test("no attempt id repeats anywhere in a 100-photo plan", () => {
    const run = buildRunPlan(newRun(100, { categories: ["home", "travel", "shoot", "glam", "fit"] }));
    const ids = [...run.slotAttempts.flatMap((s) => s.attemptIds), ...run.writerChunks.flatMap((c) => c.attemptIds)];
    expect(ids).toHaveLength(100 * SLOT_ATTEMPT_IDS + 4 * (WRITER_CALL.maxAttempts + WRITER_SPARE_IDS));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("round-trips through its own schema, as plan.json is written and read back", () => {
    const run = buildRunPlan(newRun(20));
    expect(RunPlanSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  test("a plan.json written while runs still chose a resolution reads back: the legacy request.resolution is dropped, never refused (owner decision 2026-09-29: 2K removed)", () => {
    const run = buildRunPlan(newRun(3));
    for (const legacy of ["1k", "2k"]) {
      const onDisk = JSON.parse(JSON.stringify({ ...run, request: { ...run.request, resolution: legacy } }));
      const parsed = RunPlanSchema.parse(onDisk);
      expect(parsed).toEqual(run);
      expect("resolution" in parsed.request).toBe(false);
    }
  });

  test("a plan.json whose legacy resolution is not 1k or 2k is refused", () => {
    const run = buildRunPlan(newRun(1));
    expect(RunPlanSchema.safeParse({ ...run, request: { ...run.request, resolution: "4k" } }).success).toBe(false);
  });

  test("the schema refuses a plan whose slot has no pre-allocated attempts", () => {
    const run = buildRunPlan(newRun(3));
    const broken = { ...run, slotAttempts: run.slotAttempts.slice(1) };
    expect(RunPlanSchema.safeParse(broken).success).toBe(false);
  });

  test("the schema refuses an attempt id used twice", () => {
    const run = buildRunPlan(newRun(2));
    const [first, second] = run.slotAttempts;
    if (first === undefined || second === undefined) throw new Error("two slots expected");
    const broken = { ...run, slotAttempts: [first, { ...second, attemptIds: [first.attemptIds[0]] }] };
    expect(RunPlanSchema.safeParse(broken).success).toBe(false);
  });

  test("the schema refuses a slot that fails the planner's own slot schema", () => {
    const run = buildRunPlan(newRun(1));
    const broken = { ...run, scenes: { ...run.scenes, slots: run.scenes.slots.map((s) => ({ ...s, attemptIdBase: "nope" })) } };
    expect(RunPlanSchema.safeParse(broken).success).toBe(false);
  });

  // Review L4: plan.json is read back from disk on every resume — a trust boundary like any other file.
  test("the schema refuses a plan whose slots do not number exactly the requested count", () => {
    const run = buildRunPlan(newRun(3));
    expect(RunPlanSchema.safeParse({ ...run, request: { ...run.request, count: 4 } }).success).toBe(false);
  });

  test("the schema refuses a plan whose request names another avatar", () => {
    const run = buildRunPlan(newRun(1));
    expect(RunPlanSchema.safeParse({ ...run, request: { ...run.request, avatarId: "avatar-0002" } }).success).toBe(false);
  });

  test("the schema refuses a slot index used twice", () => {
    const run = buildRunPlan(newRun(2));
    const twin = run.scenes.slots.map((s) => ({ ...s, slotIndex: 1 }));
    expect(RunPlanSchema.safeParse({ ...run, scenes: { ...run.scenes, slots: twin }, slotAttempts: run.slotAttempts.map((a) => ({ ...a, slotIndex: 1 })) }).success).toBe(false);
  });

  test("the schema refuses a cap above the worst case estimated when the run was planned; both are kept", () => {
    const run = buildRunPlan(newRun(1));
    expect(run.plannedWorstMicros).toBe(3_070_000);
    expect(RunPlanSchema.safeParse({ ...run, capMicros: run.plannedWorstMicros + 1 }).success).toBe(false);
    expect(RunPlanSchema.safeParse({ ...run, capMicros: run.plannedWorstMicros - 1 }).success).toBe(true);
  });

  test("the schema refuses a negative or fractional cap", () => {
    const run = buildRunPlan(newRun(1));
    expect(RunPlanSchema.safeParse({ ...run, capMicros: -1 }).success).toBe(false);
    expect(RunPlanSchema.safeParse({ ...run, capMicros: 1.5 }).success).toBe(false);
  });
});
