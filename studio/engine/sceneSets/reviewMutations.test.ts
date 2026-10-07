import { describe, expect, test } from "bun:test";
import type { CategorySnapshot } from "../../shared/engine";
import { SceneSetFile, type ReviewWriteRecord, type StoredSceneSet } from "../library/sceneSets";
import { ideaRecord, ownScene, rewriteRecord, sampleSet, writeIdsOf } from "../library/testing/sceneSetSample";
import type { PlanSlot } from "../scenes";
import { beginIdea, beginRewrite, resumeReviewWrite, withReviewWriteAccepted, withReviewWriteClosed, withReviewWriteStopped } from "./reviewMutations";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: the changes a rewrite or an idea write makes to its set's record, as pure functions. A rewrite never touches a scene outside its target; a write
// that does not finish leaves every scene exactly as it was; an accepted idea write adds its scenes with the ids it reserved before its call.

const SET = "set-aaaa-0001";

function stored(extra: Record<string, unknown> = {}, count = 4): StoredSceneSet {
  return { schemaVersion: 1, revision: 3, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...sampleSet({ count, written: count }), ...extra } as StoredSceneSet;
}
const recordsOf = (set: StoredSceneSet): ReviewWriteRecord[] => [...(set.reviewWrites ?? [])];
const rewrite = (over: Record<string, unknown> = {}) => rewriteRecord(over) as unknown as ReviewWriteRecord;
const idea = (over: Record<string, unknown> = {}) => ideaRecord(over) as unknown as ReviewWriteRecord;
const slotOf = (set: StoredSceneSet, sceneId: number): PlanSlot => {
  const scene = set.scenes.find((s) => s.sceneId === sceneId);
  if (scene === undefined || scene.origin !== "planned") throw new Error(`scene ${sceneId} is not planned`);
  return scene.slot;
};
const redrawn = (set: StoredSceneSet, sceneId: number): PlanSlot => ({ ...slotOf(set, sceneId), location: "a rooftop garden", outfit: "a red coat", activity: "watering a plant", timeOfDay: "dusk" });

describe("beginRewrite", () => {
  test("records the next write under its job with its own four ids, and counts it", () => {
    const next = beginRewrite(stored({ writes: 1 }), { jobId: "job-aaaa-0002", sceneIds: [2], redraw: false, slots: [], snapshots: [] });
    expect(recordsOf(next)).toEqual([{ kind: "rewrite", k: 2, jobId: "job-aaaa-0002", attemptIds: writeIdsOf(SET, 2), closed: false, sceneIds: [2], redraw: false, slots: [], snapshots: [] }]);
    expect(next.writes).toBe(2);
  });

  test("keeps the draw of a redraw in the record, before any call", () => {
    const set = stored({ writes: 1 });
    const slot = redrawn(set, 2);
    const next = beginRewrite(set, { jobId: "job-aaaa-0002", sceneIds: [2], redraw: true, slots: [slot], snapshots: [] });
    expect(recordsOf(next)[0]).toMatchObject({ redraw: true, slots: [slot] });
  });

  test("changes no scene: the scene shows its old place and text until the new sentence is accepted", () => {
    const set = stored({ writes: 1 });
    const next = beginRewrite(set, { jobId: "job-aaaa-0002", sceneIds: [2], redraw: true, slots: [redrawn(set, 2)], snapshots: [] });
    expect(next.scenes).toEqual(set.scenes);
  });

  test("leaves the compose write's record, its outcome and its stop reason alone", () => {
    const set = stored({ write: { k: 1, kind: "compose", jobId: "job-aaaa-0001", stoppedBy: "network" }, writes: 1, lastOutcome: { total: 4, written: 4, gaveUp: 0 } });
    const next = beginRewrite(set, { jobId: "job-aaaa-0002", sceneIds: [2], redraw: false, slots: [], snapshots: [] });
    expect([next.write, next.lastOutcome]).toEqual([set.write, set.lastOutcome]);
  });

  test("never repeats a write number: the next write after it is the one after", () => {
    const one = beginRewrite(stored({ writes: 1 }), { jobId: "job-aaaa-0002", sceneIds: [2], redraw: false, slots: [], snapshots: [] });
    const two = beginRewrite(one, { jobId: "job-aaaa-0003", sceneIds: [3], redraw: false, slots: [], snapshots: [] });
    expect(recordsOf(two).map((r) => r.k)).toEqual([2, 3]);
    expect(new Set(recordsOf(two).flatMap((r) => r.attemptIds)).size).toBe(8);
  });

  test("another scene's interrupted marker is not cleared by a rewrite of this one", () => {
    const set = stored({ writes: 2, reviewWrites: [rewrite({ k: 2, sceneIds: [1], stoppedBy: "network" })] });
    const next = beginRewrite(set, { jobId: "job-aaaa-0003", sceneIds: [3], redraw: false, slots: [], snapshots: [] });
    expect(recordsOf(next)[0]).toEqual(recordsOf(set)[0]);
  });

  test("a rewrite of a scene whose earlier write was interrupted takes that scene over: the old record keeps only its other scenes", () => {
    const set = stored({ writes: 2, reviewWrites: [rewrite({ k: 2, sceneIds: [1, 2], stoppedBy: "network" })] });
    const next = beginRewrite(set, { jobId: "job-aaaa-0003", sceneIds: [2], redraw: false, slots: [], snapshots: [] });
    expect(recordsOf(next)[0]).toMatchObject({ k: 2, sceneIds: [1], closed: false });
    expect(recordsOf(next)[1]).toMatchObject({ k: 3, sceneIds: [2] });
  });

  test("taking over the last scene of an interrupted write closes it, its ids stay burnt", () => {
    const set = stored({ writes: 2, reviewWrites: [rewrite({ k: 2, sceneIds: [2], stoppedBy: "network" })] });
    const next = beginRewrite(set, { jobId: "job-aaaa-0003", sceneIds: [2], redraw: false, slots: [], snapshots: [] });
    expect(recordsOf(next)[0]).toMatchObject({ k: 2, closed: true, attemptIds: writeIdsOf(SET, 2) });
  });

  test("taking over a redrawn scene drops the snapshot of a category no remaining scene uses", () => {
    const CAT = "cat-paris-cafes" as const;
    const OTHER = "cat-night-market" as const;
    const base = stored({ writes: 2 });
    const snapshots: CategorySnapshot[] = [
      { ref: CAT, name: "Paris", label: "Paris cafes", style: "phone" },
      { ref: OTHER, name: "Night", label: "Night market", style: "phone" },
    ];
    const set = {
      ...base,
      reviewWrites: [rewrite({ k: 2, sceneIds: [1, 2], redraw: true, slots: [{ ...redrawn(base, 1), category: CAT }, { ...redrawn(base, 2), category: OTHER }], snapshots })],
    } as StoredSceneSet;
    const next = beginRewrite(set, { jobId: "job-aaaa-0003", sceneIds: [2], redraw: false, slots: [], snapshots: [] });
    expect(recordsOf(next)[0]).toMatchObject({ sceneIds: [1], snapshots: [snapshots[0]] });
  });

  test("taking over a redrawn scene drops its old draw with it", () => {
    const base = stored({ writes: 2 });
    const set = { ...base, reviewWrites: [rewrite({ k: 2, sceneIds: [1, 2], redraw: true, slots: [redrawn(base, 1), redrawn(base, 2)] })] } as StoredSceneSet;
    const next = beginRewrite(set, { jobId: "job-aaaa-0003", sceneIds: [1], redraw: false, slots: [], snapshots: [] });
    expect(recordsOf(next)[0]).toMatchObject({ sceneIds: [2], slots: [{ slotIndex: 2 }] });
  });

  test("a result the schema accepts", () => {
    const set = stored({ writes: 1 });
    const next = beginRewrite(set, { jobId: "job-aaaa-0002", sceneIds: [2, 3], redraw: true, slots: [redrawn(set, 2), redrawn(set, 3)], snapshots: [] });
    expect(SceneSetFile.safeParse({ ...next, revision: 4 }).success).toBe(true);
  });
});

describe("beginIdea", () => {
  const drawn = [
    { sceneId: 5, shot: "friend" as const, pose: "front" as const },
    { sceneId: 6, shot: "selfie" as const, pose: "three-quarter" as const },
  ];

  test("records the idea (trimmed), the count, the shot asked for and the ids and draws reserved, with its own four ids", () => {
    const next = beginIdea(stored({ writes: 1 }), { jobId: "job-aaaa-0002", idea: "  кофе на балконе  ", count: 2, shot: null, scenes: drawn });
    expect(recordsOf(next)).toEqual([{ kind: "idea", k: 2, jobId: "job-aaaa-0002", attemptIds: writeIdsOf(SET, 2), closed: false, idea: "кофе на балконе", count: 2, shot: null, scenes: drawn }]);
    expect(next.writes).toBe(2);
  });

  test("adds no scene yet: the scenes join the set with their accepted sentences", () => {
    const set = stored({ writes: 1 });
    expect(beginIdea(set, { jobId: "job-aaaa-0002", idea: "кофе", count: 2, shot: null, scenes: drawn }).scenes).toEqual(set.scenes);
  });

  test("leaves the compose write's record and outcome alone", () => {
    const set = stored({ write: { k: 1, kind: "compose", jobId: "job-aaaa-0001", stoppedBy: "timeout" }, writes: 1, lastOutcome: { total: 4, written: 4, gaveUp: 0 } });
    const next = beginIdea(set, { jobId: "job-aaaa-0002", idea: "кофе", count: 2, shot: null, scenes: drawn });
    expect([next.write, next.lastOutcome]).toEqual([set.write, set.lastOutcome]);
  });

  test("a result the schema accepts", () => {
    const next = beginIdea(stored({ writes: 1 }), { jobId: "job-aaaa-0002", idea: "кофе", count: 2, shot: "friend", scenes: drawn });
    expect(SceneSetFile.safeParse({ ...next, revision: 4 }).success).toBe(true);
  });
});

describe("resumeReviewWrite", () => {
  test("hands the write to the new job and forgets why the last one stopped; its number and ids stay", () => {
    const set = stored({ writes: 2, reviewWrites: [rewrite({ k: 2, stoppedBy: "failed", stoppedError: { code: "NETWORK" } })] });
    const next = resumeReviewWrite(set, 2, "job-aaaa-0009");
    expect(recordsOf(next)).toEqual([rewrite({ k: 2, jobId: "job-aaaa-0009" })]);
    expect(next.writes).toBe(2);
  });

  test("a write the set does not have changes nothing", () => {
    const set = stored({ writes: 2, reviewWrites: [rewrite({ k: 2 })] });
    expect(() => resumeReviewWrite(set, 7, "job-aaaa-0009")).toThrow();
  });

  test("a closed write is not resumed", () => {
    const set = stored({ writes: 2, reviewWrites: [rewrite({ k: 2, closed: true })] });
    expect(() => resumeReviewWrite(set, 2, "job-aaaa-0009")).toThrow();
  });
});

describe("withReviewWriteAccepted: a rewrite", () => {
  const rewriting = (over: Record<string, unknown> = {}, set = stored({ writes: 2 })) => ({ ...set, reviewWrites: [rewrite({ k: 2, sceneIds: [2, 3], ...over })] }) as StoredSceneSet;

  test("gives each target its new sentence as the writer's, not the owner's", () => {
    const set = { ...rewriting(), scenes: stored().scenes.map((s) => (s.sceneId === 2 ? { ...s, text: "Typed.", edited: true } : s)) } as StoredSceneSet;
    const next = withReviewWriteAccepted(set, 2, new Map([[2, "New two."], [3, "New three."]]));
    expect(next.scenes.filter((s) => [2, 3].includes(s.sceneId)).map((s) => [s.text, s.edited])).toEqual([["New two.", false], ["New three.", false]]);
  });

  test("touches no scene outside its target, not one byte", () => {
    const set = rewriting();
    const next = withReviewWriteAccepted(set, 2, new Map([[2, "New two."], [3, "New three."]]));
    expect(next.scenes.filter((s) => ![2, 3].includes(s.sceneId))).toEqual(set.scenes.filter((s) => ![2, 3].includes(s.sceneId)));
  });

  test("ignores a sentence for a scene outside the target", () => {
    const set = rewriting();
    const next = withReviewWriteAccepted(set, 2, new Map([[2, "New two."], [3, "New three."], [1, "Intruder."], [99, "Nobody."]]));
    expect(next.scenes.find((s) => s.sceneId === 1)).toEqual(set.scenes.find((s) => s.sceneId === 1));
    expect(next.scenes).toHaveLength(set.scenes.length);
  });

  test("with a redraw, the scene takes the new place only now, with its sentence", () => {
    const base = stored({ writes: 2 });
    const slot = redrawn(base, 2);
    const set = { ...base, reviewWrites: [rewrite({ k: 2, sceneIds: [2], redraw: true, slots: [slot] })] } as StoredSceneSet;
    const next = withReviewWriteAccepted(set, 2, new Map([[2, "New two."]]));
    expect(slotOf(next, 2)).toEqual(slot);
    expect(next.scenes.find((s) => s.sceneId === 2)?.text).toBe("New two.");
  });

  test("without a redraw the slot stays as it was", () => {
    const set = rewriting({ sceneIds: [2] });
    expect(slotOf(withReviewWriteAccepted(set, 2, new Map([[2, "New two."]])), 2)).toEqual(slotOf(set, 2));
  });

  test("a redraw refreshes the set's snapshot of the category, label and style; other snapshots stay", () => {
    const CAT = "cat-paris-cafes" as const;
    const OTHER = "cat-night-market" as const;
    const old: CategorySnapshot[] = [
      { ref: CAT, name: "Paris", label: "Paris cafes", style: "phone" },
      { ref: OTHER, name: "Night", label: "Night market", style: "phone" },
    ];
    const fresh: CategorySnapshot = { ref: CAT, name: "Paris!", label: "Parisian cafes", style: "editorial" };
    const base = stored({ writes: 2, categories: old, request: { count: 4, categories: ["home", CAT, OTHER], poses: { profile: false, back: false } } });
    const set = { ...base, reviewWrites: [rewrite({ k: 2, sceneIds: [2], redraw: false, snapshots: [fresh] })] } as StoredSceneSet;
    const next = withReviewWriteAccepted(set, 2, new Map([[2, "New two."]]));
    expect(next.categories).toEqual([fresh, old[1]]);
  });

  describe("a snapshot is refreshed by the higher write number only", () => {
    const CAT = "cat-paris-cafes" as const;
    const v1: CategorySnapshot = { ref: CAT, name: "Paris", label: "Paris cafes v1", style: "phone" };
    const v2: CategorySnapshot = { ref: CAT, name: "Paris", label: "Paris cafes v2", style: "phone" };
    const v3: CategorySnapshot = { ref: CAT, name: "Paris", label: "Paris cafes v3", style: "phone" };
    /** Write 2 began before the category was regenerated (v2), write 3 after it (v3); both are unresolved. */
    function twoWrites(): StoredSceneSet {
      const base = stored({ writes: 3, categories: [v1], request: { count: 4, categories: ["home", CAT], poses: { profile: false, back: false } } });
      return { ...base, reviewWrites: [rewrite({ k: 2, sceneIds: [2], snapshots: [v2] }), rewrite({ k: 3, sceneIds: [3], snapshots: [v3] })] } as StoredSceneSet;
    }

    test("an older write accepted after a newer one does not roll the snapshot back", () => {
      const newer = withReviewWriteAccepted(twoWrites(), 3, new Map([[3, "Three."]]));
      const both = withReviewWriteAccepted(newer, 2, new Map([[2, "Two."]]));
      expect(both.categories).toEqual([v3]);
    });

    test("what is recorded is a valid set file: the write that refreshed each snapshot is kept in it", () => {
      const next = withReviewWriteAccepted(twoWrites(), 3, new Map([[3, "Three."]]));
      expect(next.snapshotWrites).toEqual({ [CAT]: 3 });
      expect(SceneSetFile.safeParse(JSON.parse(JSON.stringify(next))).success).toBe(true);
    });

    test("an older write accepted first is still refreshed by the newer one after it", () => {
      const older = withReviewWriteAccepted(twoWrites(), 2, new Map([[2, "Two."]]));
      expect(older.categories).toEqual([v2]);
      expect(withReviewWriteAccepted(older, 3, new Map([[3, "Three."]])).categories).toEqual([v3]);
    });
  });

  test("closes the record and clears why it stopped; the record stays for its ids", () => {
    const next = withReviewWriteAccepted(rewriting({ stoppedBy: "network" }), 2, new Map([[2, "a"], [3, "b"]]));
    expect(recordsOf(next)[0]).toMatchObject({ k: 2, closed: true, attemptIds: writeIdsOf(SET, 2) });
    expect(recordsOf(next)[0]).not.toHaveProperty("stoppedBy");
  });

  test("an own scene takes the sentence and keeps its idea, shot and pose", () => {
    const base = stored({ writes: 2 });
    const set = { ...base, scenes: [...base.scenes, ownScene(5, { shot: "selfie", pose: "three-quarter", idea: "кофе" })], reviewWrites: [rewrite({ k: 2, sceneIds: [5] })] } as StoredSceneSet;
    const next = withReviewWriteAccepted(set, 2, new Map<number, string>([[5, "A new sentence."]]));
    const expected: unknown = { ...ownScene(5, { shot: "selfie", pose: "three-quarter", idea: "кофе" }), text: "A new sentence." };
    expect(next.scenes.find((s) => s.sceneId === 5)).toEqual(expected as never);
  });

  test("a sentence of any length is kept (the writer's has no upper bound)", () => {
    const long = "x".repeat(5_000);
    expect(withReviewWriteAccepted(rewriting({ sceneIds: [2] }), 2, new Map([[2, long]])).scenes.find((s) => s.sceneId === 2)?.text).toBe(long);
  });

  test("refuses to apply an answer that lacks a target's sentence: nothing is half-applied", () => {
    expect(() => withReviewWriteAccepted(rewriting(), 2, new Map([[2, "Only two."]]))).toThrow();
  });

  test("a write the set does not have, or one already resolved, is refused", () => {
    expect(() => withReviewWriteAccepted(rewriting(), 9, new Map([[2, "a"], [3, "b"]]))).toThrow();
    expect(() => withReviewWriteAccepted(rewriting({ closed: true }), 2, new Map([[2, "a"], [3, "b"]]))).toThrow();
  });

  test("a result the schema accepts", () => {
    const next = withReviewWriteAccepted(rewriting(), 2, new Map([[2, "a"], [3, "b"]]));
    expect(SceneSetFile.safeParse({ ...next, revision: 4 }).success).toBe(true);
  });
});

describe("withReviewWriteAccepted: the same answer twice is one acceptance", () => {
  const rewriting = () => ({ ...stored({ writes: 2 }), reviewWrites: [rewrite({ k: 2, sceneIds: [2, 3] })] }) as StoredSceneSet;
  const ideating = () => ({ ...stored({ writes: 2 }), reviewWrites: [idea({ k: 2 })] }) as StoredSceneSet;

  test("a rewrite accepted again with the same sentences returns the set as it is", () => {
    const once = withReviewWriteAccepted(rewriting(), 2, new Map([[2, "New two."], [3, "New three."]]));
    expect(withReviewWriteAccepted(once, 2, new Map([[2, "New two."], [3, "New three."]]))).toBe(once);
  });

  test("an idea write accepted again with the same sentences returns the set as it is, its scenes added once", () => {
    const once = withReviewWriteAccepted(ideating(), 2, new Map([[5, "First."], [6, "Second."]]));
    const again = withReviewWriteAccepted(once, 2, new Map([[5, "First."], [6, "Second."]]));
    expect(again).toBe(once);
    expect(again.scenes.filter((s) => s.origin === "own")).toHaveLength(2);
  });

  test("a closed write whose scenes carry other texts is still refused: a different answer is not the one accepted", () => {
    const once = withReviewWriteAccepted(rewriting(), 2, new Map([[2, "New two."], [3, "New three."]]));
    expect(() => withReviewWriteAccepted(once, 2, new Map([[2, "Another two."], [3, "New three."]]))).toThrow("is resolved");
  });

  test("a write closed by a dismissal is not an accepted one: its scenes keep the old texts, so an answer for it is refused", () => {
    const dismissed = withReviewWriteClosed(rewriting(), 2);
    expect(() => withReviewWriteAccepted(dismissed, 2, new Map([[2, "New two."], [3, "New three."]]))).toThrow("is resolved");
  });

  test("an unresolved write is accepted as before", () => {
    const next = withReviewWriteAccepted(rewriting(), 2, new Map([[2, "New two."], [3, "New three."]]));
    expect(recordsOf(next)[0]).toMatchObject({ k: 2, closed: true });
  });
});

describe("withReviewWriteAccepted: an idea write", () => {
  const ideating = (over: Record<string, unknown> = {}) => ({ ...stored({ writes: 2 }), reviewWrites: [idea({ k: 2, ...over })] }) as StoredSceneSet;

  test("adds its scenes under the ids it reserved, with the idea, the shot and the pose it drew, and the accepted sentences", () => {
    const next = withReviewWriteAccepted(ideating(), 2, new Map([[5, "First."], [6, "Second."]]));
    expect(next.scenes.slice(4)).toEqual([
      { sceneId: 5, origin: "own", idea: "кофе на балконе утром", shot: "friend", pose: "front", text: "First.", edited: false, removed: false },
      { sceneId: 6, origin: "own", idea: "кофе на балконе утром", shot: "selfie", pose: "three-quarter", text: "Second.", edited: false, removed: false },
    ]);
  });

  test("leaves the planned scenes exactly as they were", () => {
    const set = ideating();
    expect(withReviewWriteAccepted(set, 2, new Map([[5, "a"], [6, "b"]])).scenes.slice(0, 4)).toEqual(set.scenes);
  });

  test("closes the record, which stays for its ids", () => {
    const next = withReviewWriteAccepted(ideating({ stoppedBy: "timeout" }), 2, new Map([[5, "a"], [6, "b"]]));
    expect(recordsOf(next)[0]).toMatchObject({ closed: true });
    expect(recordsOf(next)[0]).not.toHaveProperty("stoppedBy");
  });

  test("an answer that lacks a scene's sentence adds nothing", () => {
    expect(() => withReviewWriteAccepted(ideating(), 2, new Map([[5, "only one"]]))).toThrow();
  });

  test("a result the schema accepts", () => {
    const next = withReviewWriteAccepted(ideating(), 2, new Map([[5, "a"], [6, "b"]]));
    expect(SceneSetFile.safeParse({ ...next, revision: 4 }).success).toBe(true);
  });

  test("the next idea write reserves ids past the ones this one used", () => {
    const next = withReviewWriteAccepted(ideating(), 2, new Map([[5, "a"], [6, "b"]]));
    expect(Math.max(...next.scenes.map((s) => s.sceneId))).toBe(6);
  });
});

describe("withReviewWriteStopped", () => {
  const open = (over: Record<string, unknown> = {}) => ({ ...stored({ writes: 3 }), reviewWrites: [rewrite({ k: 2, ...over }), idea({ k: 3 })] }) as StoredSceneSet;

  test("keeps why the write stopped, with the error of a failure, on that write alone", () => {
    const next = withReviewWriteStopped(open(), 2, { stoppedBy: "failed", error: { code: "AUTH_INVALID", detail: "401" } });
    expect(recordsOf(next)[0]).toMatchObject({ stoppedBy: "failed", stoppedError: { code: "AUTH_INVALID" } });
    expect(recordsOf(next)[1]).toEqual(idea({ k: 3 }));
  });

  test("an earlier reason is replaced, not kept beside the new one", () => {
    const next = withReviewWriteStopped(open({ stoppedBy: "failed", stoppedError: { code: "NETWORK" } }), 2, { stoppedBy: "cancelled" });
    expect(recordsOf(next)[0]).toMatchObject({ stoppedBy: "cancelled" });
    expect(recordsOf(next)[0]).not.toHaveProperty("stoppedError");
  });

  test("changes no scene", () => {
    const set = open();
    expect(withReviewWriteStopped(set, 2, { stoppedBy: "network" }).scenes).toEqual(set.scenes);
  });

  test("a write the set does not have changes nothing", () => {
    const set = open();
    expect(withReviewWriteStopped(set, 9, { stoppedBy: "network" })).toEqual(set);
  });
});

describe("withReviewWriteClosed", () => {
  test("resolves the write without changing a scene, and keeps its record and ids", () => {
    const set = { ...stored({ writes: 2 }), reviewWrites: [rewrite({ k: 2, stoppedBy: "network" })] } as StoredSceneSet;
    const next = withReviewWriteClosed(set, 2);
    expect(next.scenes).toEqual(set.scenes);
    expect(recordsOf(next)[0]).toMatchObject({ closed: true, attemptIds: writeIdsOf(SET, 2) });
    expect(recordsOf(next)[0]).not.toHaveProperty("stoppedBy");
  });
});
