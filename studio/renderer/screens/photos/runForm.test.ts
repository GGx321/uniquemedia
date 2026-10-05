import { expect, test } from "bun:test";
import { plan } from "../../../engine/scenes/planner";
import { contractCategory } from "../../../engine/runs/plan";
import { plannerCategoryOf } from "../../../engine/scenes";
import { RunRequest, SceneCategory, splitCount } from "../../../shared/engine";
import { CATEGORY_LABEL, clampCount, COUNT_MAX, COUNT_MIN, COUNT_STEP, DEFAULT_RUN_FORM, photoCategoryLabel, photosPerCategory, requestKey, runRequest, type RunCategory } from "./runForm";

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

/** `plan()`'s slots, counted per contract category in the order they first appear (its own canonical order). */
function engineSplit(count: number, categories: readonly RunCategory[]): Map<RunCategory, number> {
  const engineCategories = categories.map(plannerCategoryOf);
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

// ---------- 2K removed (owner decision 2026-09-29) ----------

test("runRequest asks for nothing about resolution: only the avatar, the count, the categories and the poses", () => {
  expect(Object.keys(runRequest("avatar-0001", DEFAULT_RUN_FORM)).sort()).toEqual(["avatarId", "categories", "count", "poses"]);
});

// ---------- CS.1: custom categories on the form (chips for them come with CS.3) ----------

const CUSTOM_A = "cat-paris-cafes";
const CUSTOM_B = "cat-night-market";

test("the per-category split is the shared splitCount, custom categories included, for every count 1..100", () => {
  const lists: RunCategory[][] = [[CUSTOM_A], ["fit", CUSTOM_B, "home", CUSTOM_A], [...SceneCategory.options, CUSTOM_A, CUSTOM_B]];
  for (const list of lists) {
    for (let count = 1; count <= 100; count++) {
      expect([...photosPerCategory(count, list).entries()]).toEqual(splitCount(count, list).map(({ ref, count: n }) => [ref, n]));
    }
  }
});

test("a custom category counts after the built-ins, and takes a remainder photo only when the earlier ones have theirs", () => {
  expect([...photosPerCategory(10, ["fit", CUSTOM_A, "home"]).entries()]).toEqual([
    ["home", 4],
    ["fit", 3],
    [CUSTOM_A, 3],
  ]);
});

test("runRequest puts the built-ins in canonical order and the custom ones after them, in the form's order", () => {
  const request = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, categories: [CUSTOM_B, "fit", CUSTOM_A, "home"] });
  expect(request.categories).toEqual(["home", "fit", CUSTOM_B, CUSTOM_A]);
});

test("equal forms in a different category order give one request and one key", () => {
  const a = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, categories: ["home", CUSTOM_A, "fit"] });
  const b = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, categories: ["fit", "home", CUSTOM_A] });
  expect(a).toEqual(b);
  expect(requestKey(a)).toBe(requestKey(b));
});

test("a request with a custom category parses as a RunRequest", () => {
  expect(RunRequest.safeParse(runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, categories: ["home", CUSTOM_A] })).success).toBe(true);
});

// ---------- a photo's category label (gallery, viewer, montage bin) ----------

test("a built-in category is named by the renderer's own Russian label, whatever label the photo carries", () => {
  for (const category of SceneCategory.options) expect(photoCategoryLabel({ category })).toBe(CATEGORY_LABEL[category]);
});

test("a custom category is named by the label its photo kept", () => {
  expect(photoCategoryLabel({ category: CUSTOM_A, categoryLabel: "Кофейни Парижа" })).toBe("Кофейни Парижа");
});

test("a custom category whose photo kept no label still has a name", () => {
  expect(photoCategoryLabel({ category: CUSTOM_A })).toBe("Своя категория");
});

test("an own scene is «Своя сцена» unless its photo kept another label", () => {
  expect(photoCategoryLabel({ category: "own" })).toBe("Своя сцена");
  expect(photoCategoryLabel({ category: "own", categoryLabel: "Идея" })).toBe("Идея");
});
