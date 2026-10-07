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
    const direct = planWithPools({ seed: seedOfSet("set-aaaa-0001"), count: 20, categories: ["home", "travel"], excludePairs: recent, poses: { profile: false, back: false } }, POOLS);
    expect(set.scenes.map((s) => s.slot)).toEqual(direct.slots);
  });

  test("the seed is fixed by the set's id: the first 8 hex digits of its sha256", () => {
    const expected = Number.parseInt(createHash("sha256").update("set-aaaa-0001").digest("hex").slice(0, 8), 16);
    expect(seedOfSet("set-aaaa-0001")).toBe(expected);
  });

  test("the same input plans the same set, another set id another one", () => {
    expect(planSceneSet(input())).toEqual(planSceneSet(input()));
    expect(planSceneSet(input({ sceneSetId: "set-aaaa-0002" })).scenes.map((s) => s.slot)).not.toEqual(planSceneSet(input()).scenes.map((s) => s.slot));
  });

  test("allows the poses the request allows and no others", () => {
    const set = planSceneSet(input({ count: 60, categories: ["home"], poses: { profile: false, back: false } }));
    expect(set.scenes.every((s) => s.slot.pose === "front" || s.slot.pose === "three-quarter")).toBe(true);
  });

  test("keeps the run id issued for the set, and the request as it was made", () => {
    const set = planSceneSet(input({ runId: "run-zzzz-0009" }));
    expect(set.runId).toBe("run-zzzz-0009");
    expect(set.request).toEqual({ count: 20, categories: ["home", "travel"], poses: { profile: false, back: false } });
    expect(set.models).toEqual({ text: "x-ai/grok-4.3" });
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
