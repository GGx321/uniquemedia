import { describe, expect, test } from "bun:test";
import { SceneSetFile, type StoredSceneSet } from "../library/sceneSets";
import { ownScene, sampleSet } from "../library/testing/sceneSetSample";
import { CUSTOM_REF, customSnapshot } from "../scenes/testing/customPool";
import { approvalRefusal, runSnapshots, runSources } from "./toRun";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.5: what a set must be before it may become a run, and what it hands the run. Pure: the engine owns the money and the library.

function setOf(count: number, over: { removed?: number[]; textless?: number[] } = {}): StoredSceneSet {
  const set = sampleSet({ count, written: count });
  return SceneSetFile.parse({
    schemaVersion: 1,
    ...set,
    revision: 4,
    createdAt: "2026-10-07T12:00:00.000Z",
    updatedAt: "2026-10-07T12:00:00.000Z",
    scenes: set.scenes.map((s) => ({ ...s, removed: (over.removed ?? []).includes(s.sceneId), text: (over.textless ?? []).includes(s.sceneId) ? null : s.text })),
  });
}

const FREE = { revision: 4, live: false, used: false };

describe("approvalRefusal", () => {
  test("lets a ready set at its own revision through", () => {
    expect(approvalRefusal(setOf(5), FREE)).toBeNull();
  });

  test("a moved revision is SCENES_CHANGED", () => {
    expect(approvalRefusal(setOf(5), { ...FREE, revision: 3 })?.code).toBe("SCENES_CHANGED");
  });

  test("an active scene with no text is VALIDATION", () => {
    expect(approvalRefusal(setOf(5, { textless: [2] }), FREE)?.code).toBe("VALIDATION");
  });

  test("a removed scene with no text does not block", () => {
    expect(approvalRefusal(setOf(5, { textless: [2], removed: [2] }), FREE)).toBeNull();
  });

  test("no active scene is VALIDATION", () => {
    expect(approvalRefusal(setOf(2, { removed: [1, 2] }), FREE)?.code).toBe("VALIDATION");
  });

  test("100 active scenes pass and 101 are VALIDATION", () => {
    expect(approvalRefusal(setOf(101, { removed: [101] }), FREE)).toBeNull();
    expect(approvalRefusal(setOf(101), FREE)?.code).toBe("VALIDATION");
  });

  test("a set whose job runs is IN_FLIGHT", () => {
    expect(approvalRefusal(setOf(5), { ...FREE, live: true })?.code).toBe("IN_FLIGHT");
  });

  test("a set already used is VALIDATION", () => {
    expect(approvalRefusal(setOf(5), { ...FREE, used: true })?.code).toBe("VALIDATION");
  });

  describe("the order of the refusals", () => {
    test("revision before an empty text", () => {
      expect(approvalRefusal(setOf(5, { textless: [1] }), { ...FREE, revision: 9 })?.code).toBe("SCENES_CHANGED");
    });

    test("an empty text before a job running", () => {
      const refusal = approvalRefusal(setOf(5, { textless: [1] }), { ...FREE, live: true });
      expect(refusal?.code).toBe("VALIDATION");
      expect(refusal?.detail).toContain("no text");
    });

    test("a count of 0 before a job running", () => {
      const refusal = approvalRefusal(setOf(2, { removed: [1, 2] }), { ...FREE, live: true });
      expect(refusal?.code).toBe("VALIDATION");
    });

    test("a job running before a set already used", () => {
      expect(approvalRefusal(setOf(5), { ...FREE, live: true, used: true })?.code).toBe("IN_FLIGHT");
    });
  });
});

describe("runSources", () => {
  test("are the active scenes in the set's order, each with its own text and the slot the planner drew", () => {
    const set = setOf(5, { removed: [2] });
    const sources = runSources(set);
    expect(sources.map((s) => s.sceneId)).toEqual([1, 3, 4, 5]);
    expect<unknown>(sources.map((s) => s.text)).toEqual([1, 3, 4, 5].map((id) => set.scenes.find((s) => s.sceneId === id)?.text));
    const third = set.scenes[2];
    if (third?.origin !== "planned") throw new Error("the sample set is planned scenes only");
    expect(sources[1]?.slot).toBe(third.slot);
  });

  test("an own scene is a source with its shot, its pose and its text, in the set's order", () => {
    const base = setOf(3);
    const set = SceneSetFile.parse({ ...base, scenes: [...base.scenes, ownScene(4, { shot: "selfie", pose: "three-quarter", text: "She waves from the balcony." })] });
    const own = runSources(set).find((s) => s.sceneId === 4);
    expect(own).toEqual({ sceneId: 4, text: "She waves from the balcony.", slot: { kind: "own", shot: "selfie", pose: "three-quarter" } });
    expect(runSources(set).map((s) => s.sceneId)).toEqual([1, 2, 3, 4]);
  });

  test("a removed own scene is not a source", () => {
    const base = setOf(3);
    const set = SceneSetFile.parse({ ...base, scenes: [...base.scenes, ownScene(4, { removed: true })] });
    expect(runSources(set).map((s) => s.sceneId)).toEqual([1, 2, 3]);
  });

  test("an edited text is what the run gets", () => {
    const set = setOf(3);
    const edited = { ...set, scenes: set.scenes.map((s) => (s.sceneId === 2 ? { ...s, text: "Typed by the owner.", edited: true } : s)) };
    expect(runSources(edited).map((s) => s.text)).toContain("Typed by the owner.");
  });

  test("refuses a scene with no text instead of planning it", () => {
    expect(() => runSources(setOf(3, { textless: [2] }))).toThrow();
  });
});

describe("runSnapshots", () => {
  function customSet(removed: number[] = []): StoredSceneSet {
    const base = setOf(3, { removed });
    return SceneSetFile.parse({
      ...base,
      request: { ...base.request, categories: ["home", CUSTOM_REF] },
      categories: [customSnapshot()],
      scenes: base.scenes.map((s) => (s.sceneId === 2 && s.origin === "planned" ? { ...s, slot: { ...s.slot, category: CUSTOM_REF, location: "a corner cafe", timeOfDay: "morning", activity: "reading a menu", outfit: "a beige trench coat" } } : s)),
    });
  }

  test("keeps the snapshot of a custom category an active scene uses", () => {
    const set = customSet();
    expect(runSnapshots(set, runSources(set))).toEqual([customSnapshot()]);
  });

  test("drops it when the only scene that used it was removed", () => {
    const set = customSet([2]);
    expect(runSnapshots(set, runSources(set))).toEqual([]);
  });

  test("an own scene adds no snapshot and does not break the ones of the planned scenes", () => {
    const base = customSet();
    const set = SceneSetFile.parse({ ...base, scenes: [...base.scenes, ownScene(4)] });
    expect(runSnapshots(set, runSources(set))).toEqual([customSnapshot()]);
  });

  test("is empty for built-in scenes only", () => {
    const set = setOf(3);
    expect(runSnapshots(set, runSources(set))).toEqual([]);
  });
});
