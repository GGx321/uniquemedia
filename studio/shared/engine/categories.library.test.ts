import { describe, expect, test } from "bun:test";
import {
  CATEGORY_DESCRIPTION_MAX,
  CategoriesListResult,
  CategoryBusy,
  CategoryDescription,
  categoryNameKey,
  CategoryInterrupted,
  CategoryPool,
  CategorySummary,
  MAX_CUSTOM_CATEGORIES,
  POOL_SHOTS,
  PoolShot,
} from "./categories";
import { CommandMessage, OkResponse } from "./commands";
import { ERROR_CODES, EngineError } from "./errors";
import { ERROR_MESSAGES_RU } from "./errorMessagesRu";
import { EventMessage } from "./events";

// CS.2: what the category library says on the contract. The pool a model writes is held to the same
// technical bounds the writer's prompt budget was measured with (PoolText, TimeOfDay, CategoryLabel),
// and the sheet reads everything it draws (spend, interrupted calls, the busy one) from these shapes.

const CATEGORY_ID = "cat-paris-cafes";

function place(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "a corner cafe",
    times: ["morning", "midday"],
    activities: [
      { text: "reading a menu", twoHanded: false },
      { text: "stirring a cappuccino", twoHanded: true },
    ],
    mirror: false,
    ...over,
  };
}

function pool(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => place({ name, mirror: i === 2 })),
    outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"],
    shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
    ...over,
  };
}

function summary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    categoryId: CATEGORY_ID,
    name: "Кофейни Парижа",
    description: "Парижские кофейни и улочки вокруг них",
    label: "Paris cafes",
    style: "phone",
    pool: pool(),
    model: "x-ai/grok-4.3",
    spentMicros: 5_000,
    createdAt: "2026-10-05T12:00:00.000Z",
    updatedAt: "2026-10-05T12:00:00.000Z",
    ...over,
  };
}

describe("CategoryDescription", () => {
  test("accepts 1 to 500 chars of any script", () => {
    expect(CategoryDescription.safeParse("a").success).toBe(true);
    expect(CategoryDescription.safeParse("Парижские кофейни 咖啡").success).toBe(true);
    expect(CategoryDescription.safeParse("x".repeat(CATEGORY_DESCRIPTION_MAX)).success).toBe(true);
  });

  test("refuses an empty text, a blank one and one char over 500", () => {
    expect(CategoryDescription.safeParse("").success).toBe(false);
    expect(CategoryDescription.safeParse("   ").success).toBe(false);
    expect(CategoryDescription.safeParse("x".repeat(CATEGORY_DESCRIPTION_MAX + 1)).success).toBe(false);
  });

  test("allows a line break (the field is a text area) but no other control or invisible char", () => {
    expect(CategoryDescription.safeParse("cafes\nand bookshops").success).toBe(true);
    expect(CategoryDescription.safeParse("cafes\tbookshops").success).toBe(false);
    expect(CategoryDescription.safeParse("cafes‮bookshops").success).toBe(false);
    expect(CategoryDescription.safeParse("cafes bookshops").success).toBe(false);
  });
});

describe("categoryNameKey", () => {
  test("two names are the same name when they are the same after trim, Unicode normalisation and a case fold", () => {
    expect(categoryNameKey("  Paris Cafes ")).toBe(categoryNameKey("paris cafes"));
    expect(categoryNameKey("Кофейни Парижа")).toBe(categoryNameKey("кофейни парижа"));
    expect(categoryNameKey("café")).toBe(categoryNameKey("café"));
  });

  test("different names differ, and inner spaces count", () => {
    expect(categoryNameKey("Paris cafes")).not.toBe(categoryNameKey("Paris  cafes"));
    expect(categoryNameKey("Paris cafes")).not.toBe(categoryNameKey("Paris bakeries"));
  });
});

describe("CategoryPool", () => {
  test("accepts a pool with 5 places, 3 outfits and a deck of 5", () => {
    expect(CategoryPool.safeParse(pool()).success).toBe(true);
  });

  test("accepts the largest pool: 7 places of 3 times and 4 activities, 6 outfits", () => {
    const big = place({
      times: ["morning", "midday", "evening"],
      activities: [1, 2, 3, 4].map((n) => ({ text: `activity number ${n}`, twoHanded: n > 1 })),
    });
    const locations = Array.from({ length: 7 }, (_, i) => ({ ...big, name: `place ${i}`, mirror: i === 0 }));
    const outfits = Array.from({ length: 6 }, (_, i) => `outfit ${i}`);
    expect(CategoryPool.safeParse(pool({ locations, outfits })).success).toBe(true);
  });

  test.each(["morning", "midday", "golden hour", "evening", "night", "studio lighting"])("accepts the time of day «%s» from the plan's vocabulary", (time) => {
    expect(CategoryPool.safeParse(pool({ locations: [place({ times: [time], mirror: true }), ...(pool().locations as unknown[]).slice(1)] })).success).toBe(true);
  });

  test.each(["dawn", "after school", "teen hangout", "Morning", "golden  hour"])("refuses the time of day «%s», which is plain text but not in the vocabulary", (time) => {
    const locations = [place({ times: ["morning", time], mirror: true }), ...(pool().locations as unknown[]).slice(1)];
    expect(CategoryPool.safeParse(pool({ locations })).success).toBe(false);
  });

  test.each([
    ["4 places", pool({ locations: (pool().locations as unknown[]).slice(0, 4) })],
    ["8 places", pool({ locations: Array.from({ length: 8 }, (_, i) => place({ name: `place ${i}` })) })],
    ["2 outfits", pool({ outfits: ["a", "b"] })],
    ["7 outfits", pool({ outfits: Array.from({ length: 7 }, (_, i) => `outfit ${i}`) })],
    ["a deck of 4", pool({ shotDeck: ["friend", "friend", "selfie", "candid"] })],
    ["a deck of 6", pool({ shotDeck: ["friend", "friend", "selfie", "candid", "candid", "friend"] })],
    ["a shot nobody takes", pool({ shotDeck: ["friend", "friend", "selfie", "drone", "candid"] })],
  ])("refuses %s", (_name, bad) => {
    expect(CategoryPool.safeParse(bad).success).toBe(false);
  });

  test.each([
    ["no time", place({ times: [] })],
    ["4 times", place({ times: ["morning", "midday", "evening", "night"] })],
    ["a time over 15 chars", place({ times: ["a very long time of day"] })],
    ["1 activity", place({ activities: [{ text: "reading a menu", twoHanded: false }] })],
    ["5 activities", place({ activities: Array.from({ length: 5 }, (_, i) => ({ text: `activity ${i}`, twoHanded: false })) })],
    ["only two-handed activities", place({ activities: [{ text: "kneading dough", twoHanded: true }, { text: "peeling apples", twoHanded: true }] })],
    ["a place name over 35 chars", place({ name: "a".repeat(36) })],
    ["a place name with a quote", place({ name: 'a "quiet" cafe' })],
    ["an activity with a backslash", place({ activities: [{ text: "reading a menu", twoHanded: false }, { text: "tracing a\\path", twoHanded: false }] })],
    ["a non-ASCII place name", place({ name: "a café" })],
  ])("refuses a place with %s", (_name, bad) => {
    const locations = [bad, ...(pool().locations as unknown[]).slice(1)];
    expect(CategoryPool.safeParse(pool({ locations })).success).toBe(false);
  });

  test("refuses an outfit over 35 chars or with a quote", () => {
    expect(CategoryPool.safeParse(pool({ outfits: ["a".repeat(36), "b", "c"] })).success).toBe(false);
    expect(CategoryPool.safeParse(pool({ outfits: ['a "red" coat', "b", "c"] })).success).toBe(false);
  });

  test("refuses a deck that can draw a mirror shot when no place has a mirror", () => {
    const locations = (pool().locations as Record<string, unknown>[]).map((l) => ({ ...l, mirror: false }));
    expect(CategoryPool.safeParse(pool({ locations })).success).toBe(false);
  });

  test("accepts a deck with no mirror shot and no mirror place", () => {
    const locations = (pool().locations as Record<string, unknown>[]).map((l) => ({ ...l, mirror: false }));
    expect(CategoryPool.safeParse(pool({ locations, shotDeck: ["friend", "friend", "selfie", "candid", "candid"] })).success).toBe(true);
  });

  test("refuses a key the contract does not know", () => {
    expect(CategoryPool.safeParse({ ...pool(), extra: 1 }).success).toBe(false);
  });
});

describe("POOL_SHOTS", () => {
  test("lists the five shots a pool's deck may hold", () => {
    expect([...POOL_SHOTS]).toEqual(["friend", "selfie", "mirror", "candid", "photographer"]);
    expect(PoolShot.safeParse("drone").success).toBe(false);
    expect(PoolShot.safeParse("photographer").success).toBe(true);
  });
});

describe("CategorySummary", () => {
  test("accepts a stored category with its pool, its model and what it has cost", () => {
    expect(CategorySummary.safeParse(summary()).success).toBe(true);
  });

  test.each([
    ["an id that is not a custom one", { categoryId: "home" }],
    ["a blank name", { name: "  " }],
    ["a name over 40 chars", { name: "n".repeat(41) }],
    ["a label over 24 chars", { label: "l".repeat(25) }],
    ["a label with a quote", { label: 'Paris "cafes"' }],
    ["a style nobody knows", { style: "glossy" }],
    ["a negative spend", { spentMicros: -1 }],
    ["a fractional spend", { spentMicros: 0.5 }],
    ["a model that is not vendor/model", { model: "grok" }],
    ["a time that is not a time", { createdAt: "yesterday" }],
    ["a key it does not know", { secret: 1 }],
  ])("refuses %s", (_name, over) => {
    expect(CategorySummary.safeParse(summary(over)).success).toBe(false);
  });
});

describe("CategoryInterrupted and CategoryBusy", () => {
  const interrupted = { jobId: "job-00000001", kind: "create", name: "Кофейни Парижа", description: "кофейни", categoryId: null, startedAt: "2026-10-05T12:00:00.000Z", spentMicros: 22_500 };

  test("an interrupted create carries no category id, an interrupted regenerate names its category", () => {
    expect(CategoryInterrupted.safeParse(interrupted).success).toBe(true);
    expect(CategoryInterrupted.safeParse({ ...interrupted, kind: "regenerate", categoryId: CATEGORY_ID }).success).toBe(true);
  });

  test("refuses a regenerate with no category id, a create with one, and a kind nobody knows", () => {
    expect(CategoryInterrupted.safeParse({ ...interrupted, kind: "regenerate" }).success).toBe(false);
    expect(CategoryInterrupted.safeParse({ ...interrupted, categoryId: CATEGORY_ID }).success).toBe(false);
    expect(CategoryInterrupted.safeParse({ ...interrupted, kind: "rename" }).success).toBe(false);
  });

  test("busy names what is being composed right now", () => {
    expect(CategoryBusy.safeParse({ kind: "create", name: "Горы зимой", categoryId: null }).success).toBe(true);
    expect(CategoryBusy.safeParse({ kind: "regenerate", name: "Горы зимой", categoryId: CATEGORY_ID }).success).toBe(true);
    expect(CategoryBusy.safeParse({ kind: "regenerate", name: "Горы зимой", categoryId: null }).success).toBe(false);
  });
});

describe("categories.* commands", () => {
  const command = (type: string, payload: unknown) => CommandMessage.safeParse({ v: 5, id: "msg-000001", kind: "command", type, payload });
  const answer = (type: string, result: unknown) => OkResponse.safeParse({ v: 5, id: "msg-000001", kind: "response", type, ok: true, result });
  const estimate = { expectedMicros: 6_000, worstMicros: 45_000, prices: "fallback", pricesAsOf: "2026-10-05" };

  test("categories.list answers the categories, the unreadable count, the interrupted calls and the busy one", () => {
    expect(command("categories.list", {}).success).toBe(true);
    expect(answer("categories.list", { categories: [summary()], unreadable: 1, interrupted: [], busy: null }).success).toBe(true);
  });

  test("categories.list holds at most 50 categories", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => summary({ categoryId: `cat-category-${String(i).padStart(3, "0")}` }));
    expect(answer("categories.list", { categories: many(MAX_CUSTOM_CATEGORIES), unreadable: 0, interrupted: [], busy: null }).success).toBe(true);
    expect(answer("categories.list", { categories: many(MAX_CUSTOM_CATEGORIES + 1), unreadable: 0, interrupted: [], busy: null }).success).toBe(false);
  });

  test("the list result schema is the one the answer uses", () => {
    expect(CategoriesListResult.safeParse({ categories: [], unreadable: 0, interrupted: [], busy: null }).success).toBe(true);
    expect(CategoriesListResult.safeParse({ categories: [], unreadable: 0 }).success).toBe(false);
  });

  test("categories.estimate takes nothing and answers an estimate", () => {
    expect(command("categories.estimate", {}).success).toBe(true);
    expect(answer("categories.estimate", estimate).success).toBe(true);
  });

  test("categories.create takes a name, a description and the accepted worst case, and answers the category with what the call spent", () => {
    expect(command("categories.create", { name: "Кофейни Парижа", description: "кофейни", acceptedWorstMicros: 45_000 }).success).toBe(true);
    expect(answer("categories.create", { category: summary(), spentMicros: 5_000 }).success).toBe(true);
  });

  test.each([
    ["no accepted worst case", { name: "n", description: "d" }],
    ["a blank name", { name: " ", description: "d", acceptedWorstMicros: 1 }],
    ["an empty description", { name: "n", description: "", acceptedWorstMicros: 1 }],
    ["a fractional accepted worst case", { name: "n", description: "d", acceptedWorstMicros: 1.5 }],
  ])("categories.create refuses %s", (_name, payload) => {
    expect(command("categories.create", payload).success).toBe(false);
  });

  test("categories.regenerate takes the category and a new description", () => {
    expect(command("categories.regenerate", { categoryId: CATEGORY_ID, description: "новое", acceptedWorstMicros: 45_000 }).success).toBe(true);
    expect(command("categories.regenerate", { categoryId: "home", description: "новое", acceptedWorstMicros: 45_000 }).success).toBe(false);
    expect(answer("categories.regenerate", { category: summary(), spentMicros: 6_000 }).success).toBe(true);
  });

  test("categories.update takes a new name, places to remove and outfits to remove, and at least one of them", () => {
    expect(command("categories.update", { categoryId: CATEGORY_ID, name: "Новое имя" }).success).toBe(true);
    expect(command("categories.update", { categoryId: CATEGORY_ID, removeLocations: ["a bookshop"] }).success).toBe(true);
    expect(command("categories.update", { categoryId: CATEGORY_ID, removeOutfits: ["a black midi dress"] }).success).toBe(true);
    expect(command("categories.update", { categoryId: CATEGORY_ID }).success).toBe(false);
    expect(command("categories.update", { categoryId: CATEGORY_ID, removeLocations: [], removeOutfits: [] }).success).toBe(false);
    expect(command("categories.update", { categoryId: CATEGORY_ID, name: "  " }).success).toBe(false);
    expect(answer("categories.update", { category: summary() }).success).toBe(true);
  });

  test("categories.delete and categories.dismissInterrupted name what they remove", () => {
    expect(command("categories.delete", { categoryId: CATEGORY_ID }).success).toBe(true);
    expect(answer("categories.delete", { categoryId: CATEGORY_ID }).success).toBe(true);
    expect(command("categories.dismissInterrupted", { jobId: "job-00000001" }).success).toBe(true);
    expect(answer("categories.dismissInterrupted", { jobId: "job-00000001" }).success).toBe(true);
  });
});

describe("category.changed", () => {
  const event = (payload: unknown) => EventMessage.safeParse({ v: 5, id: "msg-000001", kind: "event", seq: 1, bootId: "boot-0000-aaaa", type: "category.changed", payload });

  test("carries an upserted category or the id of a removed one", () => {
    expect(event({ change: "upserted", category: summary() }).success).toBe(true);
    expect(event({ change: "removed", categoryId: CATEGORY_ID }).success).toBe(true);
    expect(event({ change: "removed" }).success).toBe(false);
  });
});

describe("POOL_REJECTED and what a failed paid call spent", () => {
  test("POOL_REJECTED is an error code with a Russian text of its own", () => {
    expect([...ERROR_CODES]).toContain("POOL_REJECTED");
    expect(ERROR_MESSAGES_RU.POOL_REJECTED).toBe("Модель дважды вернула неподходящий набор — переформулируйте описание.");
  });

  test("an error may carry what the call spent before it failed", () => {
    expect(EngineError.safeParse({ code: "POOL_REJECTED", spentMicros: 11_000 }).success).toBe(true);
    expect(EngineError.safeParse({ code: "POOL_REJECTED", spentMicros: -1 }).success).toBe(false);
    expect(EngineError.safeParse({ code: "POOL_REJECTED", spentMicros: 0.5 }).success).toBe(false);
  });
});
