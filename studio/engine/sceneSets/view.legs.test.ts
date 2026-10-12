import { describe, expect, test } from "bun:test";
import { SceneSetView } from "../../shared/engine";
import type { PlannedSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { fakeLedger } from "./testing/fakeLedger";
import { buildSceneSetView } from "./view";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.8a: a scene shows `framing: "legs"` when its slot is a legs slot, and none otherwise (the echo rule of S5.7a: a field is shown only when it says something).

function stored(over: Partial<PlannedSceneSet> = {}): PlannedSceneSet {
  return { schemaVersion: 1, revision: 4, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:30:00.000Z", ...sampleSet({ count: 4 }), ...over } as PlannedSceneSet;
}

function viewOf(set: PlannedSceneSet): SceneSetView {
  const view = buildSceneSetView(set, { ledger: fakeLedger({}), inFlight: new Set(), live: null, used: false });
  expect(SceneSetView.safeParse(view).success).toBe(true);
  return view;
}

describe("a scene's framing", () => {
  test("a legs scene shows its framing and its capture", () => {
    const set = stored();
    const [first, ...rest] = set.scenes;
    if (first?.origin !== "planned") throw new Error("the sample plans scenes");
    const view = viewOf({ ...set, scenes: [{ ...first, slot: { ...first.slot, shot: "selfie", framing: "legs", capture: "pov-legs" } }, ...rest] } as PlannedSceneSet);
    expect(view.scenes[0]?.framing).toBe("legs");
    expect(view.scenes[0]?.capture).toBe("pov-legs");
  });

  test("a scene whose slot has no framing shows none", () => {
    const view = viewOf(stored());
    for (const scene of view.scenes) expect("framing" in scene).toBe(false);
  });
});
