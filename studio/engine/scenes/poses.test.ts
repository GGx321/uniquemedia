import { describe, expect, test } from "bun:test";
import { makeRng } from "./rngUtil";
import { drawPose, NO_EXTRA_POSES, POSE_WEIGHTS, type PoseAllowance } from "./poses";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T5c: the pose draw. Pure, deterministic and independent of the planner's
// own location/outfit/shot rng streams (planner.test.ts pins the isolation
// property); this file only pins drawPose's own behavior against an rng it
// is handed directly.

const ALL_ALLOWED: PoseAllowance = { profile: true, back: true };

describe("drawPose: selfie and mirror always face the camera", () => {
  test.each(["selfie", "mirror"] as const)("%s never draws profile or back, whatever the run allows", (shot) => {
    for (let seed = 1; seed <= 50; seed++) {
      const pose = drawPose(makeRng(seed), shot, ALL_ALLOWED);
      expect(pose === "front" || pose === "three-quarter").toBe(true);
    }
  });

  test.each(["selfie", "mirror"] as const)("%s can still draw both front and three-quarter across seeds", (shot) => {
    const drawn = new Set(Array.from({ length: 50 }, (_, i) => drawPose(makeRng(i + 1), shot, ALL_ALLOWED)));
    expect(drawn.has("front")).toBe(true);
    expect(drawn.has("three-quarter")).toBe(true);
  });
});

describe("drawPose: other shots respect the run's pose allowance", () => {
  test.each(["friend", "candid", "photographer"] as const)("%s never draws profile or back when neither is allowed", (shot) => {
    for (let seed = 1; seed <= 50; seed++) {
      const pose = drawPose(makeRng(seed), shot, NO_EXTRA_POSES);
      expect(pose === "front" || pose === "three-quarter").toBe(true);
    }
  });

  test.each(["friend", "candid", "photographer"] as const)("%s can draw profile once allowed, across enough seeds", (shot) => {
    const drawn = new Set(Array.from({ length: 200 }, (_, i) => drawPose(makeRng(i + 1), shot, { profile: true, back: false })));
    expect(drawn.has("profile")).toBe(true);
    expect(drawn.has("back")).toBe(false);
  });

  test.each(["friend", "candid", "photographer"] as const)("%s can draw back once allowed, across enough seeds", (shot) => {
    const drawn = new Set(Array.from({ length: 200 }, (_, i) => drawPose(makeRng(i + 1), shot, { profile: false, back: true })));
    expect(drawn.has("back")).toBe(true);
    expect(drawn.has("profile")).toBe(false);
  });

  test("mostly front/three-quarter, profile/back only a modest share, when everything is allowed", () => {
    const counts: Record<string, number> = { front: 0, "three-quarter": 0, profile: 0, back: 0 };
    for (let i = 1; i <= 2000; i++) counts[drawPose(makeRng(i), "friend", ALL_ALLOWED)]!++;
    const extra = counts.profile! + counts.back!;
    // A modest share: less than a third of draws are profile/back combined.
    expect(extra / 2000).toBeLessThan(1 / 3);
    expect(counts.front).toBeGreaterThan(0);
    expect(counts["three-quarter"]).toBeGreaterThan(0);
  });
});

describe("drawPose: determinism", () => {
  test("the same rng state and inputs draw the same pose", () => {
    const a = drawPose(makeRng(42), "friend", ALL_ALLOWED);
    const b = drawPose(makeRng(42), "friend", ALL_ALLOWED);
    expect(a).toBe(b);
  });
});

describe("POSE_WEIGHTS", () => {
  test("front and three-quarter outweigh profile and back", () => {
    expect(POSE_WEIGHTS.front).toBeGreaterThan(POSE_WEIGHTS.profile);
    expect(POSE_WEIGHTS.front).toBeGreaterThan(POSE_WEIGHTS.back);
    expect(POSE_WEIGHTS["three-quarter"]).toBeGreaterThan(POSE_WEIGHTS.profile);
    expect(POSE_WEIGHTS["three-quarter"]).toBeGreaterThan(POSE_WEIGHTS.back);
  });
});
