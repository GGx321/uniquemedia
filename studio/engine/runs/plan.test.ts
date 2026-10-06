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
  planRoute,
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

describe("runRoute with a chosen quality", () => {
  test("sends the chosen quality to the settings' image model and keeps the refusal fallback's none", () => {
    expect(runRoute(MODELS.imageModel, "medium")).toEqual([
      { model: "x-ai/grok-imagine-image-2.0", quality: "medium", refs: 1 },
      { model: FALLBACK_IMAGE_MODEL, quality: null, refs: 1 },
    ]);
  });

  test("sends no quality at all for a model with no quality knob (null)", () => {
    expect(runRoute("black-forest-labs/flux-3-image", null)[0]).toEqual({ model: "black-forest-labs/flux-3-image", quality: null, refs: 1 });
  });

  test("Seedream as the image model never carries a quality, whatever was chosen", () => {
    expect(runRoute(FALLBACK_IMAGE_MODEL, "medium")).toEqual([{ model: FALLBACK_IMAGE_MODEL, quality: null, refs: 1 }]);
  });
});

describe("planRoute", () => {
  test("reads the quality the plan was made with", () => {
    const run = buildRunPlan({ ...newRun(2), models: { ...MODELS, imageQuality: "medium" } });
    expect(planRoute(run)[0]).toMatchObject({ model: MODELS.imageModel, quality: "medium" });
  });

  test("a plan written before the choice existed (no imageQuality) keeps the low every such run was priced at", () => {
    const { imageQuality: _drop, ...models } = buildRunPlan(newRun(2)).models;
    const legacy = RunPlanSchema.parse({ ...buildRunPlan(newRun(2)), models });
    expect(planRoute(legacy)[0]).toMatchObject({ quality: "low" });
  });
});

describe("runPriceModels", () => {
  test("prices both image models of the route and the settings' text model for the writer, and asks for the image endpoints to be rechecked against Studio's requests", () => {
    expect(runPriceModels(MODELS, "off")).toEqual({ imageModels: [MODELS.imageModel, FALLBACK_IMAGE_MODEL], chatModels: ["x-ai/grok-4.3"], checkRequestShape: true });
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

  test("the chosen quality prices every attempt: medium at $0.06 + $0.01 reference makes 20 photos a $4.275 cap", () => {
    expect(runEstimate(FALLBACK_PRICES, { ...MODELS, imageQuality: "medium" }, { count: 20 }, "off").worstMicros).toBe(4_275_000);
    expect(runEstimate(FALLBACK_PRICES, { ...MODELS, imageQuality: "low" }, { count: 20 }, "off").worstMicros).toBe(3_075_000);
  });

  test("a model with no quality knob is priced without one: Seedream alone, 20 photos, is a $2.955 cap", () => {
    expect(runEstimate(FALLBACK_PRICES, { imageModel: FALLBACK_IMAGE_MODEL, textModel: "x-ai/grok-4.3", imageQuality: null }, { count: 20 }, "off").worstMicros).toBe(2_955_000);
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

describe("buildRunPlan: the image choice", () => {
  test("persists the quality the run was priced with, and the camera realism it was started with", () => {
    const run = buildRunPlan({ ...newRun(2), models: { ...MODELS, imageQuality: "medium" }, cameraRealism: true });
    expect(run.models.imageQuality).toBe("medium");
    expect(run.cameraRealism).toBe(true);
  });

  test("persists null for a model with no quality knob", () => {
    const run = buildRunPlan({ ...newRun(2), models: { ...MODELS, imageQuality: null } });
    expect(run.models.imageQuality).toBeNull();
  });

  // Merge compatibility (review round 1): a default run's plan.json is byte-for-byte what it was before the choice existed, so a
  // plan built today and one built before are the same file, and an exact-keys test of the plan (or a later slice's) does not move.
  test("a default run writes neither cameraRealism nor imageQuality: its plan.json carries exactly the keys it always had", () => {
    const run = buildRunPlan(newRun(2));
    expect("cameraRealism" in run).toBe(false);
    expect(Object.keys(run.models).sort()).toEqual(["fallback", "image", "text"]);
    expect(Object.keys(run).sort()).toEqual(
      ["avatarId", "capMicros", "createdAt", "imageAgeCheck", "models", "plannedWorstMicros", "request", "runId", "scenes", "schemaVersion", "slotAttempts", "writerChunks"].sort(),
    );
  });

  test("camera realism off, said explicitly, is written no more than the default is", () => {
    expect("cameraRealism" in buildRunPlan({ ...newRun(2), cameraRealism: false })).toBe(false);
  });

  test("imageQuality low on the default model is the default and is not written; a run on Seedream (no knob) writes none either", () => {
    expect("imageQuality" in buildRunPlan({ ...newRun(2), models: { ...MODELS, imageQuality: "low" } }).models).toBe(false);
    expect("imageQuality" in buildRunPlan({ ...newRun(2), models: { imageModel: FALLBACK_IMAGE_MODEL, textModel: MODELS.textModel, imageQuality: null } }).models).toBe(false);
  });

  test("a plan without imageQuality resumes as the same low route a plan with it written would", () => {
    const written = buildRunPlan({ ...newRun(2), models: { ...MODELS, imageQuality: "low" } });
    expect(planRoute(written)).toEqual(runRoute(MODELS.imageModel, "low"));
  });

  test("a plan.json written before the choice (neither field) still parses", () => {
    const { imageQuality: _q, ...models } = buildRunPlan(newRun(2)).models;
    const { cameraRealism: _c, ...rest } = buildRunPlan(newRun(2));
    expect(RunPlanSchema.safeParse({ ...rest, models }).success).toBe(true);
  });

  test("refuses a quality outside low, medium or null", () => {
    const run = buildRunPlan(newRun(2));
    expect(RunPlanSchema.safeParse({ ...run, models: { ...run.models, imageQuality: "high" } }).success).toBe(false);
  });
});

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

  /** The plan with every slot index shifted by `by`, consistently in the slots, their attempts and the writer's chunks: only the range is wrong. */
  function shifted(count: number, by: number) {
    const run = buildRunPlan(newRun(count));
    return {
      ...run,
      scenes: { ...run.scenes, slots: run.scenes.slots.map((s) => ({ ...s, slotIndex: s.slotIndex + by })) },
      slotAttempts: run.slotAttempts.map((a) => ({ ...a, slotIndex: a.slotIndex + by })),
      writerChunks: run.writerChunks.map((c) => ({ ...c, slotIndexes: c.slotIndexes.map((i) => i + by) })),
    };
  }

  test("the schema refuses slot indexes that are unique but not 1..count (here 2..count+1)", () => {
    expect(RunPlanSchema.safeParse(shifted(3, 1)).success).toBe(false);
  });

  test("the schema refuses a slot index far above the count", () => {
    expect(RunPlanSchema.safeParse(shifted(2, 40)).success).toBe(false);
  });

  test("the schema takes slot indexes 1..count, the way the planner numbers them", () => {
    expect(RunPlanSchema.safeParse(shifted(3, 0)).success).toBe(true);
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
