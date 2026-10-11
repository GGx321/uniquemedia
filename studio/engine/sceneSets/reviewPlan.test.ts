import { describe, expect, test } from "bun:test";
import type { ReviewWriteRecord, StoredSceneSet } from "../library/sceneSets";
import { sceneSetOnTheBanks } from "../library/testing/bankScenes";
import { ideaRecord, llmOnlySet, ownScene, rewriteRecord, sampleSet } from "../library/testing/sceneSetSample";
import { planReviewWrite } from "./reviewPlan";
import { fakeLedger } from "./testing/fakeLedger";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6c1, plan s5a2 r1.5 §5.5, m1): «⟳ Другая сцена» is a rewrite with a redraw. A rewrite WITHOUT a redraw of a planned scene the code template
// writes is the same thing at $0: the scene is redrawn and the template writes it, so the owner gets a new scene, not the same place in new words.

const BASE = { schemaVersion: 1 as const, revision: 4, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z" };

function stored(onBanks: readonly number[]): StoredSceneSet {
  return { ...BASE, ...sceneSetOnTheBanks(sampleSet({ count: 4, written: 4 }), onBanks) };
}

// 5a.2 (S5.6c2, m11): since the planner draws built-ins from the banks, a built-in scene is one the template writes. «A scene the template cannot write» is a
// scene of `cat-llm-only-fixture` (a custom category whose activities do not render), or an old-pool slot of a built-in category (a place no bank has).
function fixtureSet(): StoredSceneSet {
  return { ...BASE, ...llmOnlySet({ count: 4, written: 4 }) };
}

/** A built-in set whose scenes `oldPool` name are old-pool slots: a place the banks do not have, so the template answers null for them. */
function withOldPool(oldPool: readonly number[]): StoredSceneSet {
  const set = stored([]);
  return { ...set, scenes: set.scenes.map((s) => (s.origin === "planned" && oldPool.includes(s.sceneId) ? { ...s, slot: { ...s.slot, location: "a place no bank has" } } : s)) };
}

async function recordOf(set: StoredSceneSet, sceneIds: number[], redraw: boolean): Promise<ReviewWriteRecord> {
  const plan = await planReviewWrite({ set, target: { kind: "rewrite", sceneIds, redraw }, ledger: fakeLedger({}), customCategories: async () => [] });
  const record = plan.begin(set, "job-aaaa-0002").reviewWrites?.find((r) => r.k === plan.k);
  if (record === undefined) throw new Error("the plan recorded no write");
  return record;
}

describe("a rewrite without a redraw", () => {
  test("of a planned scene the code template writes is planned as a redraw", async () => {
    const record = await recordOf(stored([2]), [2], false);
    expect(record).toMatchObject({ kind: "rewrite", redraw: true });
  });

  test("of a planned scene the code template writes carries the draw of its new place", async () => {
    const record = await recordOf(stored([2]), [2], false);
    expect(record.kind === "rewrite" ? record.slots.map((s) => s.slotIndex) : []).toEqual([2]);
  });

  // m11: «a scene the template cannot write» is an old-pool slot of a built-in category (a place no bank has) since the planner draws built-ins from the banks.
  test("of a planned scene the code template cannot write stays a plain rewrite, with no draw", async () => {
    const record = await recordOf(withOldPool([2]), [2], false);
    expect(record).toMatchObject({ kind: "rewrite", redraw: false, slots: [] });
  });

  test("of two scenes, one the template cannot write, stays a plain rewrite", async () => {
    const record = await recordOf(withOldPool([4]), [2, 4], false);
    expect(record).toMatchObject({ kind: "rewrite", redraw: false, slots: [] });
  });

  test("with a redraw asked for stays a redraw whatever the scene", async () => {
    const record = await recordOf(withOldPool([2]), [2], true);
    expect(record).toMatchObject({ kind: "rewrite", redraw: true });
  });

  test("of a scene of a custom category the template cannot write stays a plain rewrite (the twin on the fixture)", async () => {
    const record = await recordOf(fixtureSet(), [2], false);
    expect(record).toMatchObject({ kind: "rewrite", redraw: false, slots: [] });
  });
});

// 5a.2 (S5.6c2, plan s5a2 §5.6): a write is priced from its actual slots. `modelScenes` is how many of the write's scenes the code template cannot write, so
// the model must: 0 when every scene renders (the write costs $0), the scenes of the request otherwise.
describe("a write's model scenes", () => {
  async function planOf(set: StoredSceneSet, target: Parameters<typeof planReviewWrite>[0]["target"], ledger = fakeLedger({})) {
    return planReviewWrite({ set, target, ledger, customCategories: async () => [] });
  }

  test("of a rewrite of built-in scenes is 0: the scene is redrawn and the template writes it", async () => {
    expect((await planOf(stored([]), { kind: "rewrite", sceneIds: [2, 3], redraw: false })).modelScenes).toBe(0);
  });

  test("of a redraw asked for on a built-in scene is 0", async () => {
    expect((await planOf(stored([]), { kind: "rewrite", sceneIds: [2], redraw: true })).modelScenes).toBe(0);
  });

  test("of a plain rewrite of a scene the template cannot write is that scene (the twin on the fixture)", async () => {
    expect((await planOf(fixtureSet(), { kind: "rewrite", sceneIds: [2], redraw: false })).modelScenes).toBe(1);
  });

  test("of a plain rewrite of three fixture scenes is 3", async () => {
    expect((await planOf(fixtureSet(), { kind: "rewrite", sceneIds: [1, 2, 3], redraw: false })).modelScenes).toBe(3);
  });

  test("of an idea write is all its scenes: ideas are written by the model", async () => {
    const plan = await planOf(stored([]), { kind: "idea", idea: "кофе на балконе утром", count: 2, shot: null });
    expect(plan.modelScenes).toBe(2);
  });

  test("of a rewrite of an own scene is that scene", async () => {
    const set = stored([]);
    const withOwn = { ...set, scenes: [...set.scenes, ownScene(5)] } as unknown as StoredSceneSet;
    expect((await planOf(withOwn, { kind: "rewrite", sceneIds: [5], redraw: false })).modelScenes).toBe(1);
  });

  test("of the resume of an interrupted rewrite whose slot is an old-pool slot is that scene: priced as today", async () => {
    const set = withOldPool([2]);
    const record = rewriteRecord({ k: 2, sceneIds: [2], redraw: false, slots: [] });
    const interrupted = { ...set, writes: 2, reviewWrites: [record] } as unknown as StoredSceneSet;
    const plan = await planOf(interrupted, { kind: "resume", write: 2 });
    expect(plan.modelScenes).toBe(1);
  });

  test("of the resume of an interrupted rewrite whose redrawn slot renders is 0: it is free to finish", async () => {
    const set = stored([]);
    const scene = set.scenes.find((s) => s.sceneId === 2);
    const slot = scene?.origin === "planned" ? scene.slot : undefined;
    const record = rewriteRecord({ k: 2, sceneIds: [2], redraw: true, slots: slot === undefined ? [] : [slot] });
    const interrupted = { ...set, writes: 2, reviewWrites: [record] } as unknown as StoredSceneSet;
    const plan = await planOf(interrupted, { kind: "resume", write: 2 });
    expect(plan.modelScenes).toBe(0);
  });

  test("of the resume of an interrupted idea write is all its scenes", async () => {
    const set = stored([]);
    const interrupted = { ...set, writes: 3, reviewWrites: [ideaRecord({ k: 3 })] } as unknown as StoredSceneSet;
    const plan = await planOf(interrupted, { kind: "resume", write: 3 });
    expect(plan.modelScenes).toBe(2);
  });
});
