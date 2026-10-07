import { describe, expect, test } from "bun:test";
import { MAX_COMPOSE_SCENES, MAX_SCENES_PER_SET, type EngineError, type SceneReason } from "../../shared/engine";
import { EngineFailure } from "../engineFailure";
import { MAX_REVIEW_WRITES, type ReviewWriteRecord, type StoredSceneSet } from "../library/sceneSets";
import { ideaRecord, ownScene, rewriteRecord, sampleSet } from "../library/testing/sceneSetSample";
import { applyEdit } from "./edit";
import { planReviewWrite } from "./reviewPlan";
import { fakeLedger } from "./testing/fakeLedger";
import { approvalRefusal } from "./toRun";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.7: every VALIDATION the scene-set code raises carries a closed `sceneReason` (and the scene it is about, where there is one), so the window's text
// never depends on a phrase of the English `detail`. One test per refusal; the transport's own check of the pairing is in shared/engine/errors.sceneReason.test.ts.

function stored(extra: Record<string, unknown> = {}, count = 4, written = count): StoredSceneSet {
  return { schemaVersion: 1, revision: 4, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...sampleSet({ count, written }), ...extra } as StoredSceneSet;
}
const rewrite = (over: Record<string, unknown> = {}) => rewriteRecord(over) as unknown as ReviewWriteRecord;
const idea = (over: Record<string, unknown> = {}) => ideaRecord(over) as unknown as ReviewWriteRecord;

type Reasoned = Pick<EngineError, "code" | "sceneReason" | "sceneId">;

const FREE = { revision: 4, live: false, used: false };

function reasonOf(refusal: Reasoned | null): [string | undefined, SceneReason | undefined, number | undefined] {
  return [refusal?.code, refusal?.sceneReason, refusal?.sceneId];
}

describe("an approval's refusals", () => {
  test("an active scene with no text: scene-without-text, naming the first such scene", () => {
    const set = stored({}, 5);
    const textless = { ...set, scenes: set.scenes.map((s) => (s.sceneId === 2 || s.sceneId === 4 ? { ...s, text: null } : s)) } as StoredSceneSet;
    expect(reasonOf(approvalRefusal(textless, FREE))).toEqual(["VALIDATION", "scene-without-text", 2]);
  });

  test("every scene removed: no-active-scenes", () => {
    const set = stored({}, 2);
    const none = { ...set, scenes: set.scenes.map((s) => ({ ...s, removed: true })) } as StoredSceneSet;
    expect(reasonOf(approvalRefusal(none, FREE))).toEqual(["VALIDATION", "no-active-scenes", undefined]);
  });

  test("101 active scenes: too-many-active", () => {
    expect(reasonOf(approvalRefusal(stored({}, MAX_COMPOSE_SCENES + 1), FREE))).toEqual(["VALIDATION", "too-many-active", undefined]);
  });

  test("an active text that now breaks the word rules: scene-text-problem, naming that scene", () => {
    const set = stored({}, 5);
    const unfit = { ...set, scenes: set.scenes.map((s) => (s.sceneId === 3 ? { ...s, text: "A teenage girl in a bikini." } : s)) } as StoredSceneSet;
    expect(reasonOf(approvalRefusal(unfit, FREE))).toEqual(["VALIDATION", "scene-text-problem", 3]);
  });

  test("a set already used: set-used", () => {
    expect(reasonOf(approvalRefusal(stored({}, 5), { ...FREE, used: true }))).toEqual(["VALIDATION", "set-used", undefined]);
  });

  test("a moved revision is SCENES_CHANGED and carries no scene reason", () => {
    expect(reasonOf(approvalRefusal(stored({}, 5), { ...FREE, revision: 3 }))).toEqual(["SCENES_CHANGED", undefined, undefined]);
  });

  test("a job running is IN_FLIGHT and carries no scene reason", () => {
    expect(reasonOf(approvalRefusal(stored({}, 5), { ...FREE, live: true }))).toEqual(["IN_FLIGHT", undefined, undefined]);
  });
});

describe("a free edit's refusals", () => {
  const invalidOf = (outcome: ReturnType<typeof applyEdit>) => (outcome.kind === "invalid" ? { reason: outcome.sceneReason, sceneId: outcome.sceneId } : null);

  test("a text for a scene the set lacks: scene-missing", () => {
    expect(invalidOf(applyEdit(stored(), { op: "text", sceneId: 99, text: "Typed." }))).toEqual({ reason: "scene-missing", sceneId: 99 });
  });

  test("a text for a removed scene: target-removed", () => {
    const set = stored();
    const removed = { ...set, scenes: set.scenes.map((s) => (s.sceneId === 1 ? { ...s, removed: true } : s)) } as StoredSceneSet;
    expect(invalidOf(applyEdit(removed, { op: "text", sceneId: 1, text: "Typed." }))).toEqual({ reason: "target-removed", sceneId: 1 });
  });

  test("a removal naming scenes the set lacks: scene-missing, naming the first", () => {
    expect(invalidOf(applyEdit(stored(), { op: "remove", sceneIds: [1, 98, 99] }))).toEqual({ reason: "scene-missing", sceneId: 98 });
  });

  test("a restore naming a scene the set lacks: scene-missing", () => {
    expect(invalidOf(applyEdit(stored(), { op: "restore", sceneIds: [99] }))).toEqual({ reason: "scene-missing", sceneId: 99 });
  });

  test("dismissing a write the set does not have: no-open-write", () => {
    expect(invalidOf(applyEdit(stored({ writes: 4, reviewWrites: [rewrite({ k: 2 })] }), { op: "dismissInterrupted", write: 9 }))).toEqual({ reason: "no-open-write", sceneId: undefined });
  });

  test("dismissing a write that is already resolved: no-open-write", () => {
    expect(invalidOf(applyEdit(stored({ writes: 4, reviewWrites: [rewrite({ k: 2, closed: true })] }), { op: "dismissInterrupted", write: 2 }))).toEqual({ reason: "no-open-write", sceneId: undefined });
  });

  test("dismissing a scene the set lacks: scene-missing", () => {
    expect(invalidOf(applyEdit(stored({ writes: 4, reviewWrites: [rewrite({ k: 2 })] }), { op: "dismissInterrupted", sceneIds: [99] }))).toEqual({ reason: "scene-missing", sceneId: 99 });
  });

  test("dismissing a scene that has no unresolved rewrite: nothing-to-dismiss", () => {
    expect(invalidOf(applyEdit(stored({ writes: 4, reviewWrites: [rewrite({ k: 2, sceneIds: [2] })] }), { op: "dismissInterrupted", sceneIds: [2, 4] }))).toEqual({ reason: "nothing-to-dismiss", sceneId: undefined });
  });
});

describe("a review write's refusals", () => {
  const noCustom = async () => [];

  async function refusalOf(set: StoredSceneSet, target: Parameters<typeof planReviewWrite>[0]["target"], ledger = fakeLedger({})): Promise<Reasoned> {
    try {
      await planReviewWrite({ set, target, ledger, customCategories: noCustom });
    } catch (error) {
      if (error instanceof EngineFailure) return error.error;
      throw error;
    }
    throw new Error("the write was planned, expected a refusal");
  }

  const rewriteOf = (sceneIds: number[], redraw = false) => ({ kind: "rewrite" as const, sceneIds, redraw });

  test("a scene the set lacks: scene-missing", async () => {
    expect(reasonOf(await refusalOf(stored(), rewriteOf([99])))).toEqual(["VALIDATION", "scene-missing", 99]);
  });

  test("a removed scene: target-removed", async () => {
    const set = stored({}, 4);
    const removed = { ...set, scenes: set.scenes.map((s) => (s.sceneId === 2 ? { ...s, removed: true } : s)) } as StoredSceneSet;
    expect(reasonOf(await refusalOf(removed, rewriteOf([2])))).toEqual(["VALIDATION", "target-removed", 2]);
  });

  test("planned and own scenes together: mixed-kinds", async () => {
    const set = stored({ scenes: [...stored().scenes, ownScene(5)] });
    expect(reasonOf(await refusalOf(set, rewriteOf([1, 5])))).toEqual(["VALIDATION", "mixed-kinds", undefined]);
  });

  test("a redraw of an own scene: own-redraw", async () => {
    const set = stored({ scenes: [...stored().scenes, ownScene(5)] });
    expect(reasonOf(await refusalOf(set, rewriteOf([5], true)))).toEqual(["VALIDATION", "own-redraw", undefined]);
  });

  test("a set that already records 500 writes: write-record-cap", async () => {
    const records = Array.from({ length: MAX_REVIEW_WRITES }, (_, i) => rewrite({ k: i + 1, closed: true }));
    expect(reasonOf(await refusalOf(stored({ writes: MAX_REVIEW_WRITES, reviewWrites: records }), rewriteOf([1])))).toEqual(["VALIDATION", "write-record-cap", undefined]);
  });

  test("an idea that would not fit in the set: idea-room", async () => {
    const own = Array.from({ length: MAX_SCENES_PER_SET - 4 - 1 }, (_, i) => ownScene(5 + i));
    const set = stored({ scenes: [...stored().scenes, ...own] });
    expect(reasonOf(await refusalOf(set, { kind: "idea", idea: "кофе", count: 2, shot: null }))).toEqual(["VALIDATION", "idea-room", undefined]);
  });

  test("an idea write left open with no attempt left holds no room: a new idea fits where it would not if that write still counted", async () => {
    const own = Array.from({ length: MAX_SCENES_PER_SET - 4 - 2 }, (_, i) => ownScene(7 + i));
    const set = stored({ writes: 2, scenes: [...stored().scenes, ...own], reviewWrites: [idea({ k: 2, firstId: 5 })] });
    const spent = fakeLedger({ "set-aaaa-0001:write-2#1": { close: { type: "settle", costMicros: 4_000 } }, "set-aaaa-0001:write-2#2": {} });
    expect((await planReviewWrite({ set, target: { kind: "idea", idea: "кофе", count: 2, shot: null }, ledger: spent, customCategories: noCustom })).count).toBe(2);
    // The same write with its attempts still unspent keeps its room, and the new idea does not fit.
    expect(reasonOf(await refusalOf(set, { kind: "idea", idea: "кофе", count: 2, shot: null }, fakeLedger({})))).toEqual(["VALIDATION", "idea-room", undefined]);
  });

  test("a resume of a write the set does not have: no-open-write", async () => {
    expect(reasonOf(await refusalOf(stored({ writes: 2, reviewWrites: [rewrite({ k: 2 })] }), { kind: "resume", write: 9 }))).toEqual(["VALIDATION", "no-open-write", undefined]);
  });

  test("a resume of a write with no attempt left: no-attempts-left", async () => {
    const set = stored({ writes: 2, reviewWrites: [rewrite({ k: 2 })] });
    const spent = fakeLedger({ "set-aaaa-0001:write-2#1": { close: { type: "settle", costMicros: 4_000 } }, "set-aaaa-0001:write-2#2": { close: { type: "settle", costMicros: 4_000 } } });
    expect(reasonOf(await refusalOf(set, { kind: "resume", write: 2 }, spent))).toEqual(["VALIDATION", "no-attempts-left", undefined]);
  });

  test("a resume of a rewrite whose every scene is removed: target-removed", async () => {
    const base = stored({ writes: 2, reviewWrites: [rewrite({ k: 2, sceneIds: [2] })] });
    const set = { ...base, scenes: base.scenes.map((s) => (s.sceneId === 2 ? { ...s, removed: true } : s)) } as StoredSceneSet;
    expect(reasonOf(await refusalOf(set, { kind: "resume", write: 2 }))).toEqual(["VALIDATION", "target-removed", undefined]);
  });

  test("an idea write's record is not mistaken for a rewrite's: its resume is no-open-write once closed", async () => {
    const set = stored({ writes: 3, reviewWrites: [idea({ k: 3, closed: true })] });
    expect(reasonOf(await refusalOf(set, { kind: "resume", write: 3 }))).toEqual(["VALIDATION", "no-open-write", undefined]);
  });
});
