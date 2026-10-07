import { describe, expect, test } from "bun:test";
import type { ReviewWriteRecord, StoredSceneSet } from "../library/sceneSets";
import { ideaRecord, ownScene, rewriteRecord, sampleSet, writeIdsOf } from "../library/testing/sceneSetSample";
import { applyEdit } from "./edit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: the free edits that belong to the review writes. «Оставить как есть» / «Не нужно» drops the marker of an interrupted write, by its scenes or by its
// write number; the ids of that write stay burnt, no scene changes, and a marker of another write is never touched. A hand edit works on an own scene as on any.

const SET = "set-aaaa-0001";

function stored(records: ReviewWriteRecord[], extra: Record<string, unknown> = {}): StoredSceneSet {
  return { schemaVersion: 1, revision: 2, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...sampleSet({ count: 4, written: 4 }), writes: 4, reviewWrites: records, ...extra } as StoredSceneSet;
}
const rewrite = (over: Record<string, unknown> = {}) => rewriteRecord(over) as unknown as ReviewWriteRecord;
const idea = (over: Record<string, unknown> = {}) => ideaRecord(over) as unknown as ReviewWriteRecord;
const recordsOf = (outcome: ReturnType<typeof applyEdit>): ReviewWriteRecord[] => (outcome.kind === "changed" ? [...(outcome.set.reviewWrites ?? [])] : []);

describe("dismissInterrupted by write", () => {
  test("resolves an interrupted rewrite: no marker is left, its ids stay burnt, no scene changes", () => {
    const set = stored([rewrite({ k: 2, sceneIds: [2, 3], stoppedBy: "network" })]);
    const outcome = applyEdit(set, { op: "dismissInterrupted", write: 2 });
    expect(outcome.kind).toBe("changed");
    expect(recordsOf(outcome)[0]).toMatchObject({ k: 2, closed: true, attemptIds: writeIdsOf(SET, 2) });
    expect(recordsOf(outcome)[0]).not.toHaveProperty("stoppedBy");
    expect(outcome.kind === "changed" ? outcome.set.scenes : null).toEqual(set.scenes);
  });

  test("resolves an interrupted idea write: «Не нужно» adds no scene", () => {
    const set = stored([idea({ k: 3, stoppedBy: "timeout" })]);
    const outcome = applyEdit(set, { op: "dismissInterrupted", write: 3 });
    expect(recordsOf(outcome)[0]).toMatchObject({ k: 3, closed: true });
    expect(outcome.kind === "changed" ? outcome.set.scenes.length : -1).toBe(4);
  });

  test("another write's marker is not touched", () => {
    const set = stored([rewrite({ k: 2, sceneIds: [1], stoppedBy: "network" }), idea({ k: 3, stoppedBy: "timeout" })]);
    const outcome = applyEdit(set, { op: "dismissInterrupted", write: 3 });
    expect(recordsOf(outcome)[0]).toEqual(rewrite({ k: 2, sceneIds: [1], stoppedBy: "network" }));
  });

  test("a write the set does not have is refused and nothing changes", () => {
    expect(applyEdit(stored([rewrite({ k: 2 })]), { op: "dismissInterrupted", write: 9 })).toMatchObject({ kind: "invalid" });
  });

  test("a write that is already resolved is refused: there is nothing to dismiss", () => {
    expect(applyEdit(stored([rewrite({ k: 2, closed: true })]), { op: "dismissInterrupted", write: 2 })).toMatchObject({ kind: "invalid" });
  });

  test("the compose or «Дописать» write is not one of these: its number is refused", () => {
    expect(applyEdit(stored([rewrite({ k: 2 })], { write: { k: 1, kind: "compose", jobId: "job-aaaa-0001" } }), { op: "dismissInterrupted", write: 1 })).toMatchObject({ kind: "invalid" });
  });
});

describe("dismissInterrupted by scenes", () => {
  test("drops the marker of those scenes; the write keeps the others, and can still be resumed for them", () => {
    const set = stored([rewrite({ k: 2, sceneIds: [2, 3], stoppedBy: "network" })]);
    const outcome = applyEdit(set, { op: "dismissInterrupted", sceneIds: [2] });
    expect(recordsOf(outcome)[0]).toMatchObject({ k: 2, closed: false, sceneIds: [3], stoppedBy: "network" });
  });

  test("dismissing every scene of a write resolves it, its ids stay burnt", () => {
    const set = stored([rewrite({ k: 2, sceneIds: [2, 3], stoppedBy: "network" })]);
    const outcome = applyEdit(set, { op: "dismissInterrupted", sceneIds: [2, 3] });
    expect(recordsOf(outcome)[0]).toMatchObject({ k: 2, closed: true, attemptIds: writeIdsOf(SET, 2) });
  });

  test("drops the draw of a dismissed redrawn scene with it", () => {
    const base = stored([]);
    const slot = (sceneId: number) => {
      const scene = base.scenes.find((s) => s.sceneId === sceneId);
      return scene?.origin === "planned" ? scene.slot : null;
    };
    const set = stored([rewrite({ k: 2, sceneIds: [2, 3], redraw: true, slots: [slot(2), slot(3)], stoppedBy: "network" })]);
    const outcome = applyEdit(set, { op: "dismissInterrupted", sceneIds: [2] });
    expect(recordsOf(outcome)[0]).toMatchObject({ sceneIds: [3], slots: [{ slotIndex: 3 }] });
  });

  test("a scene with no interrupted write is refused, and the whole change with it", () => {
    const set = stored([rewrite({ k: 2, sceneIds: [2], stoppedBy: "network" })]);
    expect(applyEdit(set, { op: "dismissInterrupted", sceneIds: [2, 4] })).toMatchObject({ kind: "invalid" });
  });

  test("a scene the set does not have is refused", () => {
    expect(applyEdit(stored([rewrite({ k: 2 })]), { op: "dismissInterrupted", sceneIds: [99] })).toMatchObject({ kind: "invalid" });
  });

  test("the scenes of an idea write are not a rewrite's: dismissing by scene is for rewrites", () => {
    const set = stored([idea({ k: 3 })]);
    expect(applyEdit(set, { op: "dismissInterrupted", sceneIds: [5] })).toMatchObject({ kind: "invalid" });
  });

  test("another scene's marker survives", () => {
    const set = stored([rewrite({ k: 2, sceneIds: [1], stoppedBy: "network" }), rewrite({ k: 3, sceneIds: [3], stoppedBy: "timeout" })]);
    const outcome = applyEdit(set, { op: "dismissInterrupted", sceneIds: [3] });
    expect(recordsOf(outcome)[0]).toEqual(rewrite({ k: 2, sceneIds: [1], stoppedBy: "network" }));
  });
});

describe("a hand edit of an own scene", () => {
  const withOwn = (): StoredSceneSet => ({ ...stored([]), scenes: [...stored([]).scenes, ownScene(5)] }) as StoredSceneSet;

  test("is verbatim and marks the scene edited, like any scene", () => {
    const outcome = applyEdit(withOwn(), { op: "text", sceneId: 5, text: "  She waves from the balcony.  " });
    expect(outcome.kind === "changed" ? outcome.set.scenes.find((s) => s.sceneId === 5) : null).toMatchObject({ origin: "own", text: "She waves from the balcony.", edited: true, idea: "кофе на балконе утром" });
  });

  test("goes through the same word rule", () => {
    expect(applyEdit(withOwn(), { op: "text", sceneId: 5, text: "She walks in a bikini." })).toMatchObject({ kind: "problem", problem: { reason: "revealing-word" } });
  });

  test("an own scene is removed and restored like any other", () => {
    const removed = applyEdit(withOwn(), { op: "remove", sceneIds: [5] });
    expect(removed.kind === "changed" ? removed.set.scenes.find((s) => s.sceneId === 5)?.removed : null).toBe(true);
  });
});
