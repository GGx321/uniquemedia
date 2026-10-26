import { describe, expect, test } from "bun:test";
import type { CategoryRef } from "../../shared/engine";
import type { CoversOf } from "../../shared/scenes/writerBound";
import { MoneyError } from "../money/errors";
import { PriceBook, type ImagePrice } from "../money/prices";
import { plan as planScenes, type PlanSlot } from "../scenes";
import { foldRun } from "./journal";
import { buildRunPlan, buildSceneRunPlan, runEstimate, runEstimateFromScenes, sceneCategory, type RunPlan, type SceneRunSource } from "./plan";
import { remainingPlan } from "./remaining";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, plan s5a3 §10.2, I5.40): «plan need ≤ estimate». Over mixed routes — any subset of a run's «Смелая» slots on the Seedream route, any settings model, the age check
// on or off — what a fresh run could spend (the resume's own pricing, uncapped) never exceeds the estimate the run was capped at, in the worst case AND in the expected one.
// A launch's option-B figure (every photo bold) is never below the exact one either.

const PRICED = { book: PriceBook.fallback(), asOf: "2026-10-12" };
const COVERED: CoversOf = () => true;
const BIG_CAP = 100_000_000;
const MODELS = [
  { imageModel: "x-ai/grok-imagine-image-quality", imageQuality: null, textModel: "x-ai/grok-4.3" },
  { imageModel: "x-ai/grok-imagine-image-2.0", imageQuality: "low", textModel: "x-ai/grok-4.3" },
  { imageModel: "x-ai/grok-imagine-image-2.0", imageQuality: "medium", textModel: "x-ai/grok-4.3" },
  { imageModel: "bytedance-seed/seedream-5-0-pro", imageQuality: null, textModel: "x-ai/grok-4.3" },
] as const;

/** A small deterministic generator, so a failure names its seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function writerDone(run: RunPlan) {
  return run.writerChunks.map((c) => ({ type: "writer" as const, chunk: c.chunk, sentences: c.slotIndexes.map((slotIndex) => ({ slotIndex, sentence: "She reads by the window." })), at: "2026-10-12T12:00:00.000Z" }));
}

/** What a fresh run could spend by its own pricing, uncapped: the resume's figures. */
function need(run: RunPlan) {
  const none = { reserveOf: () => undefined, closeOf: () => undefined };
  const state = foldRun(run, { events: writerDone(run), photos: [], ...none });
  return remainingPlan(PRICED, run, state, 0, none).estimate;
}

describe("a run's plan never needs more than its estimate", () => {
  test("over 200 draws of categories, size, routed subset, settings model and age check", () => {
    const next = lcg(20261012);
    for (let draw = 0; draw < 200; draw++) {
      const model = MODELS[Math.floor(next() * MODELS.length)]!;
      const age = next() < 0.5 ? "on" : "off";
      const categories: CategoryRef[] = next() < 0.5 ? ["nightwear"] : next() < 0.5 ? ["home", "nightwear"] : ["nightwear", "beach", "home"];
      const count = 1 + Math.floor(next() * 30);
      const request = { avatarId: "avatar-0001", count, categories, level: "bold" as const, poses: { profile: false, back: false } };
      const estimate = runEstimate(PRICED, model, request, age, COVERED);
      const slots: PlanSlot[] = planScenes({ seed: draw + 1, count, categories: categories.map(sceneCategory) }).slots.map((slot) => ((slot.category === "nightwear" || slot.category === "beach") && next() < 0.7 ? { ...slot, route: "seedream" as const } : slot));
      const run = buildRunPlan({
        runId: "run-00000001",
        avatarId: "avatar-0001",
        createdAt: "2026-10-12T12:00:00.000Z",
        request,
        imageAgeCheck: age,
        models: model,
        capMicros: BIG_CAP,
        plannedWorstMicros: BIG_CAP,
        scenes: { version: 1, seed: draw + 1, slots },
      });
      const fresh = need(run);
      expect({ draw, ok: fresh.worstMicros <= estimate.worstMicros }).toEqual({ draw, ok: true });
      expect({ draw, ok: fresh.expectedMicros <= estimate.expectedMicros }).toEqual({ draw, ok: true });
    }
  });

  // 5a.4 (S5.BA5, plan s5a4 I5.77, BA3 review H-1): «Смелая» is every category's, so the planner puts a slot of the five on the route as well. The draws above route only the two
  // «Смелая» categories; these route any slot of any built-in category, the plans 5a.4 makes, and hold the estimate of the same request above them.
  test("over 200 draws where any slot of the five may be on the route too, the plan never needs more than its estimate", () => {
    const next = lcg(20261026);
    const SPLITS: CategoryRef[][] = [["home"], ["home", "travel", "shoot", "glam", "fit"], ["home", "nightwear"], ["travel", "beach", "fit"]];
    for (let draw = 0; draw < 200; draw++) {
      const model = MODELS[Math.floor(next() * MODELS.length)]!;
      const age = next() < 0.5 ? "on" : "off";
      const categories = SPLITS[Math.floor(next() * SPLITS.length)]!;
      const count = 1 + Math.floor(next() * 30);
      const request = { avatarId: "avatar-0001", count, categories, level: "bold" as const, poses: { profile: false, back: false } };
      const estimate = runEstimate(PRICED, model, request, age, COVERED);
      const slots: PlanSlot[] = planScenes({ seed: draw + 1, count, categories: categories.map(sceneCategory) }).slots.map((slot) => (next() < 0.7 ? { ...slot, route: "seedream" as const } : slot));
      const run = buildRunPlan({ runId: "run-00000001", avatarId: "avatar-0001", createdAt: "2026-10-26T12:00:00.000Z", request, imageAgeCheck: age, models: model, capMicros: BIG_CAP, plannedWorstMicros: BIG_CAP, scenes: { version: 1, seed: draw + 1, slots } });
      const fresh = need(run);
      expect({ draw, ok: fresh.worstMicros <= estimate.worstMicros }).toEqual({ draw, ok: true });
      expect({ draw, ok: fresh.expectedMicros <= estimate.expectedMicros }).toEqual({ draw, ok: true });
    }
  });

  test("a run of «Дом» at «Смелая» with every slot routed is priced exactly at its estimate's worst case", () => {
    const request = { avatarId: "avatar-0001", count: 10, categories: ["home" as const], level: "bold" as const, poses: { profile: false, back: false } };
    const model = MODELS[0];
    const slots: PlanSlot[] = planScenes({ seed: 4, count: 10, categories: ["home"] }).slots.map((slot) => ({ ...slot, route: "seedream" as const }));
    const run = buildRunPlan({ runId: "run-00000001", avatarId: "avatar-0001", createdAt: "2026-10-26T12:00:00.000Z", request, imageAgeCheck: "off", models: model, capMicros: BIG_CAP, plannedWorstMicros: BIG_CAP, scenes: { version: 1, seed: 4, slots } });
    expect(need(run).worstMicros).toBe(runEstimate(PRICED, model, request, "off", COVERED).worstMicros);
  });

  test("a run with every «Смелая» slot routed is priced exactly at its estimate's worst case", () => {
    const request = { avatarId: "avatar-0001", count: 10, categories: ["nightwear" as const], level: "bold" as const, poses: { profile: false, back: false } };
    const model = MODELS[0];
    const slots: PlanSlot[] = planScenes({ seed: 4, count: 10, categories: ["nightwear"] }).slots.map((slot) => ({ ...slot, route: "seedream" as const }));
    const run = buildRunPlan({ runId: "run-00000001", avatarId: "avatar-0001", createdAt: "2026-10-12T12:00:00.000Z", request, imageAgeCheck: "off", models: model, capMicros: BIG_CAP, plannedWorstMicros: BIG_CAP, scenes: { version: 1, seed: 4, slots } });
    expect(need(run).worstMicros).toBe(runEstimate(PRICED, model, request, "off", COVERED).worstMicros);
  });
});

describe("a run from a set never needs more than its estimate", () => {
  test("over 150 draws of size, routed subset, settings model and age check, exact and option B", () => {
    const next = lcg(777);
    for (let draw = 0; draw < 150; draw++) {
      const model = MODELS[Math.floor(next() * MODELS.length)]!;
      const age = next() < 0.5 ? "on" : "off";
      const count = 1 + Math.floor(next() * 25);
      const slots = planScenes({ seed: draw + 1, count, categories: ["nightwear"] }).slots.map((slot) => (next() < 0.6 ? { ...slot, route: "seedream" as const } : slot));
      const scenes: SceneRunSource[] = slots.map((slot, i) => ({ sceneId: i + 1, text: `She laughs in the doorway at dusk (${i + 1}).`, slot }));
      const routed = slots.filter((slot) => "route" in slot).length;
      const exact = runEstimateFromScenes(PRICED, model, { count, boldPhotos: routed }, age);
      const launch = runEstimateFromScenes(PRICED, model, { count, boldPhotos: count }, age);
      const run = buildSceneRunPlan({ runId: "run-00000001", avatarId: "avatar-0001", createdAt: "2026-10-12T12:00:00.000Z", sceneSetId: "set-00000001", imageAgeCheck: age, models: model, capMicros: BIG_CAP, plannedWorstMicros: BIG_CAP, scenes });
      const fresh = need(run);
      expect({ draw, ok: fresh.worstMicros <= exact.worstMicros && fresh.expectedMicros <= exact.expectedMicros }).toEqual({ draw, ok: true });
      expect({ draw, ok: exact.worstMicros <= launch.worstMicros && exact.expectedMicros <= launch.expectedMicros }).toEqual({ draw, ok: true });
    }
  });

  test("an estimate that prices a scene as plain when it is on the route would be too low: the plain figure is below the routed one", () => {
    const plain = runEstimateFromScenes(PRICED, MODELS[0], { count: 5 }, "off");
    const routed = runEstimateFromScenes(PRICED, MODELS[0], { count: 5, boldPhotos: 5 }, "off");
    expect(plain.worstMicros).toBeLessThan(routed.worstMicros);
  });
});

describe("the unavailable 2K tier", () => {
  test("is the only thing that makes a bold estimate fail: the plain estimate of the same book is unaffected", () => {
    const grok: ImagePrice = { outputs: [{ variant: "1k", micros: 50_000 }], inputImageMicros: 10_000 };
    const seedream: ImagePrice = { outputs: [{ variant: null, micros: 45_000 }], inputImageMicros: 3_000 };
    const noTier = new PriceBook(
      new Map([
        ["x-ai/grok-imagine-image-quality", { price: grok, source: "live" as const }],
        ["bytedance-seed/seedream-5-0-pro", { price: seedream, source: "live" as const }],
      ]),
      new Map(),
    );
    const book = { book: noTier, asOf: "2026-10-12" };
    expect(runEstimateFromScenes(book, MODELS[0], { count: 3 }, "off").worstMicros).toBe(3 * 3 * 60_000);
    expect(() => runEstimateFromScenes(book, MODELS[0], { count: 3, boldPhotos: 1 }, "off")).toThrow(MoneyError);
  });
});
