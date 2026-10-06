import { describe, expect, test } from "bun:test";
import { SCENE_TEXT_MAX } from "../../shared/engine";
import type { StoredSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { applyEdit, textProblem } from "./edit";

// CS.4a: the owner's free edits. A text is checked by the assembler's own rule (`sentenceProblems`) the moment it is typed, plus technical bounds;
// remove and restore take one scene or many in ONE change; nothing a refusal says changes the set.

function stored(count = 6): StoredSceneSet {
  return { schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...sampleSet({ count, written: 2 }) };
}

const scene = (set: StoredSceneSet, sceneId: number) => {
  const found = set.scenes.find((s) => s.sceneId === sceneId);
  if (found === undefined) throw new Error(`no scene ${sceneId}`);
  return found;
};

function changedSet(outcome: ReturnType<typeof applyEdit>): StoredSceneSet {
  if (outcome.kind !== "changed") throw new Error(`expected a change, got ${outcome.kind}`);
  return outcome.set;
}

describe("textProblem", () => {
  test("lets a sentence through", () => {
    expect(textProblem("She waves from the pier at golden hour.")).toBeNull();
  });

  test("lets a text in another script through: verbatim is the owner's call", () => {
    expect(textProblem("Она машет рукой с пирса на закате.")).toBeNull();
  });

  test.each(["", "   ", "\t "])("a text with nothing in it is empty: %j", (text) => {
    expect(textProblem(text)).toEqual({ reason: "empty", words: [] });
  });

  test("is too long past 600 characters, and fine at 600", () => {
    expect(textProblem("a".repeat(SCENE_TEXT_MAX))).toBeNull();
    expect(textProblem("a".repeat(SCENE_TEXT_MAX + 1))).toEqual({ reason: "too-long", words: [] });
  });

  test.each(["first\nsecond", "first\r\nsecond", "first second"])("a text of more than one line is refused: %j", (text) => {
    expect(textProblem(text)).toEqual({ reason: "not-one-line", words: [] });
  });

  test("a control character other than a line break is refused", () => {
    expect(textProblem("she waves\u0007 from the pier")).toEqual({ reason: "control-char", words: [] });
    expect(textProblem("she\twaves")).toEqual({ reason: "control-char", words: [] });
  });

  test("a revealing word is named, as the assembler's last gate would name it", () => {
    expect(textProblem("She walks the beach in a bikini.")).toEqual({ reason: "revealing-word", words: ["bikini"] });
  });

  test("a youth word is named, and comes before a revealing one", () => {
    expect(textProblem("A teenage girl in a bikini.")).toMatchObject({ reason: "youth-word" });
    expect(textProblem("A teenage girl in a bikini.")?.words.length).toBeGreaterThan(0);
  });

  test("a text too long is told so before its words are looked at", () => {
    expect(textProblem(`${"a ".repeat(400)}bikini`)?.reason).toBe("too-long");
  });
});

describe("applyEdit: text", () => {
  test("sets the scene's text as the owner typed it and marks it his", () => {
    const set = stored();
    const next = changedSet(applyEdit(set, { op: "text", sceneId: 1, text: "She waves from the pier." }));
    expect(scene(next, 1)).toMatchObject({ text: "She waves from the pier.", edited: true });
    expect(scene(next, 2)).toEqual(scene(set, 2));
  });

  test("keeps the text verbatim except for the spaces at its edges", () => {
    const next = changedSet(applyEdit(stored(), { op: "text", sceneId: 1, text: "  She  waves.  " }));
    expect(scene(next, 1).text).toBe("She  waves.");
  });

  test("a text typed into a scene still waiting for its sentence makes it written", () => {
    const set = stored();
    expect(scene(set, 4).text).toBeNull();
    const next = changedSet(applyEdit(set, { op: "text", sceneId: 4, text: "She laughs at the market." }));
    expect(scene(next, 4)).toMatchObject({ text: "She laughs at the market.", edited: true });
  });

  test("does not touch the chunks: which attempts a chunk has left is the ledger's business", () => {
    const set = stored();
    expect(changedSet(applyEdit(set, { op: "text", sceneId: 4, text: "Typed." })).chunks).toEqual(set.chunks);
  });

  test("a problem is a result, and the set it came from is not changed", () => {
    const set = stored();
    const outcome = applyEdit(set, { op: "text", sceneId: 1, text: "She wears a bikini." });
    expect(outcome).toEqual({ kind: "problem", problem: { reason: "revealing-word", words: ["bikini"] } });
  });

  test("the same text typed again changes nothing", () => {
    const first = changedSet(applyEdit(stored(), { op: "text", sceneId: 1, text: "She waves." }));
    expect(applyEdit(first, { op: "text", sceneId: 1, text: "She waves." })).toEqual({ kind: "unchanged" });
  });

  test("the writer's own sentence retyped is the owner's now", () => {
    const set = stored();
    const next = changedSet(applyEdit(set, { op: "text", sceneId: 1, text: scene(set, 1).text ?? "" }));
    expect(scene(next, 1).edited).toBe(true);
  });

  test("a scene the set does not have is refused", () => {
    expect(applyEdit(stored(), { op: "text", sceneId: 99, text: "Typed." })).toMatchObject({ kind: "invalid" });
  });

  test("a removed scene is not edited: it is restored first", () => {
    const removed = changedSet(applyEdit(stored(), { op: "remove", sceneIds: [1] }));
    expect(applyEdit(removed, { op: "text", sceneId: 1, text: "Typed." })).toMatchObject({ kind: "invalid" });
  });
});

describe("applyEdit: remove and restore", () => {
  test("removes one scene and keeps it, greyed, with its text", () => {
    const set = stored();
    const next = changedSet(applyEdit(set, { op: "remove", sceneIds: [2] }));
    expect(scene(next, 2)).toEqual({ ...scene(set, 2), removed: true });
    expect(next.scenes).toHaveLength(set.scenes.length);
  });

  test("removes many scenes in one change, written, waiting and given up alike", () => {
    const set = stored(6);
    const next = changedSet(applyEdit(set, { op: "remove", sceneIds: [1, 3, 5, 6] }));
    expect(next.scenes.filter((s) => s.removed).map((s) => s.sceneId)).toEqual([1, 3, 5, 6]);
    expect(next.scenes.filter((s) => !s.removed).map((s) => s.sceneId)).toEqual([2, 4]);
  });

  test("removing a scene already removed changes nothing, and nothing at all is not a change", () => {
    const removed = changedSet(applyEdit(stored(), { op: "remove", sceneIds: [2] }));
    expect(applyEdit(removed, { op: "remove", sceneIds: [2] })).toEqual({ kind: "unchanged" });
    expect(changedSet(applyEdit(removed, { op: "remove", sceneIds: [2, 3] })).scenes.filter((s) => s.removed).map((s) => s.sceneId)).toEqual([2, 3]);
  });

  test("a scene the set does not have refuses the whole removal and removes none", () => {
    const set = stored();
    expect(applyEdit(set, { op: "remove", sceneIds: [1, 99] })).toMatchObject({ kind: "invalid" });
  });

  test("restores a removed scene as it was, text and all", () => {
    const set = stored();
    const removed = changedSet(applyEdit(set, { op: "remove", sceneIds: [1, 4] }));
    const restored = changedSet(applyEdit(removed, { op: "restore", sceneIds: [1, 4] }));
    expect(restored.scenes).toEqual(set.scenes);
  });

  test("restoring a scene that is not removed changes nothing", () => {
    expect(applyEdit(stored(), { op: "restore", sceneIds: [1] })).toEqual({ kind: "unchanged" });
  });

  test("a scene the set does not have refuses a restore", () => {
    expect(applyEdit(stored(), { op: "restore", sceneIds: [99] })).toMatchObject({ kind: "invalid" });
  });
});
