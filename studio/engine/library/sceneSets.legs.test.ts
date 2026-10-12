import { describe, expect, test } from "bun:test";
import { SceneSetStore } from "./sceneSets";
import { sampleSet } from "./testing/sceneSetSample";
import { steppingClock, useTempDir } from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.8a (I5.27): a scene set's record keeps «Ножки» through a write and a read: the request's `legsShare`, and each legs scene's `framing` and `capture` on its slot.
// A record written before them has neither and reads as it was.

const root = useTempDir("studio-scene-sets-legs-");

function store(): SceneSetStore {
  return new SceneSetStore(root(), { now: steppingClock("2026-10-07T12:00:00.000Z") });
}

describe("a scene set's legs fields", () => {
  test("the share, a legs scene's framing and its capture survive a create and a get", async () => {
    const sample = sampleSet({ count: 4 });
    const [first, ...rest] = sample.scenes;
    if (first?.origin !== "planned") throw new Error("the sample plans scenes");
    const legs = { ...first, slot: { ...first.slot, shot: "selfie" as const, pose: "front" as const, framing: "legs" as const, capture: "pov-legs" as const } };
    const s = store();
    await s.create({ ...sample, request: { ...sample.request, legsShare: 15 }, scenes: [legs, ...rest] });
    const read = await s.get("avatar-aaaa-0001", sample.sceneSetId);
    expect(read?.request.legsShare).toBe(15);
    const [back] = read?.scenes ?? [];
    expect(back?.origin === "planned" ? back.slot.framing : undefined).toBe("legs");
    expect(back?.origin === "planned" ? back.slot.capture : undefined).toBe("pov-legs");
  });

  test("a set written without them reads with none", async () => {
    const sample = sampleSet({ count: 4 });
    const s = store();
    await s.create(sample);
    const read = await s.get("avatar-aaaa-0001", sample.sceneSetId);
    expect("legsShare" in (read?.request ?? {})).toBe(false);
    for (const scene of read?.scenes ?? []) if (scene.origin === "planned") expect("framing" in scene.slot).toBe(false);
  });
});
