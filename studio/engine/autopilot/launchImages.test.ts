import { describe, expect, test } from "bun:test";
import type { SliceStatus } from "../sceneSets/launchDraw";
import { launchDrawFit, launchDrawLeft, launchPhotosLeft, type LaunchSetFacts } from "./launchImages";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S4.6p: the pure part of `runs.estimateImages { launchId, avatarId }`.

const scene = (text: string | null, removed = false, origin: "planned" | "own" = "planned") => ({ removed, text, origin });
const statuses = (entries: [string, SliceStatus][]): Map<string, SliceStatus> => new Map(entries);

describe("launchPhotosLeft", () => {
  test("before the draw is frozen it is the active scenes with a text", () => {
    const set: LaunchSetFacts = { scenes: [scene("a"), scene("b"), scene(null), scene("d", true)] };
    expect(launchPhotosLeft(set, statuses([]))).toBe(2);
  });

  test("a set with no scene has nothing to draw", () => {
    expect(launchPhotosLeft({ scenes: [] }, statuses([]))).toBe(0);
  });

  test("once frozen it is the scenes no slice has taken, whatever the scenes say now", () => {
    const set: LaunchSetFacts = { scenes: [scene("a"), scene("b")], launchDraw: { sceneIds: [1, 2, 3, 4, 5], slices: [{ runId: "run-1", sceneIds: [1, 2], capMicros: 300_000 }] } };
    expect(launchPhotosLeft(set, statuses([["run-1", { finished: true, committedMicros: 100_000 }]]))).toBe(3);
  });

  test("adds the open slots of a slice that began and is not finished", () => {
    const set: LaunchSetFacts = { scenes: [], launchDraw: { sceneIds: [1, 2, 3, 4, 5], slices: [{ runId: "run-1", sceneIds: [1, 2, 3], capMicros: 450_000 }] } };
    expect(launchPhotosLeft(set, statuses([["run-1", { finished: false, openSlots: 2 }]]))).toBe(4);
  });

  test("a finished slice gives no open slot back", () => {
    const set: LaunchSetFacts = { scenes: [], launchDraw: { sceneIds: [1, 2, 3], slices: [{ runId: "run-1", sceneIds: [1, 2, 3], capMicros: 450_000 }] } };
    expect(launchPhotosLeft(set, statuses([["run-1", { finished: true, committedMicros: 150_000 }]]))).toBe(0);
  });

  test("a slice whose run cannot be read counts no slot (its scenes are taken)", () => {
    const set: LaunchSetFacts = { scenes: [], launchDraw: { sceneIds: [1, 2, 3], slices: [{ runId: "run-1", sceneIds: [1, 2], capMicros: 300_000 }] } };
    expect(launchPhotosLeft(set, statuses([["run-1", { finished: false }]]))).toBe(1);
  });
});

describe("launchDrawLeft", () => {
  const set: LaunchSetFacts = {
    scenes: [],
    launchDraw: {
      sceneIds: [1, 2, 3, 4],
      slices: [
        { runId: "run-1", sceneIds: [1, 2], capMicros: 300_000 },
        { runId: "run-2", sceneIds: [3], capMicros: 150_000 },
      ],
    },
  };

  test("is the whole allocation before any slice", () => {
    expect(launchDrawLeft(600_000, { scenes: [] }, statuses([]))).toBe(600_000);
  });

  test("takes off what a finished slice committed, not its cap", () => {
    expect(launchDrawLeft(600_000, set, statuses([["run-1", { finished: true, committedMicros: 120_000 }]]))).toBe(480_000);
  });

  test("takes off the whole cap of a live slice", () => {
    expect(launchDrawLeft(600_000, set, statuses([["run-1", { finished: true, committedMicros: 120_000 }], ["run-2", { finished: false, openSlots: 1 }]]))).toBe(330_000);
  });

  test("is never below zero", () => {
    expect(launchDrawLeft(100_000, set, statuses([["run-1", { finished: false, openSlots: 2 }]]))).toBe(0);
  });
});

describe("launchPhotosLeft before the freeze", () => {
  test("counts only the planned scenes, as the launch's approval does: an own scene is not drawn by it", () => {
    const set: LaunchSetFacts = { scenes: [scene("a"), scene("b", false, "own"), scene("c")] };
    expect(launchPhotosLeft(set, statuses([]))).toBe(2);
  });
});

describe("launchDrawFit", () => {
  const W = 150_000;
  const slice = (runId: string, sceneIds: number[], capMicros: number) => ({ runId, sceneIds, capMicros });

  test("with no slice every photo fits an allocation that buys them", () => {
    const set: LaunchSetFacts = { scenes: [scene("a"), scene("b"), scene("c")] };
    expect(launchDrawFit(set, statuses([]), 3 * W, W)).toEqual({ left: 3, photos: 3 });
  });

  test("an allocation that buys fewer photos (the price rose since the plan) fits only those, and says how many are left", () => {
    const set: LaunchSetFacts = { scenes: [scene("a"), scene("b"), scene("c")] };
    expect(launchDrawFit(set, statuses([]), 2 * W + 1, W)).toEqual({ left: 3, photos: 2 });
  });

  test("the first slice is active and holds the WHOLE allocation: its open slots are paid from its own cap, so all of them fit", () => {
    const set: LaunchSetFacts = { scenes: [], launchDraw: { sceneIds: [1, 2, 3], slices: [slice("run-1", [1, 2, 3], 3 * W)] } };
    expect(launchDrawFit(set, statuses([["run-1", { finished: false, openSlots: 3 }]]), 3 * W, W)).toEqual({ left: 3, photos: 3 });
  });

  test("a first slice of 25 active and 5 scenes not yet in a slice: the 25 are paid by the slice, the 5 by what it leaves", () => {
    const ids = Array.from({ length: 30 }, (_, i) => i + 1);
    const set: LaunchSetFacts = { scenes: [], launchDraw: { sceneIds: ids, slices: [slice("run-1", ids.slice(0, 25), 25 * W)] } };
    expect(launchDrawFit(set, statuses([["run-1", { finished: false, openSlots: 25 }]]), 30 * W, W)).toEqual({ left: 30, photos: 30 });
  });

  test("scenes not yet in a slice fit only the allocation the live slice leaves them", () => {
    const ids = Array.from({ length: 30 }, (_, i) => i + 1);
    const set: LaunchSetFacts = { scenes: [], launchDraw: { sceneIds: ids, slices: [slice("run-1", ids.slice(0, 25), 25 * W)] } };
    expect(launchDrawFit(set, statuses([["run-1", { finished: false, openSlots: 25 }]]), 28 * W, W)).toEqual({ left: 30, photos: 28 });
  });

  test("a finished slice that spent less than its cap gives the slack back to the scenes after it", () => {
    const set: LaunchSetFacts = { scenes: [], launchDraw: { sceneIds: [1, 2, 3, 4], slices: [slice("run-1", [1, 2], 2 * W)] } };
    expect(launchDrawFit(set, statuses([["run-1", { finished: true, committedMicros: W }]]), 4 * W, W)).toEqual({ left: 2, photos: 2 });
  });

  test("open slots never fit past their slice's own cap", () => {
    const set: LaunchSetFacts = { scenes: [], launchDraw: { sceneIds: [1, 2, 3], slices: [slice("run-1", [1, 2, 3], 2 * W)] } };
    expect(launchDrawFit(set, statuses([["run-1", { finished: false, openSlots: 3 }]]), 3 * W, W)).toEqual({ left: 3, photos: 2 });
  });

  test("nothing is left once every slice is finished", () => {
    const set: LaunchSetFacts = { scenes: [], launchDraw: { sceneIds: [1], slices: [slice("run-1", [1], W)] } };
    expect(launchDrawFit(set, statuses([["run-1", { finished: true, committedMicros: W }]]), W, W)).toEqual({ left: 0, photos: 0 });
  });
});
