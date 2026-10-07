import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CategorySnapshot, RunRequest } from "../../shared/engine";
import { WRITER_CALL } from "../money/estimate";
import { PriceBook } from "../money/prices";
import { plan, planWithPools, POOLS, writerMessages } from "../scenes";
import { CUSTOM_POOL, CUSTOM_REF, customSnapshot } from "../scenes/testing/customPool";
import { foldRun } from "./journal";
import { buildRunPlan, contractCategory, plannedSlots, runWriterConfig, RunPlanSchema, sceneCategory, type NewRunPlan } from "./plan";
import { remainingEstimate } from "./remaining";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.1: a plan names its categories by ref and keeps a snapshot of every custom
// one it uses, so a resume never reads the category library. A plan.json
// written by main 3a9cd498 must keep parsing, folding and pricing unchanged.

const CUSTOM = CUSTOM_REF;
const OTHER = "cat-night-market";
const SNAPSHOT: CategorySnapshot = customSnapshot();
const MODELS = { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" };
const POSES = { profile: false, back: false };
const PRICED = { book: PriceBook.fallback(), asOf: "2026-09-24" };

function input(overrides: Partial<NewRunPlan> = {}): NewRunPlan {
  const request: RunRequest = { avatarId: "avatar-0001", count: 6, categories: ["home", CUSTOM], poses: POSES };
  return {
    runId: "run-00000001",
    avatarId: "avatar-0001",
    createdAt: "2026-10-05T12:00:00.000Z",
    request,
    imageAgeCheck: "off",
    models: MODELS,
    capMicros: 5_000_000,
    plannedWorstMicros: 5_000_000,
    scenes: planWithPools({ seed: 5, count: 6, categories: ["home", CUSTOM] }, { ...POOLS, [CUSTOM]: CUSTOM_POOL }),
    categories: [SNAPSHOT],
    ...overrides,
  };
}

describe("a plan.json written by main 3a9cd498", () => {
  const raw: Record<string, unknown> = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "plan-main-3a9cd498.json"), "utf8"));

  test("still parses, and parsing neither adds nor drops a key", () => {
    const parsed = RunPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect<unknown>(parsed.success ? parsed.data : null).toEqual(raw);
    expect(parsed.success && "categories" in parsed.data).toBe(false);
  });

  test("still folds with an empty journal into one open slot per photo", () => {
    const run = RunPlanSchema.parse(raw);
    const state = foldRun(run, { events: [], photos: [], reserveOf: () => undefined, closeOf: () => undefined });
    expect(state.slots).toHaveLength(30);
    expect(state.slots.every((s) => s.end === null)).toBe(true);
    expect(state.writerDone.size).toBe(0);
  });

  test("still prices a resume as before: both writer chunks twice at their ceiling, every slot three attempts at the dearest image", () => {
    const run = RunPlanSchema.parse(raw);
    const ledger = { reserveOf: () => undefined, closeOf: () => undefined };
    const state = foldRun(run, { events: [], photos: [], ...ledger });
    const estimate = remainingEstimate(PRICED, run, state, 0, ledger);
    expect(estimate.worstMicros).toBe(2 * 2 * 37_500 + 30 * 3 * 50_000);
    expect(estimate.expectedMicros).toBeGreaterThan(30 * 50_000);
    expect(estimate.expectedMicros).toBeLessThan(estimate.worstMicros);
  });

  test("a plan built today for built-in categories is the same document main would have written (no categories key)", () => {
    const built = buildRunPlan({ ...input({ request: { avatarId: "avatar-0001", count: 6, categories: ["home"], poses: POSES }, scenes: plan({ seed: 5, count: 6, categories: ["home"] }) }), categories: undefined });
    expect("categories" in built).toBe(false);
    expect(Object.keys(built)).toEqual(["schemaVersion", "runId", "avatarId", "createdAt", "request", "imageAgeCheck", "models", "capMicros", "plannedWorstMicros", "scenes", "slotAttempts", "writerChunks"]);
  });
});

describe("a plan naming a custom category", () => {
  test("is built with the snapshot, and round-trips through JSON", () => {
    const built = buildRunPlan(input());
    expect(built.categories).toEqual([SNAPSHOT]);
    expect(built.scenes.slots.some((s) => s.category === CUSTOM)).toBe(true);
    expect(RunPlanSchema.parse(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  test("keeps the angles of the category in its snapshot, and they round-trip through JSON (CS.8a)", () => {
    const angled: CategorySnapshot = { ...SNAPSHOT, poses: ["back", "profile"] };
    const built = buildRunPlan(input({ categories: [angled] }));
    expect(built.categories).toEqual([angled]);
    expect(RunPlanSchema.parse(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  test("a snapshot without poses stays without the key through the schema (every plan written before CS.8a)", () => {
    const parsed = RunPlanSchema.parse(JSON.parse(JSON.stringify(buildRunPlan(input()))));
    expect(parsed.categories?.every((c) => !("poses" in c))).toBe(true);
  });

  test("is refused with a snapshot whose poses are empty or repeat", () => {
    const raw = JSON.parse(JSON.stringify(buildRunPlan(input())));
    for (const poses of [[], ["back", "back"], ["sideways"]]) expect(RunPlanSchema.safeParse({ ...raw, categories: [{ ...SNAPSHOT, poses }] }).success).toBe(false);
  });

  test("is refused without a snapshot entry for a custom ref its slots use", () => {
    expect(() => buildRunPlan(input({ categories: undefined }))).toThrow();
    expect(() => buildRunPlan(input({ categories: [] }))).toThrow();
  });

  test("is refused when the snapshot covers some other custom category than the one its slots use", () => {
    expect(() => buildRunPlan(input({ categories: [{ ...SNAPSHOT, ref: OTHER }] }))).toThrow();
  });

  test("is refused when its request names a custom category the snapshot lacks, even before a slot drew from it", () => {
    const one = input({ request: { avatarId: "avatar-0001", count: 1, categories: ["home", CUSTOM], poses: POSES }, scenes: plan({ seed: 5, count: 1, categories: ["home"] }), categories: undefined });
    expect(() => buildRunPlan(one)).toThrow();
  });

  test("is refused when a persisted plan.json lost its snapshot", () => {
    const { categories: _lost, ...withoutSnapshot } = JSON.parse(JSON.stringify(buildRunPlan(input())));
    const parsed = RunPlanSchema.safeParse(withoutSnapshot);
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path[0])).toContain("categories");
  });

  test("is refused with two snapshot entries for one ref", () => {
    expect(() => buildRunPlan(input({ categories: [SNAPSHOT, { ...SNAPSHOT, name: "Другое" }] }))).toThrow();
  });

  test("is refused with a snapshot whose label is not printable ASCII or whose style is unknown", () => {
    expect(() => buildRunPlan(input({ categories: [{ ...SNAPSHOT, label: "Кофейни" }] }))).toThrow();
    expect(RunPlanSchema.safeParse({ ...JSON.parse(JSON.stringify(buildRunPlan(input()))), categories: [{ ...SNAPSHOT, style: "glossy" }] }).success).toBe(false);
  });

  test("pre-allocates its chunk and slot attempt ids by the same rule as a built-in plan", () => {
    const built = buildRunPlan(input());
    expect(built.writerChunks.map((c) => c.attemptIds)).toEqual([["run-00000001:writer-1#1", "run-00000001:writer-1#2", "run-00000001:writer-1#3", "run-00000001:writer-1#4"]]);
    expect(built.slotAttempts).toHaveLength(6);
  });
});

describe("the contract and planner names of a category", () => {
  test("a custom id is the same on both sides", () => {
    expect(sceneCategory(CUSTOM)).toBe(CUSTOM);
    expect(contractCategory(CUSTOM)).toBe(CUSTOM);
  });

  test("the five built-ins still round-trip", () => {
    for (const ref of ["home", "travel", "shoot", "glam", "fit"] as const) expect(contractCategory(sceneCategory(ref))).toBe(ref);
  });
});

describe("runWriterConfig: what a run passes its writer phase", () => {
  test("a built-in run passes exactly today's call shape", () => {
    expect(runWriterConfig(undefined).call).toEqual({ maxTokens: WRITER_CALL.maxTokens, inputTokens: WRITER_CALL.inputTokens, maxAttempts: WRITER_CALL.maxAttempts });
  });

  test("its messages are the writer's own, byte for byte, with and without a refusal", () => {
    const slots = plan({ seed: 3, count: 4, categories: ["home", "fitness"] }).slots;
    const { messages } = runWriterConfig(undefined);
    expect(messages(slots, undefined)).toEqual(writerMessages(slots));
    const refusal = { problems: ["empty" as const], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [] };
    expect(messages(slots, refusal)).toEqual(writerMessages(slots, refusal));
  });

  test("a custom run's messages name the snapshot's label", () => {
    const built = buildRunPlan(input());
    const { messages } = runWriterConfig(built.categories);
    const body = messages(plannedSlots(built), undefined)[1]?.content ?? "";
    expect(body).toContain('"category": "Paris cafes"');
    expect(body).toContain('"category": "Home"');
  });
});
