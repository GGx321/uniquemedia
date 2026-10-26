import { describe, expect, test } from "bun:test";
import type { CategoryRef, SceneLevel } from "../../shared/engine";
import type { ReserveLine, SettleLine } from "../money/ledger";
import { PriceBook } from "../money/prices";
import { planWithPools, POOLS } from "../scenes";
import { LLM_ONLY_POOL, LLM_ONLY_REF, llmOnlySnapshot } from "../scenes/testing/llmOnlyFixture";
import { foldRun } from "./journal";
import { buildRunPlan, runEstimate, sceneCategory, type RunPlan } from "./plan";
import { remainingPlan } from "./remaining";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA5, plan s5a4 I5.77, r2.1 L3; BA5a review L4): a resume prices each writer chunk still to ask in its own mode, the mode the run's writer phase asks it in
// (`writerModeOf` over the slots it sends the model, S5.BA4): a chunk that holds a «Смелая» frame (a custom category's routed slot at «Смелая») at the bold call, 48 750 µ$ an
// attempt, every other chunk at the ordinary one, 37 500 µ$. So a resume's figure is never below the reserve the bold attempt makes.

const RUN_ID = "run-00000001";
const AT = "2026-10-26T12:00:00.000Z";
const PRIMARY = "x-ai/grok-imagine-image-2.0";
const PRICED = { book: PriceBook.fallback(), asOf: "2026-09-24" };
const BOLD_ATTEMPT = 48_750;
const ORDINARY_ATTEMPT = 37_500;
const IMAGE_WORST = 50_000;
const BOLD_IMAGE = 93_000;

function runPlan(count: number, level: SceneLevel | undefined, categories: readonly CategoryRef[] = [LLM_ONLY_REF]): RunPlan {
  const request = { avatarId: "avatar-0001", count, categories: [...categories], ...(level === undefined ? {} : { level }) };
  return buildRunPlan({
    runId: RUN_ID,
    avatarId: "avatar-0001",
    createdAt: AT,
    request,
    imageAgeCheck: "off",
    models: { imageModel: PRIMARY, textModel: "x-ai/grok-4.3" },
    capMicros: 100_000_000,
    plannedWorstMicros: 100_000_000,
    categories: [llmOnlySnapshot()],
    scenes: planWithPools({ seed: 3, count, categories: categories.map(sceneCategory), ...(level === undefined ? {} : { level }) }, { ...POOLS, [LLM_ONLY_REF]: LLM_ONLY_POOL }),
  });
}

function planFor(run: RunPlan, reserves: ReserveLine[] = [], closes: SettleLine[] = []) {
  const byId = new Map(reserves.map((r) => [r.attemptId, r]));
  const closed = new Map(closes.map((c) => [c.attemptId, c]));
  const ledger = { reserveOf: (id: string) => byId.get(id), closeOf: (id: string) => closed.get(id) };
  return remainingPlan(PRICED, run, foldRun(run, { events: [], photos: [], ...ledger }), 0, ledger);
}

describe("a resume prices each writer chunk in its own mode", () => {
  test("a fresh custom 20 at «Смелая»: the photos at the 2K attempt and one bold chunk, two attempts at 48 750 µ$", () => {
    const run = runPlan(20, "bold");
    expect(run.scenes.slots.every((slot) => "route" in slot && slot.route === "seedream")).toBe(true);
    expect(planFor(run).estimate.worstMicros).toBe(20 * 3 * BOLD_IMAGE + 2 * BOLD_ATTEMPT);
  });

  test("it needs the bold attempt and one 2K attempt to make progress", () => {
    expect(planFor(runPlan(20, "bold")).minToProgressMicros).toBe(BOLD_ATTEMPT + BOLD_IMAGE);
  });

  test("after one paid bold attempt, one bold attempt is left", () => {
    const run = runPlan(20, "bold");
    const [first = ""] = run.writerChunks[0]?.attemptIds ?? [];
    const reserved: ReserveLine = { type: "reserve", attemptId: first, jobId: "job-00000001", scope: { runId: RUN_ID }, model: "x-ai/grok-4.3", worstMicros: BOLD_ATTEMPT, at: AT };
    const settled: SettleLine = { type: "settle", attemptId: first, costMicros: 6_000, estimated: false, at: AT };
    expect(planFor(run, [reserved], [settled]).estimate.worstMicros).toBe(20 * 3 * BOLD_IMAGE + BOLD_ATTEMPT);
  });

  test("never below the run's own estimate at «Смелая»: the resume of a fresh run is its estimate", () => {
    const run = runPlan(20, "bold");
    const estimate = runEstimate(PRICED, { imageModel: PRIMARY, textModel: "x-ai/grok-4.3" }, { count: 20, categories: [LLM_ONLY_REF], level: "bold" }, "off", () => false);
    expect(planFor(run).estimate.worstMicros).toBe(estimate.worstMicros);
  });

  test("below «Смелая» the chunk is the ordinary writer's, as before", () => {
    expect(planFor(runPlan(20, "flirty")).estimate.worstMicros).toBe(20 * 3 * IMAGE_WORST + 2 * ORDINARY_ATTEMPT);
  });
});
