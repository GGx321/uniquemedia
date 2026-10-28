import { describe, expect, test } from "bun:test";
import { plan } from "../../../engine/scenes/planner";
import { contractCategory } from "../../../engine/runs/plan";
import { plannerCategoryOf } from "../../../engine/scenes";
import { ORDINARY_SCENE_CATEGORIES, RunRequest, SceneCategory, splitCount } from "../../../shared/engine";
import { covers } from "../../../shared/scenes/custom";
import { BED_POOL, category, PARIS_POOL } from "./categoryScreenKit";
import {
  arrangeCategories,
  CATEGORY_LABEL,
  clampCount,
  COUNT_MAX,
  COUNT_MIN,
  COUNT_STEP,
  DEFAULT_RUN_FORM,
  photoCategoryLabel,
  photosPerCategory,
  requestKey,
  runRequest,
  sameCategories,
  sceneWriters,
  toggleCategory,
  type RunCategory,
} from "./runForm";

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
  // 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): the five the form offers (ORDINARY_SCENE_CATEGORIES); every assertion kept. The seven are split in the test below.
  const categories: readonly RunCategory[] = ORDINARY_SCENE_CATEGORIES;
  for (let count = COUNT_MIN; count <= COUNT_MAX; count += COUNT_STEP) {
    const rendererSplit = photosPerCategory(count, categories);
    const engine = engineSplit(count, categories);
    expect([...rendererSplit.entries()]).toEqual([...engine.entries()]);
  }
});

// 5a.3 (S5.9b2): with the two «Смелая» categories too, from 10 photos up (below seven a category gets none, and a plan has no slot to count it by).
test("runForm's split matches the engine planner's own over all seven built-ins too", () => {
  const categories: readonly RunCategory[] = SceneCategory.options;
  for (let count = 10; count <= COUNT_MAX; count += COUNT_STEP) {
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

// S5.7c (plan s5a2 §6.1, changed on purpose): the window no longer sends «Ракурсы» — the angle comes from the scene — and sends «Подача» only when it is not
// the default, so a stored request carries `level` only when it differs (I5.27).
test("runRequest asks for nothing about resolution or poses: only the avatar, the count and the categories", () => {
  expect(DEFAULT_RUN_FORM.level).toBe("ordinary");
  expect(Object.keys(runRequest("avatar-0001", DEFAULT_RUN_FORM)).sort()).toEqual(["avatarId", "categories", "count"]);
});

test("runRequest adds «Подача» when it is «Кокетливая»", () => {
  const request = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, level: "flirty" });
  expect(Object.keys(request).sort()).toEqual(["avatarId", "categories", "count", "level"]);
  expect(request.level).toBe("flirty");
  expect(RunRequest.safeParse(request).success).toBe(true);
});

test("an ordinary and a flirty request are priced apart: their keys differ", () => {
  const ordinary = runRequest("avatar-0001", DEFAULT_RUN_FORM);
  const flirty = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, level: "flirty" });
  expect(requestKey(ordinary)).not.toBe(requestKey(flirty));
  // An old request that still names «Ракурсы» keys like the same request without them: poses change no plan (I5.26).
  expect(requestKey({ ...ordinary, poses: { profile: true, back: true } })).toBe(requestKey(ordinary));
});

// S5.8b (plan s5a2 §7, I5.29; mockups 33, 34#card): «Ножки» go into the request as `legsShare`, only when a share is picked and a built-in category is on.
// «Нет» sends none (a stored request then carries it only when it differs, I5.27), and nor does a run of the owner's own categories only: the engine
// would refuse it (`legs-built-in-only`).
test("runRequest asks for no legs by default: «Нет»", () => {
  expect(DEFAULT_RUN_FORM.legs).toBe(0);
  expect("legsShare" in runRequest("avatar-0001", DEFAULT_RUN_FORM)).toBe(false);
});

test("runRequest adds «Ножки» as `legsShare` when a share is picked and a built-in is on", () => {
  const some = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, legs: 15 });
  expect(Object.keys(some).sort()).toEqual(["avatarId", "categories", "count", "legsShare"]);
  expect(some.legsShare).toBe(15);
  expect(RunRequest.safeParse(some).success).toBe(true);
  expect(runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, categories: ["fit", CUSTOM_A], legs: 30 }).legsShare).toBe(30);
});

test("runRequest sends no legs for the owner's own categories only, whatever the pick", () => {
  const custom = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, categories: [CUSTOM_A, CUSTOM_B], legs: 30 });
  expect("legsShare" in custom).toBe(false);
});

test("requests with other legs are priced apart: their keys differ", () => {
  const none = runRequest("avatar-0001", DEFAULT_RUN_FORM);
  const some = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, legs: 15 });
  const many = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, legs: 30 });
  expect(new Set([requestKey(none), requestKey(some), requestKey(many)]).size).toBe(3);
  // A request that names «Нет» keys like one that names nothing: absent is 0.
  expect(requestKey({ ...none, legsShare: 0 })).toBe(requestKey(none));
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

// ---------- CS.3: the chips keep the custom categories in creation order, whatever order they were clicked in ----------

/** The library's creation order: A was made first, then B, then C. */
const CREATED = ["cat-paris-cafes", "cat-night-market", "cat-mono-studio"] as const;
const [FIRST, SECOND, THIRD] = CREATED;

test("toggleCategory keeps custom categories in creation order, not click order", () => {
  let categories: readonly RunCategory[] = ["home"];
  categories = toggleCategory(categories, THIRD, CREATED);
  categories = toggleCategory(categories, FIRST, CREATED);
  categories = toggleCategory(categories, SECOND, CREATED);
  expect(categories).toEqual(["home", FIRST, SECOND, THIRD]);
  // So the remainder of an uneven split goes to the custom category made first, as the engine (which keeps the request's order) draws it.
  expect([...photosPerCategory(10, categories).entries()]).toEqual([
    ["home", 3],
    [FIRST, 3],
    [SECOND, 2],
    [THIRD, 2],
  ]);
});

test("toggleCategory turns a chip off, and keeps the built-ins in their canonical order", () => {
  expect(toggleCategory(["fit", FIRST, "home"], "home", CREATED)).toEqual(["fit", FIRST]);
  expect(toggleCategory(["fit", FIRST], "travel", CREATED)).toEqual(["travel", "fit", FIRST]);
  expect(toggleCategory(["home", FIRST, SECOND], FIRST, CREATED)).toEqual(["home", SECOND]);
});

test("arrangeCategories drops a custom category the library no longer holds (deleted, or another library's)", () => {
  expect(arrangeCategories(["home", SECOND, "cat-gone-for-good", FIRST], CREATED)).toEqual(["home", FIRST, SECOND]);
  // With no custom category listed at all (the library not read yet, or another library), only the built-ins stay.
  expect(arrangeCategories(["home", FIRST], [])).toEqual(["home"]);
  // Empty stays empty.
  expect(arrangeCategories([], CREATED)).toEqual([]);
});

test("sameCategories compares two lists element by element", () => {
  expect(sameCategories(["home", FIRST], ["home", FIRST])).toBe(true);
  expect(sameCategories(["home", FIRST], [FIRST, "home"])).toBe(false);
  expect(sameCategories(["home"], ["home", FIRST])).toBe(false);
  expect(sameCategories([], [])).toBe(true);
});

// ---------- S5.7c (mockup 26): who writes a run's scenes ----------

describe("sceneWriters: the app's template writes the built-ins and the custom categories it covers; the model the others", () => {
  const covered = category(1, "Домашнее у кровати", BED_POOL);
  const uncovered = category(2, "Кофейни Парижа", PARIS_POOL);

  test("the built-ins alone: the app", () => {
    expect(sceneWriters(20, ["home", "glam"], [], "ordinary")).toEqual({ app: true, model: [] });
  });

  test("a covered custom category is the app's too, an uncovered one the model's by name", () => {
    expect(covers(covered.pool)).toBe(true);
    expect(covers(uncovered.pool)).toBe(false);
    expect(sceneWriters(20, ["home", covered.categoryId, uncovered.categoryId], [covered, uncovered], "ordinary")).toEqual({ app: true, model: ["Кофейни Парижа"] });
    expect(sceneWriters(20, [uncovered.categoryId], [covered, uncovered], "ordinary")).toEqual({ app: false, model: ["Кофейни Парижа"] });
  });

  test("a category with no photo of the run writes nothing; one the library does not hold is nobody's", () => {
    // 1 photo over two categories: the custom one gets none.
    expect(sceneWriters(1, ["home", uncovered.categoryId], [uncovered], "ordinary")).toEqual({ app: true, model: [] });
    expect(sceneWriters(20, ["cat-gone-for-good"], [], "ordinary")).toEqual({ app: false, model: [] });
    expect(sceneWriters(0, ["home"], [], "ordinary")).toEqual({ app: false, model: [] });
  });
});

// 5a.4 (S5.BA8a, plan s5a4 §5.9 row 6, QB-4): at «Смелая» a custom category is written by the model, covered by the app's table or not: its scenes carry a world and the writer sets the frame inside it.
describe("sceneWriters at «Смелая»: the model writes every custom category", () => {
  const covered = category(1, "Домашнее у кровати", BED_POOL);
  const uncovered = category(2, "Кофейни Парижа", PARIS_POOL);

  test("a covered custom category is the model's by name", () => {
    expect(covers(covered.pool)).toBe(true);
    expect(sceneWriters(20, [covered.categoryId], [covered], "bold")).toEqual({ app: false, model: ["Домашнее у кровати"] });
  });

  test("the built-ins stay the app's, the custom categories the model's, in the run's order", () => {
    expect(sceneWriters(20, ["home", covered.categoryId, uncovered.categoryId], [covered, uncovered], "bold")).toEqual({ app: true, model: ["Домашнее у кровати", "Кофейни Парижа"] });
  });

  test("below «Смелая» the covered one is still the app's (unchanged)", () => {
    expect(sceneWriters(20, [covered.categoryId], [covered], "flirty")).toEqual({ app: true, model: [] });
    expect(sceneWriters(20, [covered.categoryId], [covered], "ordinary")).toEqual({ app: true, model: [] });
  });

  test("a category with no photo of the run, or one the library does not hold, is still nobody's", () => {
    expect(sceneWriters(1, ["home", covered.categoryId], [covered], "bold")).toEqual({ app: true, model: [] });
    expect(sceneWriters(20, ["cat-gone-for-good"], [], "bold")).toEqual({ app: false, model: [] });
  });
});

// ---------- a photo's category label (gallery, viewer, montage bin) ----------

test("a built-in category is named by the renderer's own Russian label, whatever label the photo carries", () => {
  for (const category of SceneCategory.options) expect(photoCategoryLabel({ category })).toBe(CATEGORY_LABEL[category]);
});

test("a custom category is named by the label its photo kept", () => {
  expect(photoCategoryLabel({ category: CUSTOM_A, categoryName: "Кофейни Парижа" })).toBe("Кофейни Парижа");
});

test("a custom category whose photo kept no label still has a name", () => {
  expect(photoCategoryLabel({ category: CUSTOM_A })).toBe("Своя категория");
});

test("an own scene is «Своя сцена» unless its photo kept another label", () => {
  expect(photoCategoryLabel({ category: "own" })).toBe("Своя сцена");
  expect(photoCategoryLabel({ category: "own", categoryName: "Идея" })).toBe("Идея");
});

// ---------- 5a.3 (S5.9b2, plan s5a3 §6.1, §11): the two «Смелая» categories ----------

test("the two «Смелая» categories have their Russian labels, for their photos and their chips to come", () => {
  expect([CATEGORY_LABEL.nightwear, CATEGORY_LABEL.beach]).toEqual(["Ночнушки и бельё", "Пляж и бассейн"]);
  expect(photoCategoryLabel({ category: "nightwear" })).toBe("Ночнушки и бельё");
  expect(photoCategoryLabel({ category: "beach" })).toBe("Пляж и бассейн");
});

test("the form's default categories are the five ordinary built-ins: the «Смелая» two are never on by default", () => {
  expect([...DEFAULT_RUN_FORM.categories]).toEqual(["home", "travel", "shoot", "glam", "fit"]);
});

// 2026-10-12, S5.9g (plan s5a3 §13.1; mockups 47, 48#kept): the chips ship, so the row «until their chips ship the form never asks for a «Смелая» category:
// arranging drops one» is replaced by what the form does now. Arranging keeps them (in SceneCategory's order, after the five, before the owner's own); the
// guard moves to the request, which asks for one only with «Смелая» (below).
test("arranging keeps a «Смелая» category, after the five and before the owner's own", () => {
  expect(arrangeCategories(["beach", "home", CUSTOM_A, "nightwear"], [CUSTOM_A])).toEqual(["home", "nightwear", "beach", CUSTOM_A]);
  expect(toggleCategory(["home"], "nightwear", [])).toEqual(["home", "nightwear"]);
  expect(toggleCategory(["home", "nightwear"], "nightwear", [])).toEqual(["home"]);
});

// ---------- 5a.3 (S5.9g, plan s5a3 I5.42, §14 «S5.9g»): the request keys ----------

test("«Смелая» goes into the request as `level: \"bold\"`, with the «Смелая» categories the form holds", () => {
  const request = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, categories: ["home", "nightwear", "beach"], level: "bold" });
  expect(request).toEqual({ avatarId: "avatar-0001", count: 20, categories: ["home", "nightwear", "beach"], level: "bold" });
  expect(RunRequest.safeParse(request).success).toBe(true);
});

test("«Смелая» with only the five is still `level: \"bold\"` (the engine draws them as «Кокетливая»)", () => {
  expect(runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, level: "bold" }).level).toBe("bold");
});

test("a «Смелая» category picked and kept under another «Подача» stays in the form but is never asked for", () => {
  const form = { ...DEFAULT_RUN_FORM, categories: ["home", "nightwear"] as RunCategory[] };
  expect(runRequest("avatar-0001", { ...form, level: "flirty" })).toEqual({ avatarId: "avatar-0001", count: 20, categories: ["home"], level: "flirty" });
  expect(runRequest("avatar-0001", { ...form, level: "ordinary" })).toEqual({ avatarId: "avatar-0001", count: 20, categories: ["home"] });
  // Only the kept one: the request names no category at all, so nothing is priced or sent.
  expect(runRequest("avatar-0001", { ...form, categories: ["nightwear"], level: "flirty" }).categories).toEqual([]);
});

test("guard: no form, whatever its level and categories, asks for a «Смелая» category without «Смелая», nor for «Смелая» unless it was chosen", () => {
  const pool: RunCategory[] = ["home", "travel", "shoot", "glam", "fit", "nightwear", "beach", CUSTOM_A];
  for (const level of ["ordinary", "flirty", "bold"] as const) {
    for (let mask = 0; mask < 1 << pool.length; mask++) {
      const categories = pool.filter((_, i) => (mask & (1 << i)) !== 0);
      const request = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, categories, level });
      const asksBold = request.categories.some((c) => c === "nightwear" || c === "beach");
      if (asksBold) expect(request.level).toBe("bold");
      expect(request.level === "bold").toBe(level === "bold");
      expect(request.level === undefined).toBe(level === "ordinary");
    }
  }
});

test("a bold request and a flirty one of the same form are priced apart: their keys differ", () => {
  const form = { ...DEFAULT_RUN_FORM, categories: ["home", "nightwear"] as RunCategory[] };
  expect(requestKey(runRequest("avatar-0001", { ...form, level: "bold" }))).not.toBe(requestKey(runRequest("avatar-0001", { ...form, level: "flirty" })));
});

test("the chips' split counts only what the request asks for: a kept «Смелая» category takes no photo", () => {
  const flirty = runRequest("avatar-0001", { ...DEFAULT_RUN_FORM, categories: ["home", "nightwear"], level: "flirty" });
  expect([...photosPerCategory(20, flirty.categories)]).toEqual([["home", 20]]);
});
