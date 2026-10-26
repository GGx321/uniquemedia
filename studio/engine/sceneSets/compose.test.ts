import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { orderCategories, splitCount, type CategoryRef } from "../../shared/engine";
import { SceneSetFile } from "../library/sceneSets";
import { planWithPools, plannerCategoryOf, POOLS, type Pool } from "../scenes";
import { planSceneSet, seedOfSet, type ComposeInput } from "./compose";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: a compose plans the set with the same planner a run uses, issues the set's run id and every writer chunk's attempt ids, and records the first
// write — all of it in the set that is written BEFORE the first call.

const CUSTOM = "cat-paris-cafes" as const;

const CAFE_POOL: Pool = {
  locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => ({
    name,
    times: ["morning", "midday"],
    activities: [
      { text: "reading a menu", twoHanded: false },
      { text: "stirring a cappuccino", twoHanded: true },
    ],
    ...(i === 2 ? { mirror: true as const } : {}),
  })),
  outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"],
  shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
};

function input(over: Partial<ComposeInput> = {}): ComposeInput {
  return {
    sceneSetId: "set-aaaa-0001",
    avatarId: "avatar-aaaa-0001",
    runId: "run-aaaa-0001",
    jobId: "job-aaaa-0001",
    count: 20,
    categories: ["home", "travel"],
    poses: { profile: false, back: false },
    pools: { ...POOLS },
    snapshots: [],
    recentPairs: [],
    textModel: "x-ai/grok-4.3",
    ...over,
  };
}

describe("planSceneSet", () => {
  test("plans `count` scenes, numbered from 1, with no sentence yet and none removed", () => {
    const set = planSceneSet(input({ count: 20 }));
    expect(set.scenes).toHaveLength(20);
    expect(set.scenes.map((s) => s.sceneId)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(set.scenes.every((s) => s.origin === "planned" && s.text === null && !s.edited && !s.removed && s.slot.slotIndex === s.sceneId)).toBe(true);
  });

  test("splits the scenes over the categories as a run does: the shared even split, the remainder to the earliest", () => {
    const refs: CategoryRef[] = ["glam", "home", "travel"];
    const set = planSceneSet(input({ count: 20, categories: refs }));
    const counts = splitCount(20, refs).map(({ ref }) => set.scenes.filter((s) => s.slot.category === plannerCategoryOf(ref)).length);
    expect(counts).toEqual(splitCount(20, refs).map((x) => x.count));
    expect(orderCategories(refs)).toEqual(["home", "travel", "glam"]);
  });

  test("draws with the planner on the seed of the set's id, steering clear of the avatar's recent pairs", () => {
    const recent = [{ location: "a kitchen", outfit: "a linen shirt" }];
    const set = planSceneSet(input({ recentPairs: recent }));
    const direct = planWithPools({ seed: seedOfSet("set-aaaa-0001"), count: 20, categories: ["home", "travel"], excludePairs: recent }, POOLS);
    expect(set.scenes.map((s) => s.slot)).toEqual(direct.slots);
  });

  // 5a.2 (S5.6b): a history line's moment reaches the planner, so a set steers away from the avatar's recent (place, moment) pairs too.
  test("hands the recent pairs' moments to the planner", () => {
    const first = planSceneSet(input({ count: 1, categories: ["travel"] })).scenes[0]?.slot;
    if (first === undefined) throw new Error("no scene");
    const recent = [{ location: first.location, outfit: first.outfit, activity: first.activity }];
    const again = planSceneSet(input({ count: 1, categories: ["travel"], recentPairs: recent })).scenes[0]?.slot;
    expect(again && [again.location, again.activity]).not.toEqual([first.location, first.activity]);
  });

  test("the seed is fixed by the set's id: the first 8 hex digits of its sha256", () => {
    const expected = Number.parseInt(createHash("sha256").update("set-aaaa-0001").digest("hex").slice(0, 8), 16);
    expect(seedOfSet("set-aaaa-0001")).toBe(expected);
  });

  test("the same input plans the same set, another set id another one", () => {
    expect(planSceneSet(input())).toEqual(planSceneSet(input()));
    expect(planSceneSet(input({ sceneSetId: "set-aaaa-0002" })).scenes.map((s) => s.slot)).not.toEqual(planSceneSet(input()).scenes.map((s) => s.slot));
  });

  test("ignores the request's poses for the angle: toggles on plan the scenes toggles off do, and a category holds at most a fifth of them facing away (S5.7b)", () => {
    const off = planSceneSet(input({ count: 60, categories: ["home"], poses: { profile: false, back: false } }));
    const on = planSceneSet(input({ count: 60, categories: ["home"], poses: { profile: true, back: true } }));
    expect(on.scenes).toEqual(off.scenes);
    expect(on.scenes.filter((s) => s.slot.pose === "profile" || s.slot.pose === "back").length).toBeLessThanOrEqual(12);
  });

  test("keeps the run id issued for the set, and the request as it was made", () => {
    const set = planSceneSet(input({ runId: "run-zzzz-0009" }));
    expect(set.runId).toBe("run-zzzz-0009");
    expect(set.request).toEqual({ count: 20, categories: ["home", "travel"], poses: { profile: false, back: false } });
    expect(set.models).toEqual({ text: "x-ai/grok-4.3" });
  });

  // S5.7a: the request's `poses` and `level` are optional and stored as given; the view echoes them by the rule in view.test.ts. `level` draws nothing yet.
  test("a request without poses stores none, and plans as a request with neither extra pose does", () => {
    const { poses: _poses, ...bare } = input({ count: 40 });
    const set = planSceneSet(bare);
    expect("poses" in set.request).toBe(false);
    expect(set.scenes).toEqual(planSceneSet(input({ count: 40 })).scenes);
  });

  test("a flirty level is stored on the request and draws the planner's mix: round(0.6 × n) flirty scenes in each built-in category", () => {
    const flirty = planSceneSet(input({ count: 40, level: "flirty" }));
    expect(flirty.request.level).toBe("flirty");
    for (const category of ["home", "travel"]) expect(flirty.scenes.filter((s) => s.slot.category === category && s.slot.level === "flirty")).toHaveLength(12);
    expect(flirty.scenes.map((s) => s.slot)).toEqual(planWithPools({ seed: seedOfSet("set-aaaa-0001"), count: 40, categories: ["home", "travel"], level: "flirty" }, POOLS).slots);
  });

  // 5a.3 (S5.9a): «Смелая» is stored as asked (the set is a «Смелая» set).
  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 I5.71, §7.4): the five ordinary built-ins no longer draw the flirty mix at «Смелая»: every scene is planned from the category's companion, on the route, with
  // the request's tiers counted over the whole request. The «Кокетливая» half of the old assertion is the test above, which keeps its flirty counts.
  test("a bold level is stored on the request, and the five ordinary built-ins draw their companions on the route, 40 / 40 / 20", () => {
    const bold = planSceneSet(input({ count: 40, level: "bold" }));
    expect(bold.request.level).toBe("bold");
    expect(bold.scenes.every((s) => s.slot.route === "seedream")).toBe(true);
    expect(bold.scenes.filter((s) => s.slot.level === "bold")).toHaveLength(16);
    expect(bold.scenes.filter((s) => s.slot.level === "flirty")).toHaveLength(16);
    expect(bold.scenes.map((s) => s.slot)).toEqual(planWithPools({ seed: seedOfSet("set-aaaa-0001"), count: 40, categories: ["home", "travel"], level: "bold" }, POOLS).slots);
  });

  // 5a.4 (S5.BA3): the avatar's origin rides on the compose, default false.
  test("an imported avatar's compose holds no implied cover and a Studio-created avatar's may", () => {
    const implied = (impliedNudity?: boolean): number =>
      Array.from({ length: 60 }, (_, i) => planSceneSet(input({ sceneSetId: `set-aaaa-${String(i).padStart(4, "0")}`, count: 30, level: "bold", categories: ["home", "travel", "glam", "fit", "nightwear"], ...(impliedNudity === undefined ? {} : { impliedNudity }) })))
        .flatMap((set) => set.scenes)
        .filter((s) => /^only /.test(s.slot.outfit)).length;
    expect(implied()).toBe(0);
    expect(implied(false)).toBe(0);
    expect(implied(true)).toBeGreaterThan(0);
  });

  // 5a.3 (S5.9c): a «Смелая» compose of the two «Смелая» categories draws the 20 / 40 / 40 mix, and a set keeps every scene's level and route through the file.
  test("a bold compose of the «Смелая» categories holds the mix of each, and the file keeps every scene's level and route", () => {
    const set = planSceneSet(input({ count: 30, categories: ["nightwear", "beach"], level: "bold" }));
    for (const category of ["nightwear", "beach"]) {
      const own = set.scenes.filter((s) => s.slot.category === category);
      expect(own).toHaveLength(15);
      expect(own.filter((s) => s.slot.level === "bold")).toHaveLength(6);
      expect(own.filter((s) => s.slot.level === "flirty")).toHaveLength(6);
      expect(own.filter((s) => s.slot.level === undefined)).toHaveLength(3);
    }
    const parsed = SceneSetFile.parse({ schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...set });
    expect(parsed.scenes.map((s) => (s.origin === "planned" ? s.slot : null))).toEqual(set.scenes.map((s) => s.slot));
    expect(parsed.scenes.some((s) => s.origin === "planned" && s.slot.route === "seedream")).toBe(true);
    expect(parsed.request.level).toBe("bold");
  });

  test("an ordinary compose plans no flirty scene", () => {
    expect(planSceneSet(input({ count: 40 })).scenes.some((s) => s.slot.level !== undefined)).toBe(false);
  });

  test("a request with no level stores none", () => {
    expect("level" in planSceneSet(input()).request).toBe(false);
  });

  test("a set stored without poses is one the store accepts", () => {
    const { poses: _poses, ...bare } = input({ count: 5, level: "flirty" });
    const parsed = SceneSetFile.safeParse({ schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...planSceneSet(bare) });
    expect(parsed.success).toBe(true);
  });

  test("issues every writer chunk's attempt ids in the set, in chunks of 25: two answered attempts plus two spares each", () => {
    const set = planSceneSet(input({ count: 60 }));
    expect(set.chunks.map((c) => c.sceneIds.length)).toEqual([25, 25, 10]);
    expect(set.chunks.map((c) => c.chunk)).toEqual([1, 2, 3]);
    expect(set.chunks[1]?.attemptIds).toEqual(["set-aaaa-0001:writer-2#1", "set-aaaa-0001:writer-2#2", "set-aaaa-0001:writer-2#3", "set-aaaa-0001:writer-2#4"]);
    expect(set.chunks.flatMap((c) => c.sceneIds)).toEqual(set.scenes.map((s) => s.sceneId));
  });

  test("records the compose as write 1 under the job that will run it", () => {
    const set = planSceneSet(input({ jobId: "job-zzzz-0007" }));
    expect(set.write).toEqual({ k: 1, kind: "compose", jobId: "job-zzzz-0007" });
    expect(set.writes).toBe(1);
  });

  test("an empty set has no scene, no chunk and no write", () => {
    const set = planSceneSet(input({ count: 0, categories: [] }));
    expect(set).toMatchObject({ scenes: [], chunks: [], write: null, writes: 0 });
  });

  test("a custom category draws from its own pool and the set keeps a snapshot of it", () => {
    const snapshot = { ref: CUSTOM, name: "Кофейни Парижа", label: "Paris cafes", style: "phone" as const };
    const set = planSceneSet(input({ count: 10, categories: [CUSTOM], pools: { ...POOLS, [CUSTOM]: CAFE_POOL }, snapshots: [snapshot] }));
    expect(set.scenes.every((s) => s.slot.category === CUSTOM)).toBe(true);
    expect(set.scenes.every((s) => CAFE_POOL.locations.some((l) => l.name === s.slot.location))).toBe(true);
    expect(set.categories).toEqual([snapshot]);
  });

  test("a built-in-only set has no snapshot key, as a built-in run's plan has none", () => {
    expect("categories" in planSceneSet(input())).toBe(false);
  });

  test("what it plans is a set the store accepts", () => {
    const parsed = SceneSetFile.safeParse({ schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...planSceneSet(input({ count: 60 })) });
    expect(parsed.success).toBe(true);
  });
});
