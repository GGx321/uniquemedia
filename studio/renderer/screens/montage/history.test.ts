import { describe, expect, test } from "bun:test";
import { canRedo, canUndo, commitVersion, MAX_SPEC_VERSIONS, redoVersion, startHistory, undoVersion, type History } from "./history";

// The editor's undo/redo (3d.2): at most 100 spec versions are kept in the renderer, a new edit drops the redo
// branch, and an edit that changes nothing is not a version.

const v = (n: number) => ({ clips: [{ durationMs: n * 100 }] });

function commitMany(h: History<ReturnType<typeof v>>, from: number, to: number): History<ReturnType<typeof v>> {
  let next = h;
  for (let n = from; n <= to; n++) next = commitVersion(next, v(n));
  return next;
}

function undoAll<T>(h: History<T>): { h: History<T>; steps: number } {
  let next = h;
  let steps = 0;
  while (canUndo(next)) {
    next = undoVersion(next);
    steps += 1;
  }
  return { h: next, steps };
}

describe("undo and redo", () => {
  test("a fresh history has nothing to undo or redo", () => {
    const h = startHistory(v(1));
    expect(h.present).toEqual(v(1));
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  test("undo walks back version by version and redo walks forward again", () => {
    const h = commitMany(startHistory(v(1)), 2, 4);
    const back1 = undoVersion(h);
    const back2 = undoVersion(back1);
    expect(back1.present).toEqual(v(3));
    expect(back2.present).toEqual(v(2));
    expect(redoVersion(back2).present).toEqual(v(3));
    expect(redoVersion(redoVersion(back2)).present).toEqual(v(4));
    expect(canRedo(redoVersion(redoVersion(back2)))).toBe(false);
  });

  test("undo with nothing behind and redo with nothing ahead change nothing", () => {
    const h = startHistory(v(1));
    expect(undoVersion(h)).toBe(h);
    expect(redoVersion(h)).toBe(h);
  });

  test("a new edit after an undo drops the redo branch", () => {
    const h = commitVersion(undoVersion(commitMany(startHistory(v(1)), 2, 3)), v(9));
    expect(h.present).toEqual(v(9));
    expect(canRedo(h)).toBe(false);
    expect(undoVersion(h).present).toEqual(v(2));
  });

  test("an edit equal to the present is not a version, whatever its key order", () => {
    const h = startHistory({ a: 1, b: [1, 2] });
    const same = commitVersion(h, { b: [1, 2], a: 1 });
    expect(same).toBe(h);
    expect(canUndo(same)).toBe(false);
  });
});

describe("the cap: at most 100 spec versions", () => {
  test("the cap is 100", () => {
    expect(MAX_SPEC_VERSIONS).toBe(100);
  });

  test("100 versions are all reachable: 99 undos from the newest", () => {
    const h = commitMany(startHistory(v(1)), 2, 100);
    const { h: oldest, steps } = undoAll(h);
    expect(steps).toBe(99);
    expect(oldest.present).toEqual(v(1));
  });

  test("the 101st version drops the oldest one, not the newest", () => {
    const h = commitMany(startHistory(v(1)), 2, 101);
    expect(h.past.length + 1 + h.future.length).toBe(100);
    const { h: oldest, steps } = undoAll(h);
    expect(steps).toBe(99);
    expect(oldest.present).toEqual(v(2));
  });

  test("a long session keeps exactly the latest 100", () => {
    const h = commitMany(startHistory(v(1)), 2, 250);
    const { h: oldest, steps } = undoAll(h);
    expect(steps).toBe(99);
    expect(oldest.present).toEqual(v(151));
  });

  test("undo and redo never grow the stack past the cap", () => {
    let h = commitMany(startHistory(v(1)), 2, 100);
    for (let i = 0; i < 50; i++) h = undoVersion(h);
    for (let i = 0; i < 50; i++) h = redoVersion(h);
    expect(h.past.length + 1 + h.future.length).toBe(100);
    expect(h.present).toEqual(v(100));
  });

  test("a smaller cap is honoured, down to one version", () => {
    const h = commitVersion(commitVersion(startHistory(v(1)), v(2), { limit: 1 }), v(3), { limit: 1 });
    expect(h.present).toEqual(v(3));
    expect(canUndo(h)).toBe(false);
  });
});

describe("merged edits: one version for a burst of the same edit (a slider drag)", () => {
  test("edits with the same key replace the version on top instead of stacking", () => {
    let h = commitVersion(startHistory(v(1)), v(2));
    h = commitVersion(h, v(3), { mergeKey: "clip-001.durationMs" });
    h = commitVersion(h, v(4), { mergeKey: "clip-001.durationMs" });
    h = commitVersion(h, v(5), { mergeKey: "clip-001.durationMs" });
    expect(h.present).toEqual(v(5));
    expect(undoVersion(h).present).toEqual(v(2));
  });

  test("another key, an unkeyed edit, or an undo in between starts a new version", () => {
    let h = commitVersion(startHistory(v(1)), v(2), { mergeKey: "a" });
    h = commitVersion(h, v(3), { mergeKey: "b" });
    expect(undoVersion(h).present).toEqual(v(2));

    h = commitVersion(h, v(4));
    h = commitVersion(h, v(5), { mergeKey: "b" });
    expect(undoVersion(h).present).toEqual(v(4));

    const undone = undoVersion(h);
    const after = commitVersion(undone, v(6), { mergeKey: "b" });
    expect(undoVersion(after).present).toEqual(v(4));
  });

  test("the first keyed edit is its own version: the state before it stays reachable", () => {
    const h = commitVersion(startHistory(v(1)), v(2), { mergeKey: "a" });
    expect(undoVersion(h).present).toEqual(v(1));
  });
});
