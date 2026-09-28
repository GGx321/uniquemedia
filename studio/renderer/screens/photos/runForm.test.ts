import { expect, test } from "bun:test";
import { plan } from "../../../engine/scenes/planner";
import { contractCategory } from "../../../engine/runs/plan";
import type { Category } from "../../../engine/scenes";
import { SceneCategory } from "../../../shared/engine";
import { clampCount, COUNT_MAX, COUNT_MIN, COUNT_STEP, photosPerCategory, type RunCategory } from "./runForm";

// ---------- clampCount (M4: the stepper's own boundaries) ----------

test("clampCount never goes below the minimum", () => {
  expect(clampCount(COUNT_MIN, -COUNT_STEP)).toBe(COUNT_MIN);
  expect(clampCount(6, -COUNT_STEP)).toBe(COUNT_MIN); // one off the limit
  expect(clampCount(0, -COUNT_STEP)).toBe(COUNT_MIN);
});

test("clampCount never goes above the maximum", () => {
  expect(clampCount(COUNT_MAX, COUNT_STEP)).toBe(COUNT_MAX);
  expect(clampCount(95, COUNT_STEP)).toBe(COUNT_MAX); // the stepper's own last step
  expect(clampCount(99, COUNT_STEP)).toBe(COUNT_MAX); // one off the limit, off the 5-grid
});

test("clampCount is a plain sum in between", () => {
  expect(clampCount(20, COUNT_STEP)).toBe(25);
  expect(clampCount(20, -COUNT_STEP)).toBe(15);
});

// ---------- L1: the renderer's per-category split must match the engine planner's own ----------

/** The contract's own short names, in the engine's planner shape (runForm.ts's own `sceneCategory`, but typed here directly so this cross-check needs no `as` cast, LOW-8). */
const ENGINE_CATEGORY: Record<RunCategory, Category> = { home: "home", travel: "travel", shoot: "photoshoot", glam: "glamour", fit: "fitness" };

/** `plan()`'s slots, counted per contract category in the order they first appear (its own canonical order). */
function engineSplit(count: number, categories: readonly RunCategory[]): Map<RunCategory, number> {
  const engineCategories = categories.map((c) => ENGINE_CATEGORY[c]);
  const scenePlan = plan({ seed: 1, count, categories: engineCategories });
  const counts = new Map<RunCategory, number>();
  for (const slot of scenePlan.slots) {
    const rc = contractCategory(slot.category);
    counts.set(rc, (counts.get(rc) ?? 0) + 1);
  }
  return counts;
}

test("runForm's per-category split matches the engine planner's own for every count 5..100", () => {
  const categories: readonly RunCategory[] = SceneCategory.options;
  for (let count = COUNT_MIN; count <= COUNT_MAX; count += COUNT_STEP) {
    const rendererSplit = photosPerCategory(count, categories);
    const engine = engineSplit(count, categories);
    expect([...rendererSplit.entries()]).toEqual([...engine.entries()]);
  }
});

test("runForm's split matches the engine's for a subset of categories too, order included", () => {
  const subset: readonly RunCategory[] = ["fit", "home", "glam"]; // given out of canonical order
  for (const count of [5, 17, 41, 100]) {
    const rendererSplit = photosPerCategory(count, subset);
    const engine = engineSplit(count, subset);
    expect([...rendererSplit.entries()]).toEqual([...engine.entries()]);
  }
});
