import { describe, expect, test } from "bun:test";
import { splitCount, type CategoryPool, type CategoryRef, type CategorySnapshot } from "../../shared/engine";
import { llmPossibleSlots, writerChunksWorst } from "../../shared/scenes/writerBound";
import { planWithPools, POOLS } from "../scenes";
import { coversOfStored } from "../scenes/coverage";
import { localSentences } from "../scenes/localSentences";
import { slotKeyOf } from "../scenes/phoneLook";
import { poolOf } from "../scenes/poolGen";
import { sceneCategory } from "./plan";
import { chunkSlots } from "../scenes/writer";
import { LLM_ONLY_CATEGORY_POOL, LLM_ONLY_REF, llmOnlySnapshot } from "../scenes/testing/llmOnlyFixture";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6c2, plan s5a2 §5.6, I5.30): «estimates are never below spend», checked against the REAL planner and the REAL template seam. For random plans over built-in,
// covered-custom and uncovered-custom categories: (1) a covered category never yields a slot the template cannot write (the soundness of `covers`, which is the money side:
// a covered pool reserves no writer), and (2) the writer requests the plan can actually need (the chunks holding a slot the template cannot write) never exceed
// `writerChunksWorst`, nor the model's scenes `llmPossibleSlots`. The brute force of the bound itself is shared/scenes/writerBound.test.ts.

const COVERED = "cat-covered-fixture" as const;
const COVERED_POOL: CategoryPool = {
  locations: ["a quiet bookshop", "a flower stall", "a corner cafe", "a bridge over the river", "a sunny terrace"].map((name) => ({
    name,
    times: ["midday" as const],
    activities: [{ text: "holding a mug", twoHanded: false }, { text: "browsing the shelves", twoHanded: false }],
    mirror: false,
  })),
  outfits: ["a cozy cardigan", "jeans and a tee", "a linen dress"],
  shotDeck: ["friend", "friend", "friend", "friend", "friend"],
};
const COVERED_SNAPSHOT: CategorySnapshot = { ref: COVERED, name: "Покрытая", label: "Covered cafes", style: "phone" };

const STORED = [
  { categoryId: LLM_ONLY_REF, pool: LLM_ONLY_CATEGORY_POOL },
  { categoryId: COVERED, pool: COVERED_POOL },
];
const coversOf = coversOfStored(STORED, undefined);
const POOL_OF = { ...POOLS, [LLM_ONLY_REF]: poolOf(LLM_ONLY_CATEGORY_POOL), [COVERED]: poolOf(COVERED_POOL) };
const SNAPSHOTS = [llmOnlySnapshot(), COVERED_SNAPSHOT];

const MIXES: CategoryRef[][] = [
  ["home"],
  [LLM_ONLY_REF],
  [COVERED],
  ["home", LLM_ONLY_REF],
  ["home", COVERED],
  [COVERED, LLM_ONLY_REF],
  ["home", "travel", COVERED, LLM_ONLY_REF],
  ["shoot", "glam", "fit", LLM_ONLY_REF],
];
const COUNTS = [1, 3, 7, 12, 24, 25, 26, 40, 49, 50, 51, 77, 100];

function drawn(seed: number, count: number, mix: readonly CategoryRef[]) {
  const scenes = planWithPools({ seed, count, categories: mix.map(sceneCategory) }, POOL_OF);
  const slots = scenes.slots;
  const local = localSentences({ slots: slots.map((s) => ({ ...s, route: s.route })), keyOf: (slot) => slotKeyOf("run-00000001", slot.attemptIdBase), snapshots: SNAPSHOTS });
  return { slots, local };
}

describe("the writer's money bound against the real planner and template", () => {
  test("a covered category never yields a slot the template cannot write, and a built-in one never does either", () => {
    for (const mix of MIXES) {
      for (const count of COUNTS) {
        for (let seed = 1; seed <= 6; seed++) {
          const { slots, local } = drawn(seed, count, mix);
          for (const slot of slots) {
            if (slot.category === LLM_ONLY_REF) continue;
            if (local(slot) === null) throw new Error(`seed ${seed}, ${count} × ${mix.join("+")}: ${slot.category} slot ${slot.slotIndex} (${slot.location} / ${slot.activity}) is null`);
          }
        }
      }
    }
  });

  test("the chunks that need the model never exceed writerChunksWorst, nor its scenes llmPossibleSlots", () => {
    for (const mix of MIXES) {
      for (const count of COUNTS) {
        for (let seed = 1; seed <= 6; seed++) {
          const { slots, local } = drawn(seed, count, mix);
          const split = splitCount(count, mix);
          const needed = chunkSlots(slots).filter((chunk) => chunk.some((slot) => local(slot) === null)).length;
          const modelScenes = slots.filter((slot) => local(slot) === null).length;
          if (needed > writerChunksWorst(split, coversOf)) throw new Error(`seed ${seed}, ${count} × ${mix.join("+")}: ${needed} chunks need the model, the bound says ${writerChunksWorst(split, coversOf)}`);
          if (modelScenes > llmPossibleSlots(split, coversOf)) throw new Error(`seed ${seed}, ${count} × ${mix.join("+")}: ${modelScenes} model scenes, the bound says ${llmPossibleSlots(split, coversOf)}`);
        }
      }
    }
  });
});

// 5a.4 (S5.BA5, plan s5a4 I5.77, BA3 review M-1): at «Смелая» every custom slot is on the route and the template renders none of them, so the coverage a pool has below «Смелая»
// says nothing there: the bound is held at the request's level (`coversOfStored(…, "bold")`), against the real planner drawing at «Смелая».
describe("the writer's money bound at «Смелая»", () => {
  const coversBold = coversOfStored(STORED, "bold");

  function drawnBold(seed: number, count: number, mix: readonly CategoryRef[]) {
    const slots = planWithPools({ seed, count, categories: mix.map(sceneCategory), level: "bold" }, POOL_OF).slots;
    return { slots, local: localSentences({ slots: slots.map((s) => ({ ...s, route: s.route })), keyOf: (slot) => slotKeyOf("run-00000001", slot.attemptIdBase), snapshots: SNAPSHOTS }) };
  }

  test("a custom category the template covers below «Смелая» goes to the model at it, every slot", () => {
    const { slots, local } = drawnBold(1, 25, [COVERED]);
    expect(slots.every((slot) => local(slot) === null)).toBe(true);
    expect([coversOf(COVERED), coversBold(COVERED)]).toEqual([true, false]);
  });

  test("the chunks that need the model never exceed writerChunksWorst at «Смелая», nor its scenes llmPossibleSlots", () => {
    for (const mix of MIXES) {
      for (const count of COUNTS) {
        for (let seed = 1; seed <= 6; seed++) {
          const { slots, local } = drawnBold(seed, count, mix);
          const split = splitCount(count, mix);
          const needed = chunkSlots(slots).filter((chunk) => chunk.some((slot) => local(slot) === null)).length;
          const modelScenes = slots.filter((slot) => local(slot) === null).length;
          if (needed > writerChunksWorst(split, coversBold)) throw new Error(`seed ${seed}, ${count} × ${mix.join("+")} at «Смелая»: ${needed} chunks need the model, the bound says ${writerChunksWorst(split, coversBold)}`);
          if (modelScenes > llmPossibleSlots(split, coversBold)) throw new Error(`seed ${seed}, ${count} × ${mix.join("+")} at «Смелая»: ${modelScenes} model scenes, the bound says ${llmPossibleSlots(split, coversBold)}`);
        }
      }
    }
  });
});
