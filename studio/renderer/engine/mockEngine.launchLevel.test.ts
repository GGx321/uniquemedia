import { describe, expect, test } from "bun:test";
import type { LaunchDraftInput, LaunchView, SceneSetView } from "../../shared/engine";
import { flirtyCountOf } from "../../shared/scenes/level";
import { MIA, runUntil, runWorld, startRun, unwrap } from "./mockLaunchRun.testkit";

// S5.7R carry-over (MEDIUM): the mock's launch composed its set without the draft's «Подача», so a flirty launch's set reviewed as ordinary. The engine's launch compose
// carries the draft's level (paidSteps `composeLookOf`), and the set it makes reads flirty: the mock's does the same, and only when the draft is flirty (I5.27).

const awaiting = (v: LaunchView): boolean => v.avatars.some((a) => a.phase === "awaiting-review");

async function launchSet(over: Partial<LaunchDraftInput>): Promise<SceneSetView> {
  const mock = runWorld();
  const started = await startRun(mock, { sceneReview: true, ...over });
  await runUntil(mock, started.launchId, "the review", awaiting);
  const got = await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }));
  if (got.sceneSet === null) throw new Error("the launch's set is not there");
  return got.sceneSet;
}

describe("a launch's set takes the draft's «Подача»", () => {
  test("a flirty launch reviews a flirty set: the set's level and round(0.6 × n) flirty scenes", async () => {
    const set = await launchSet({ level: "flirty" });
    expect(set.level).toBe("flirty");
    expect(set.scenes).toHaveLength(10);
    expect(set.scenes.filter((s) => s.level === "flirty")).toHaveLength(flirtyCountOf(10, "flirty"));
  });

  // 5a.3 (S5.9a): a bold launch over the five built-ins reviews a set that shows the bold level and holds the flirty mix.
  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4 #1): «Смелая» is every category's, so the set holds the 40 / 40 / 20 mix on the route; the flirty mix is the flirty launch's, the test above, kept.
  test("a bold launch reviews a bold set with the bold mix of the five built-ins, every scene on the route", async () => {
    const set = await launchSet({ level: "bold" });
    expect(set.level).toBe("bold");
    expect(set.scenes).toHaveLength(10);
    expect(set.scenes.filter((s) => s.level === "flirty")).toHaveLength(4);
    expect(set.scenes.filter((s) => s.level === "bold")).toHaveLength(4);
    expect(set.scenes.every((s) => s.route === "seedream")).toBe(true);
  });

  test("an ordinary launch, with a level asked for by name or none, reviews an ordinary set", async () => {
    for (const over of [{}, { level: "ordinary" as const }]) {
      const set = await launchSet(over);
      expect("level" in set).toBe(false);
      expect(set.scenes.some((s) => s.level !== undefined)).toBe(false);
    }
  });

  test("a flirty launch with legs reviews both: the legs scenes and the flirty count", async () => {
    const set = await launchSet({ level: "flirty", legsShare: 30 });
    expect(set.scenes.filter((s) => s.framing === "legs")).toHaveLength(3);
    expect(set.scenes.filter((s) => s.level === "flirty")).toHaveLength(flirtyCountOf(10, "flirty"));
  });
});
