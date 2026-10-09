import { describe, expect, test } from "bun:test";
import { SceneSetFile } from "../library/sceneSets";
import { plannerCategoryOf, POOLS } from "../scenes";
import { planSceneSet, type ComposeInput } from "./compose";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S4.5a (plan §3.4, §5.3): a launch composes a set with an explicit per-category split instead of the planner's even one, and stamps it with its id.

const LAUNCH = "launch-0a1b2c3d4e5f";

function input(over: Partial<ComposeInput> = {}): ComposeInput {
  return {
    sceneSetId: "set-aaaa-0001",
    avatarId: "avatar-aaaa-0001",
    runId: "run-aaaa-0001",
    jobId: "job-aaaa-0001",
    count: 10,
    categories: ["home", "travel"],
    poses: { profile: false, back: false },
    pools: { ...POOLS },
    snapshots: [],
    recentPairs: [],
    textModel: "x-ai/grok-4.3",
    ...over,
  };
}

const countOf = (set: ReturnType<typeof planSceneSet>, ref: "home" | "travel" | "glam") => set.scenes.filter((s) => s.slot.category === plannerCategoryOf(ref)).length;

describe("planSceneSet with an explicit split", () => {
  test("gives each category exactly the count the split names, not the even split", () => {
    const set = planSceneSet(input({ count: 10, split: [{ ref: "home", count: 7 }, { ref: "travel", count: 3 }] }));

    expect(countOf(set, "home")).toBe(7);
    expect(countOf(set, "travel")).toBe(3);
    expect(set.scenes).toHaveLength(10);
  });

  test("gives a category whose count is 0 no scene", () => {
    const set = planSceneSet(input({ count: 5, categories: ["home", "travel"], split: [{ ref: "home", count: 5 }, { ref: "travel", count: 0 }] }));

    expect(countOf(set, "home")).toBe(5);
    expect(countOf(set, "travel")).toBe(0);
  });

  test("numbers the scenes from 1 in the canonical category order whatever order the split lists them", () => {
    const set = planSceneSet(input({ count: 4, split: [{ ref: "travel", count: 1 }, { ref: "home", count: 3 }] }));

    expect(set.scenes.map((s) => s.sceneId)).toEqual([1, 2, 3, 4]);
    expect(set.scenes.slice(0, 3).every((s) => s.slot.category === plannerCategoryOf("home"))).toBe(true);
    expect(set.scenes[3]?.slot.category).toBe(plannerCategoryOf("travel"));
  });

  test("plans the same scenes for the same split and set id", () => {
    const split = [{ ref: "home" as const, count: 6 }, { ref: "travel" as const, count: 4 }];
    expect(planSceneSet(input({ split }))).toEqual(planSceneSet(input({ split })));
  });

  test("refuses a split whose counts do not add up to the count", () => {
    expect(() => planSceneSet(input({ count: 10, split: [{ ref: "home", count: 7 }, { ref: "travel", count: 2 }] }))).toThrow(RangeError);
  });

  test("refuses a split that names a category twice", () => {
    expect(() => planSceneSet(input({ count: 6, split: [{ ref: "home", count: 3 }, { ref: "home", count: 3 }] }))).toThrow(RangeError);
  });

  test("refuses a split that names a category the set was not asked to use", () => {
    expect(() => planSceneSet(input({ count: 6, categories: ["home"], split: [{ ref: "home", count: 3 }, { ref: "travel", count: 3 }] }))).toThrow(RangeError);
  });

  test("keeps the even split when no split is given", () => {
    const set = planSceneSet(input({ count: 10 }));
    expect(countOf(set, "home")).toBe(5);
    expect(countOf(set, "travel")).toBe(5);
  });
});

describe("planSceneSet with a launch id", () => {
  test("stamps the set with the launch and the set still fits its schema", () => {
    const set = planSceneSet(input({ launchId: LAUNCH }));

    expect(set.launchId).toBe(LAUNCH);
    expect(SceneSetFile.safeParse({ schemaVersion: 1, createdAt: "2026-10-07T12:00:00.000Z", updatedAt: "2026-10-07T12:00:00.000Z", revision: 1, ...set }).success).toBe(true);
  });

  test("leaves a set of the owner's own without the field", () => {
    expect("launchId" in planSceneSet(input())).toBe(false);
  });
});
