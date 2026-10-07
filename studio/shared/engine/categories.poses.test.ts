import { describe, expect, test } from "bun:test";
import { CategoryPool, CategorySnapshot, CategorySummary, ScenePose } from "./categories";
import { CommandMessage } from "./commands";

// CS.8a: the angles a custom category's description asks for ride on its pool (`CategoryPool.poses`, additive in protocol v5) and on the snapshot a plan keeps.
// The vocabulary is the shared ScenePose one (front, three-quarter, profile, back); absent means «no preference» and is what every record written before CS.8a has.

const CATEGORY_ID = "cat-paris-cafes";

function place(name: string, mirror: boolean): Record<string, unknown> {
  return {
    name,
    times: ["morning", "midday"],
    activities: [
      { text: "lying on her stomach, texting", twoHanded: false },
      { text: "stirring a cappuccino", twoHanded: true },
    ],
    mirror,
  };
}

function pool(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => place(name, i === 2)),
    outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"],
    shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
    ...over,
  };
}

const snapshot = { ref: CATEGORY_ID, name: "Кофейни", label: "Paris cafes", style: "phone" };

function command(type: string, payload: unknown): ReturnType<typeof CommandMessage.safeParse> {
  return CommandMessage.safeParse({ v: 5, kind: "command", id: "msg-000001", type, payload });
}

describe("ScenePose lives in the categories module", () => {
  test("is the four-value vocabulary the planner, the writer and the face gate share", () => {
    expect(ScenePose.options).toEqual(["front", "three-quarter", "profile", "back"]);
  });
});

describe("CategoryPool.poses", () => {
  test("a pool with no poses still parses and stays without the key", () => {
    const parsed = CategoryPool.safeParse(pool());
    expect(parsed.success).toBe(true);
    expect(parsed.success && "poses" in parsed.data).toBe(false);
  });

  test("a pool carries one to four distinct poses", () => {
    expect(CategoryPool.safeParse(pool({ poses: ["back"] })).success).toBe(true);
    expect(CategoryPool.safeParse(pool({ poses: ["front", "three-quarter", "profile", "back"] })).success).toBe(true);
  });

  test.each([
    ["an empty list", []],
    ["a repeated pose", ["back", "back"]],
    ["a value outside the vocabulary", ["upside-down"]],
    ["five entries", ["front", "three-quarter", "profile", "back", "front"]],
    ["null", null],
  ])("a pool refuses poses that are %s", (_name, poses) => {
    expect(CategoryPool.safeParse(pool({ poses })).success).toBe(false);
  });
});

describe("CategorySnapshot.poses", () => {
  test("a snapshot without poses parses (every plan written before CS.8a)", () => {
    expect(CategorySnapshot.safeParse(snapshot).success).toBe(true);
  });

  test("a snapshot carries the category's poses under the same bounds", () => {
    expect(CategorySnapshot.safeParse({ ...snapshot, poses: ["back", "profile"] }).success).toBe(true);
    expect(CategorySnapshot.safeParse({ ...snapshot, poses: [] }).success).toBe(false);
    expect(CategorySnapshot.safeParse({ ...snapshot, poses: ["back", "back"] }).success).toBe(false);
  });
});

describe("CategorySummary", () => {
  test("shows the poses through its pool", () => {
    const summary = {
      categoryId: CATEGORY_ID,
      name: "Кофейни",
      description: "Лежит на животе. Вид сзади",
      label: "Paris cafes",
      style: "phone",
      pool: pool({ poses: ["back"] }),
      model: "x-ai/grok-4.3",
      spentMicros: 5_000,
      createdAt: "2026-10-07T12:00:00.000Z",
      updatedAt: "2026-10-07T12:00:00.000Z",
    };
    const parsed = CategorySummary.safeParse(summary);
    expect(parsed.success && parsed.data.pool.poses).toEqual(["back"]);
  });
});

describe("categories.update with poses", () => {
  test("sets a category's poses as a change of its own", () => {
    expect(command("categories.update", { categoryId: CATEGORY_ID, poses: ["back", "profile"] }).success).toBe(true);
  });

  test("clears a category's poses with null", () => {
    expect(command("categories.update", { categoryId: CATEGORY_ID, poses: null }).success).toBe(true);
  });

  test("refuses an empty list, a repeat and a value outside the vocabulary", () => {
    for (const poses of [[], ["back", "back"], ["sideways"]]) expect(command("categories.update", { categoryId: CATEGORY_ID, poses }).success).toBe(false);
  });

  test("still needs one change: an update naming nothing is refused", () => {
    expect(command("categories.update", { categoryId: CATEGORY_ID }).success).toBe(false);
  });
});
