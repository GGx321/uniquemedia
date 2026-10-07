import { describe, expect, test } from "bun:test";
import type { ReviewWriteRecord, StoredSceneSet } from "../library/sceneSets";
import { ideaRecord, ownScene, rewriteRecord, sampleSet, writeIdsOf } from "../library/testing/sceneSetSample";
import { interruptedWrites, nextSceneId, reservedIdeaScenes, reviewWriteState, reviewWritesOf, writeAttemptIds } from "./reviewWrites";
import { fakeLedger } from "./testing/fakeLedger";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: what a review write (a rewrite or an idea) may still do. The attempt invariant of CS.4a holds for it too: answered attempts per write are at most
// 2 across ALL jobs of the set, an open reserve and a reconcile's estimated settle count as answered, an id that was reserved is never sent again, and a
// write number is never reused, so no id of a write is ever the id of another.

const SET = "set-aaaa-0001";
const id = (k: number, n: number) => `${SET}:write-${k}#${n}`;

function stored(extra: Record<string, unknown> = {}): StoredSceneSet {
  return { schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...sampleSet({ count: 4, written: 4 }), writes: 3, ...extra } as StoredSceneSet;
}
const rewrite = (over: Record<string, unknown> = {}) => rewriteRecord(over) as unknown as ReviewWriteRecord;
const idea = (over: Record<string, unknown> = {}) => ideaRecord(over) as unknown as ReviewWriteRecord;

describe("writeAttemptIds", () => {
  test("a write has four ids of its own: `${set}:write-${k}#1..4`", () => {
    expect(writeAttemptIds(SET, 2)).toEqual([id(2, 1), id(2, 2), id(2, 3), id(2, 4)]);
  });

  test("the ids of different writes never meet, and none is a compose chunk's id", () => {
    const all = [1, 2, 3, 4, 5].flatMap((k) => writeAttemptIds(SET, k));
    expect(new Set(all).size).toBe(all.length);
    expect(all.some((a) => a.includes(":writer-"))).toBe(false);
  });

  test("agrees with the ids the test oracle names", () => {
    expect(writeAttemptIds(SET, 7)).toEqual(writeIdsOf(SET, 7));
  });
});

describe("reviewWriteState: attempts left", () => {
  test("a write nothing was sent for has both its attempts and every id", () => {
    expect(reviewWriteState(rewrite(), fakeLedger({}))).toEqual({ answered: 0, unused: 4, attemptsLeft: 2 });
  });

  test("a settled paid answer is one attempt used", () => {
    expect(reviewWriteState(rewrite(), fakeLedger({ [id(2, 1)]: { close: { type: "settle", costMicros: 4_000 } } }))).toEqual({ answered: 1, unused: 3, attemptsLeft: 1 });
  });

  test("an open reserve counts as answered: an interrupted request may have been billed", () => {
    expect(reviewWriteState(rewrite(), fakeLedger({ [id(2, 1)]: {} }))).toMatchObject({ answered: 1, attemptsLeft: 1 });
  });

  test("a reconcile's estimated settle counts as answered", () => {
    expect(reviewWriteState(rewrite(), fakeLedger({ [id(2, 1)]: { close: { type: "settle", costMicros: 0, estimated: true } } }))).toMatchObject({ answered: 1, attemptsLeft: 1 });
  });

  test("a free settle of a final 429 or 5xx is not an answer, but its id is burnt", () => {
    expect(reviewWriteState(rewrite(), fakeLedger({ [id(2, 1)]: { close: { type: "settle", costMicros: 0 } } }))).toEqual({ answered: 0, unused: 3, attemptsLeft: 2 });
  });

  test("a released reserve is not an answer and its id is burnt too", () => {
    expect(reviewWriteState(rewrite(), fakeLedger({ [id(2, 1)]: { close: { type: "release" } } }))).toEqual({ answered: 0, unused: 3, attemptsLeft: 2 });
  });

  test("two answers leave none, whatever ids are unused: never a fresh pair after an interruption", () => {
    const ledger = fakeLedger({ [id(2, 1)]: { close: { type: "settle", costMicros: 2_000 } }, [id(2, 2)]: {} });
    expect(reviewWriteState(rewrite(), ledger)).toEqual({ answered: 2, unused: 2, attemptsLeft: 0 });
  });

  test("attempts are bounded by the unused ids, too", () => {
    const burnt = Object.fromEntries([1, 2, 3].map((n) => [id(2, n), { close: { type: "settle" as const, costMicros: 0 } }]));
    expect(reviewWriteState(rewrite(), fakeLedger(burnt))).toEqual({ answered: 0, unused: 1, attemptsLeft: 1 });
  });

  test("a closed write has none left", () => {
    expect(reviewWriteState(rewrite({ closed: true }), fakeLedger({})).attemptsLeft).toBe(0);
  });

  test("with no ledger to read the write looks untouched", () => {
    expect(reviewWriteState(rewrite(), null)).toEqual({ answered: 0, unused: 4, attemptsLeft: 2 });
  });

  test("another write's ids are not this write's attempts", () => {
    expect(reviewWriteState(rewrite(), fakeLedger({ [id(3, 1)]: {}, [`${SET}:writer-1#1`]: {} })).attemptsLeft).toBe(2);
  });
});

describe("reviewWritesOf", () => {
  test("a set with no records has none", () => {
    expect(reviewWritesOf(stored())).toEqual([]);
  });

  test("lists the records in the order they began", () => {
    expect(reviewWritesOf(stored({ reviewWrites: [rewrite({ k: 2 }), idea({ k: 3 })] })).map((r) => r.k)).toEqual([2, 3]);
  });
});

describe("nextSceneId", () => {
  test("is one past the highest scene id of the set", () => {
    expect(nextSceneId(stored())).toBe(5);
  });

  test("never reuses the id of a removed scene, and counts own scenes", () => {
    const set = stored();
    const withOwn = { ...set, scenes: [...set.scenes.map((s) => (s.sceneId === 4 ? { ...s, removed: true } : s)), ownScene(9)] } as StoredSceneSet;
    expect(nextSceneId(withOwn)).toBe(10);
  });

  test("steps over the ids an unresolved idea write has reserved", () => {
    expect(nextSceneId(stored({ reviewWrites: [idea({ firstId: 5 })] }))).toBe(7);
  });

  test("steps over the ids of a resolved or dismissed idea write too: an id is never reused", () => {
    expect(nextSceneId(stored({ reviewWrites: [idea({ firstId: 5, closed: true })] }))).toBe(7);
  });

  test("an empty set starts at 1", () => {
    expect(nextSceneId({ ...stored(), scenes: [], chunks: [] })).toBe(1);
  });
});

describe("reservedIdeaScenes", () => {
  test("counts the scenes unresolved idea writes will add, and none of a resolved one's", () => {
    const set = stored({ reviewWrites: [idea({ k: 2, firstId: 5 }), idea({ k: 3, firstId: 7, closed: true })] });
    expect(reservedIdeaScenes(set)).toBe(2);
  });
});

describe("interruptedWrites", () => {
  const set = (records: ReviewWriteRecord[]) => stored({ reviewWrites: records });
  const SENT = fakeLedger({ [id(2, 1)]: {} });

  test("an unresolved write with attempts left and no job is interrupted", () => {
    expect(interruptedWrites(set([rewrite()]), SENT, null).map((r) => r.k)).toEqual([2]);
  });

  test("the write a job runs now is not interrupted, another one is", () => {
    const records = [rewrite({ k: 2 }), idea({ k: 3 })];
    expect(interruptedWrites(set(records), fakeLedger({}), 3).map((r) => r.k)).toEqual([2]);
  });

  test("a closed write is not", () => {
    expect(interruptedWrites(set([rewrite({ closed: true })]), fakeLedger({}), null)).toEqual([]);
  });

  test("a write with no attempt left is not: nothing could be resumed", () => {
    const ledger = fakeLedger({ [id(2, 1)]: { close: { type: "settle", costMicros: 1_000 } }, [id(2, 2)]: {} });
    expect(interruptedWrites(set([rewrite()]), ledger, null)).toEqual([]);
  });
});
