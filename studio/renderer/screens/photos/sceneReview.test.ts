import { describe, expect, test } from "bun:test";
import {
  emptySceneIds,
  hasCyrillic,
  interruptedRewrites,
  otherSceneTargets,
  placeholderIds,
  readSceneReview,
  SCENE_REVIEW_KEY,
  sceneCategoryLabel,
  sceneNumber,
  setAction,
  setCategoryTags,
  tallyScenes,
  writeCapRefusal,
  writeSceneReview,
} from "./sceneReview";
import { gaveUp, pending, scene, sceneSet, written } from "./sceneFixtures";

// CS.6: what the review UI derives from the engine's scene set view, as pure functions: the counts, what the card's button does, which scenes «Убрать N
// пустых» and «Другие сцены для N» name, the interrupted rewrites grouped by write, the placeholders of an idea write, the strip's category tags, and the
// switch remembered per machine.

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  };
}

const throwing = {
  getItem: (): string | null => {
    throw new Error("blocked");
  },
  setItem: (): void => {
    throw new Error("blocked");
  },
  removeItem: (): void => {
    throw new Error("blocked");
  },
};

describe("the «Сцены на проверку» switch, remembered per machine", () => {
  test("on by default, on when unreadable, off only when stored off", () => {
    expect(readSceneReview(memoryStorage())).toBe(true);
    expect(readSceneReview(null)).toBe(true);
    expect(readSceneReview(throwing)).toBe(true);
    expect(readSceneReview(memoryStorage({ [SCENE_REVIEW_KEY]: "off" }))).toBe(false);
    expect(readSceneReview(memoryStorage({ [SCENE_REVIEW_KEY]: "on" }))).toBe(true);
    expect(readSceneReview(memoryStorage({ [SCENE_REVIEW_KEY]: "garbage" }))).toBe(true);
  });

  test("written as on or off; a storage that throws keeps nothing and does not throw", () => {
    const storage = memoryStorage();
    writeSceneReview(storage, false);
    expect(storage.items.get(SCENE_REVIEW_KEY)).toBe("off");
    writeSceneReview(storage, true);
    expect(storage.items.get(SCENE_REVIEW_KEY)).toBe("on");
    expect(() => writeSceneReview(throwing, false)).not.toThrow();
    expect(() => writeSceneReview(null, false)).not.toThrow();
  });
});

describe("labels", () => {
  test("a scene's number has two digits at least", () => {
    expect(sceneNumber(2)).toBe("02");
    expect(sceneNumber(26)).toBe("26");
    expect(sceneNumber(120)).toBe("120");
  });

  test("a scene's category: a built-in by the app's label, a custom one by the set's own name, an own scene «Своя сцена»", () => {
    expect(sceneCategoryLabel(scene(1))).toBe("Дом");
    expect(sceneCategoryLabel(scene(1, { category: "cat-seeded-0001", categoryName: "Кофейни Парижа" }))).toBe("Кофейни Парижа");
    expect(sceneCategoryLabel(scene(1, { category: "cat-seeded-0001", categoryName: null }))).toBe("Своя категория");
    expect(sceneCategoryLabel(scene(1, { origin: "own" }))).toBe("Своя сцена");
  });

  test("Cyrillic is told apart from Latin text", () => {
    expect(hasCyrillic("Селфи на кровати")).toBe(true);
    expect(hasCyrillic("Mirror selfie, ёлка")).toBe(true);
    expect(hasCyrillic("Mirror selfie in a bathroom")).toBe(false);
  });
});

describe("tallyScenes", () => {
  test("counts what the header and the buttons say: active, removed, with text, waiting, given up, own", () => {
    const scenes = [scene(1), scene(2, { removed: true }), pending(3), pending(4, { removed: true }), gaveUp(5), scene(6, { origin: "own" })];
    expect(tallyScenes(scenes)).toEqual({ total: 6, active: 4, removed: 2, withText: 2, pending: 1, gaveUp: 1, own: 1 });
  });

  test("an empty set counts nothing", () => {
    expect(tallyScenes([])).toEqual({ total: 0, active: 0, removed: 0, withText: 0, pending: 0, gaveUp: 0, own: 0 });
  });
});

describe("setAction: what the card's button does for an open set", () => {
  test("a compose or a «Дописать» running: the card waits for it", () => {
    const write = { kind: "compose" as const, count: 20 };
    expect(setAction(sceneSet([pending(1)], { status: "writing", write }))).toEqual({ kind: "writing", write });
    const more = { kind: "unwritten" as const, count: 35 };
    expect(setAction(sceneSet([pending(1)], { status: "writing", write: more }))).toEqual({ kind: "writing", write: more });
  });

  test("scenes still waiting for their write: «Дописать» them, counting only the active ones", () => {
    const set = sceneSet([...written(25), ...Array.from({ length: 35 }, (_, i) => pending(26 + i)), pending(61, { removed: true })], { status: "stopped", stoppedBy: "closed" });
    expect(setAction(set)).toEqual({ kind: "continue", scenes: 35 });
  });

  test("everything active has text: «Отрисовать» the active scenes", () => {
    expect(setAction(sceneSet([...written(19), scene(20, { removed: true })]))).toEqual({ kind: "approve", photos: 19, block: null });
  });

  test("an active scene with no text blocks it, naming the first and how many more", () => {
    const set = sceneSet([...written(3), gaveUp(4), scene(5, { removed: true }), gaveUp(6), gaveUp(7, "refused", { removed: true })]);
    expect(setAction(set)).toEqual({ kind: "approve", photos: 3, block: { kind: "no-text", first: 4, others: 1 } });
  });

  test("a rewrite or an idea write running blocks it with the write", () => {
    const write = { kind: "rewrite" as const, count: 1, sceneIds: [2] };
    expect(setAction(sceneSet(written(19), { status: "writing", write }))).toEqual({ kind: "approve", photos: 19, block: { kind: "writing", write } });
  });

  test("no active scene: nothing to draw; more than a run draws: too many", () => {
    expect(setAction(sceneSet([]))).toEqual({ kind: "approve", photos: 0, block: { kind: "empty" } });
    expect(setAction(sceneSet([scene(1, { removed: true })]))).toEqual({ kind: "approve", photos: 0, block: { kind: "empty" } });
    expect(setAction(sceneSet(written(101)))).toEqual({ kind: "approve", photos: 101, block: { kind: "too-many", photos: 101 } });
    expect(setAction(sceneSet(written(100)))).toEqual({ kind: "approve", photos: 100, block: null });
  });
});

describe("the scenes the column's bulk buttons name", () => {
  test("«Убрать N пустых»: every active scene with no text, waiting or given up", () => {
    const set = sceneSet([scene(1), pending(2), gaveUp(3), pending(4, { removed: true }), gaveUp(5, "refused")]);
    expect(emptySceneIds(set)).toEqual([2, 3, 5]);
  });

  test("«Другие сцены для N»: the first five active scenes given up on", () => {
    const set = sceneSet([gaveUp(1, "rejected", { removed: true }), ...Array.from({ length: 7 }, (_, i) => gaveUp(2 + i)), pending(20)]);
    expect(otherSceneTargets(set)).toEqual([2, 3, 4, 5, 6]);
    expect(otherSceneTargets(sceneSet([gaveUp(4)]))).toEqual([4]);
    expect(otherSceneTargets(sceneSet(written(3)))).toEqual([]);
  });
});

describe("interruptedRewrites", () => {
  test("groups the marked scenes by their write, oldest write first, and says which of them are removed", () => {
    const set = sceneSet([
      scene(1),
      scene(2, { rewriteInterrupted: { write: 5, stoppedBy: "closed" } }),
      scene(3, { rewriteInterrupted: { write: 3, stoppedBy: "cancelled" } }),
      scene(4, { rewriteInterrupted: { write: 5, stoppedBy: "closed" }, removed: true }),
    ]);
    expect(interruptedRewrites(set)).toEqual([
      { write: 3, stoppedBy: "cancelled", sceneIds: [3], removed: [] },
      { write: 5, stoppedBy: "closed", sceneIds: [2, 4], removed: [4] },
    ]);
    expect(interruptedRewrites(sceneSet(written(3)))).toEqual([]);
  });
});

describe("placeholderIds", () => {
  test("an idea write running: as many placeholders as it writes, numbered after the set's last scene", () => {
    expect(placeholderIds(sceneSet(written(20), { status: "writing", write: { kind: "idea", count: 2 } }))).toEqual([21, 22]);
    expect(placeholderIds(sceneSet([], { status: "writing", write: { kind: "idea", count: 1 } }))).toEqual([1]);
  });

  test("none for any other write, or none at all", () => {
    expect(placeholderIds(sceneSet(written(3), { status: "writing", write: { kind: "rewrite", count: 1, sceneIds: [2] } }))).toEqual([]);
    expect(placeholderIds(sceneSet(written(3)))).toEqual([]);
  });
});

describe("setCategoryTags", () => {
  test("the set's own snapshot, in its order, with how many active planned scenes each holds", () => {
    const set = sceneSet(
      [
        scene(1),
        scene(2),
        scene(3, { category: "cat-seeded-0001", categoryName: "Кофейни Парижа" }),
        scene(4, { category: "cat-seeded-0001", categoryName: "Кофейни Парижа", removed: true }),
        scene(5, { origin: "own" }),
      ],
      {
        categories: [
          { ref: "home", name: null },
          { ref: "travel", name: null },
          { ref: "cat-seeded-0001", name: "Кофейни Парижа" },
        ],
      },
    );
    expect(setCategoryTags(set)).toEqual([
      { ref: "home", label: "Дом", count: 2 },
      { ref: "travel", label: "Путешествия", count: 0 },
      { ref: "cat-seeded-0001", label: "Кофейни Парижа", count: 1 },
    ]);
  });
});

describe("writeCapRefusal", () => {
  test("the engine's refusal of a set that recorded its 500 writes, and nothing else", () => {
    expect(writeCapRefusal({ code: "VALIDATION", detail: "a set records at most 500 writes of this kind" })).toBe(true);
    expect(writeCapRefusal({ code: "VALIDATION", detail: "the set has no scene 4" })).toBe(false);
    expect(writeCapRefusal({ code: "VALIDATION" })).toBe(false);
    expect(writeCapRefusal({ code: "INTERNAL", detail: "a set records at most 500 writes of this kind" })).toBe(false);
  });
});
