import { describe, expect, test } from "bun:test";
import type { ReviewWriteRecord, StoredSceneSet } from "../library/sceneSets";
import { sceneSetOnTheBanks } from "../library/testing/bankScenes";
import { sampleSet } from "../library/testing/sceneSetSample";
import { planReviewWrite } from "./reviewPlan";
import { fakeLedger } from "./testing/fakeLedger";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6c1, plan s5a2 r1.5 §5.5, m1): «⟳ Другая сцена» is a rewrite with a redraw. A rewrite WITHOUT a redraw of a planned scene the code template
// writes is the same thing at $0: the scene is redrawn and the template writes it, so the owner gets a new scene, not the same place in new words.

function stored(onBanks: readonly number[]): StoredSceneSet {
  const base = { schemaVersion: 1 as const, revision: 4, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z" };
  return { ...base, ...sceneSetOnTheBanks(sampleSet({ count: 4, written: 4 }), onBanks) };
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

  test("of a planned scene the code template cannot write stays a plain rewrite, with no draw", async () => {
    const record = await recordOf(stored([]), [2], false);
    expect(record).toMatchObject({ kind: "rewrite", redraw: false, slots: [] });
  });

  test("of two scenes, one the template cannot write, stays a plain rewrite", async () => {
    const record = await recordOf(stored([2]), [2, 4], false);
    expect(record).toMatchObject({ kind: "rewrite", redraw: false, slots: [] });
  });

  test("with a redraw asked for stays a redraw whatever the scene", async () => {
    const record = await recordOf(stored([]), [2], true);
    expect(record).toMatchObject({ kind: "rewrite", redraw: true });
  });
});
