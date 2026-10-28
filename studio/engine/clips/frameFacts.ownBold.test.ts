import { describe, expect, test } from "bun:test";
import { boldContentLevel } from "../../shared/scenes/contentLine";
import type { OwnPlanSlot } from "../scenes/schema";
import { clipFallbackOf, frameFactsOf, type FrameFacts } from "./frameFacts";
import { photoOf, sceneRun } from "./testing/frameFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA9, plan s5a4 §8 BA9, I5.79): a photo of an own scene of a «Смелая» set is a «Смелая» frame: its facts follow the own slot's marker (`isBoldFrame`, `contentLevelOf` with the
// route), so its clip is Kling's alone. An own scene off the route reads as before: ordinary, with Grok behind Kling.

const TEXT = "She lies across her bed in a black lace bra and panties, propped on one elbow.";

function factsOf(route: "seedream" | undefined): FrameFacts {
  const run = sceneRun("run-00000009", [{ kind: "own", shot: "friend", pose: "front", text: TEXT, ...(route === undefined ? {} : { route }) }]);
  const own = run.scenes.slots[0] as OwnPlanSlot;
  const result = frameFactsOf(photoOf(run, own), run);
  if (result.kind !== "gallery") throw new Error("expected a gallery photo");
  return result.facts;
}

describe("the frame facts of an own scene (S5.BA9)", () => {
  test("on the route: a «Смелая» frame at the «Смелая» level, Kling's alone", () => {
    const facts = factsOf("seedream");
    expect(facts).toMatchObject({ plan: "own", category: "own", bold: true });
    expect(facts.level).toBe(boldContentLevel());
    expect(clipFallbackOf(facts)).toBe("none");
  });

  test("off the route: ordinary, as before", () => {
    const facts = factsOf(undefined);
    expect(facts).toMatchObject({ plan: "own", category: "own", bold: false, level: "ordinary" });
    expect(clipFallbackOf(facts)).not.toBe("none");
  });
});
