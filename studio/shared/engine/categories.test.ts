import { describe, expect, test } from "bun:test";
import {
  CATEGORY_LABEL_MAX,
  CategoryLabel,
  CategoryRef,
  CategorySnapshot,
  CustomCategoryId,
  isCustomCategory,
  MAX_RUN_CATEGORIES,
  orderCategories,
  PhotoCategory,
  SceneCategory,
  splitCount,
  type CategoryRef as Ref,
} from "./categories";
import { PhotoSummary, RunRequest } from "./state";

// Custom categories are named next to the five built-ins by a prefixed id, so
// every request, plan and sidecar written before them keeps its meaning.

const CUSTOM_A = "cat-paris-cafes";
const CUSTOM_B = "cat-night-market";
const CUSTOM_C = "cat-beach-days1";

describe("CustomCategoryId", () => {
  test("accepts cat- followed by 8 to 59 of a-z, 0-9 and a dash", () => {
    expect(CustomCategoryId.safeParse("cat-abcdefgh").success).toBe(true);
    expect(CustomCategoryId.safeParse(`cat-${"a".repeat(59)}`).success).toBe(true);
    expect(CustomCategoryId.safeParse("cat-4f2a-9c1b-77").success).toBe(true);
  });

  test("rejects one that is one char short or one char long", () => {
    expect(CustomCategoryId.safeParse("cat-abcdefg").success).toBe(false);
    expect(CustomCategoryId.safeParse(`cat-${"a".repeat(60)}`).success).toBe(false);
  });

  test("rejects a missing prefix, upper case, a slash or a built-in name", () => {
    for (const bad of ["abcdefghij", "Cat-abcdefgh", "cat-ABCDEFGH", "cat-abc/defgh", "cat-abc defgh", "home", "photoshoot", ""]) {
      expect(CustomCategoryId.safeParse(bad).success).toBe(false);
    }
  });

  test("isCustomCategory tells a custom id from a built-in", () => {
    expect(isCustomCategory(CUSTOM_A)).toBe(true);
    for (const built of SceneCategory.options) expect(isCustomCategory(built)).toBe(false);
  });
});

describe("CategoryRef and PhotoCategory", () => {
  test("a ref is one of the five or a custom id", () => {
    for (const built of SceneCategory.options) expect(CategoryRef.safeParse(built).success).toBe(true);
    expect(CategoryRef.safeParse(CUSTOM_A).success).toBe(true);
    expect(CategoryRef.safeParse("own").success).toBe(false);
    expect(CategoryRef.safeParse("lingerie").success).toBe(false);
  });

  test("a photo's category also allows own, and nothing else", () => {
    expect(PhotoCategory.safeParse("own").success).toBe(true);
    expect(PhotoCategory.safeParse(CUSTOM_A).success).toBe(true);
    expect(PhotoCategory.safeParse("cat-short").success).toBe(false);
    expect(PhotoCategory.safeParse("unknown").success).toBe(false);
  });
});

describe("CategoryLabel and CategorySnapshot", () => {
  test("a label is 1 to 24 printable ASCII chars", () => {
    expect(CategoryLabel.safeParse("Paris cafes").success).toBe(true);
    expect(CategoryLabel.safeParse("a".repeat(CATEGORY_LABEL_MAX)).success).toBe(true);
    expect(CategoryLabel.safeParse("a".repeat(CATEGORY_LABEL_MAX + 1)).success).toBe(false);
    expect(CategoryLabel.safeParse("").success).toBe(false);
  });

  test("a label with a non-ASCII char, a control char or edge spaces is refused", () => {
    for (const bad of ["Кофейни", "café", "two\nlines", " leading", "trailing "]) expect(CategoryLabel.safeParse(bad).success).toBe(false);
  });

  test("a snapshot names the ref, the owner's name, the writer's label and the style, and nothing more", () => {
    const snapshot = { ref: CUSTOM_A, name: "Кофейни Парижа", label: "Paris cafes", style: "phone" };
    expect(CategorySnapshot.safeParse(snapshot).success).toBe(true);
    expect(CategorySnapshot.safeParse({ ...snapshot, style: "glossy" }).success).toBe(false);
    expect(CategorySnapshot.safeParse({ ...snapshot, extra: 1 }).success).toBe(false);
    expect(CategorySnapshot.safeParse({ ...snapshot, ref: "home" }).success).toBe(false);
    expect(CategorySnapshot.safeParse({ ...snapshot, name: "" }).success).toBe(false);
    expect(CategorySnapshot.safeParse({ ...snapshot, name: "я".repeat(41) }).success).toBe(false);
  });
});

describe("orderCategories", () => {
  test("puts the built-ins in canonical order whatever order they were given", () => {
    expect(orderCategories(["fit", "home", "glam", "travel", "shoot"])).toEqual(["home", "travel", "shoot", "glam", "fit"]);
  });

  test("puts the custom ones after the built-ins, in the order given", () => {
    expect(orderCategories([CUSTOM_B, "fit", CUSTOM_A, "home"])).toEqual(["home", "fit", CUSTOM_B, CUSTOM_A]);
  });

  test("keeps each category once", () => {
    expect(orderCategories(["home", CUSTOM_A, "home", CUSTOM_A])).toEqual(["home", CUSTOM_A]);
  });

  test("answers nothing for nothing", () => {
    expect(orderCategories([])).toEqual([]);
  });
});

describe("splitCount", () => {
  test("gives every category the same, the remainder one each to the earliest", () => {
    expect(splitCount(7, ["home", "travel", "shoot"])).toEqual([
      { ref: "home", count: 3 },
      { ref: "travel", count: 2 },
      { ref: "shoot", count: 2 },
    ]);
  });

  test("orders before it splits: the earliest in canonical order get the extra photos", () => {
    expect(splitCount(5, [CUSTOM_A, "fit", "home"])).toEqual([
      { ref: "home", count: 2 },
      { ref: "fit", count: 2 },
      { ref: CUSTOM_A, count: 1 },
    ]);
  });

  test("a count below the number of categories leaves the latest ones with none", () => {
    expect(splitCount(2, ["home", "travel", "shoot"]).map((e) => e.count)).toEqual([1, 1, 0]);
  });

  test("a count of zero gives every category none", () => {
    expect(splitCount(0, ["home", CUSTOM_A]).map((e) => e.count)).toEqual([0, 0]);
  });

  test("with no category there is nothing to split", () => {
    expect(splitCount(10, [])).toEqual([]);
  });

  test("always adds up to the count and never differs by more than one, for every count 1..100 and many category lists", () => {
    const lists: Ref[][] = [["home"], ["home", "fit"], [...SceneCategory.options], [CUSTOM_A], ["glam", CUSTOM_B, "home", CUSTOM_A], [...SceneCategory.options, CUSTOM_A, CUSTOM_B, CUSTOM_C]];
    for (const list of lists) {
      for (let count = 1; count <= 100; count++) {
        const split = splitCount(count, list);
        const counts = split.map((e) => e.count);
        expect(counts.reduce((a, b) => a + b, 0)).toBe(count);
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
        expect(counts).toEqual([...counts].sort((a, b) => b - a));
        expect(split.map((e) => e.ref)).toEqual(orderCategories(list));
      }
    }
  });
});

describe("RunRequest.categories (widened, protocol v5 open)", () => {
  const run = { avatarId: "avatar-0001", count: 20, poses: { profile: false, back: false } };

  test("accepts a custom category next to the built-ins", () => {
    expect(RunRequest.safeParse({ ...run, categories: ["home", CUSTOM_A] }).success).toBe(true);
    expect(RunRequest.safeParse({ ...run, categories: [CUSTOM_A] }).success).toBe(true);
  });

  test("still accepts every request made before custom categories existed", () => {
    expect(RunRequest.safeParse({ ...run, categories: [...SceneCategory.options] }).success).toBe(true);
  });

  test("refuses a repeated custom category", () => {
    expect(RunRequest.safeParse({ ...run, categories: [CUSTOM_A, CUSTOM_A] }).success).toBe(false);
  });

  test("refuses a malformed custom id and an unknown name", () => {
    expect(RunRequest.safeParse({ ...run, categories: ["cat-x"] }).success).toBe(false);
    expect(RunRequest.safeParse({ ...run, categories: ["own"] }).success).toBe(false);
  });

  test("allows 20 categories and refuses a 21st", () => {
    const custom = Array.from({ length: MAX_RUN_CATEGORIES }, (_, i) => `cat-custom-${String(i).padStart(3, "0")}`);
    expect(RunRequest.safeParse({ ...run, categories: custom }).success).toBe(true);
    expect(RunRequest.safeParse({ ...run, categories: [...custom, "cat-custom-999"] }).success).toBe(false);
  });
});

describe("PhotoSummary.category (widened)", () => {
  const photo = { photoId: "photo-0001", avatarId: "avatar-0001", runId: "run-0001", category: "home", createdAt: "2026-10-05T10:00:00.000Z", used: false, usedIn: [], rejected: false, reserved: false, eligible: true };

  test("still lists a photo of a built-in category without a label", () => {
    expect(PhotoSummary.safeParse(photo).success).toBe(true);
  });

  test("lists a custom-category photo with the label its sidecar carries", () => {
    const parsed = PhotoSummary.safeParse({ ...photo, category: CUSTOM_A, categoryName: "Кофейни Парижа" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.categoryName).toBe("Кофейни Парижа");
  });

  test("lists an own-scene photo", () => {
    expect(PhotoSummary.safeParse({ ...photo, category: "own", categoryName: "Своя сцена" }).success).toBe(true);
  });

  test("refuses a label on a built-in category: the renderer owns those names", () => {
    expect(PhotoSummary.safeParse({ ...photo, categoryName: "Дом" }).success).toBe(false);
  });

  test("refuses an unknown category string", () => {
    expect(PhotoSummary.safeParse({ ...photo, category: "lingerie" }).success).toBe(false);
  });

  test("refuses an empty or over-long label", () => {
    expect(PhotoSummary.safeParse({ ...photo, category: CUSTOM_A, categoryName: "" }).success).toBe(false);
    expect(PhotoSummary.safeParse({ ...photo, category: CUSTOM_A, categoryName: "я".repeat(41) }).success).toBe(false);
  });
});
