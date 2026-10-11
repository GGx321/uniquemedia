import { describe, expect, test } from "bun:test";
import type { PoolShot, ScenePose } from "../engine";
import { CAPTURES, captureOfShot, faceVisibleOf, isHandCapture, LEGS_CAPTURES, posesFor, shotOf, type Capture } from "./captures";

// 5a.2 r1.2 (I5.32): who takes the photo is a first-class `capture` on the slot. The stored `shot` keeps its 5 values (`shot = shotOf(capture)`),
// and `faceVisibleOf` is the one source of face visibility for the planner, the gate and the UI.

describe("shotOf: the stored shot a capture rides on", () => {
  test.each<[Capture, PoolShot]>([
    ["mirror-hidden", "mirror"],
    ["mirror", "mirror"],
    ["above", "selfie"],
    ["prone", "selfie"],
    ["selfie", "selfie"],
    ["over-shoulder", "selfie"],
    ["pov-legs", "selfie"],
    ["timer", "friend"],
    ["friend", "friend"],
    ["low-feet", "friend"],
    ["candid", "candid"],
  ])("%s → %s", (capture, shot) => {
    expect(shotOf(capture)).toBe(shot);
  });

  test("covers every capture: the ten of the plan and the owner's over-her-shoulder POV", () => {
    expect([...CAPTURES].sort()).toEqual(["above", "candid", "friend", "low-feet", "mirror", "mirror-hidden", "over-shoulder", "pov-legs", "prone", "selfie", "timer"]);
  });
});

describe("captureOfShot: an old slot's capture, read from its stored shot", () => {
  test.each<[PoolShot, Capture]>([
    ["friend", "friend"],
    ["selfie", "selfie"],
    ["mirror", "mirror"],
    ["candid", "candid"],
    ["photographer", "friend"],
  ])("%s → %s", (shot, capture) => {
    expect(captureOfShot(shot)).toBe(capture);
  });
});

describe("hand-held captures (one hand holds the phone)", () => {
  test.each<[Capture, boolean]>([
    ["selfie", true],
    ["above", true],
    ["prone", true],
    ["over-shoulder", true],
    ["mirror", true],
    ["mirror-hidden", true],
    ["pov-legs", true],
    ["timer", false],
    ["friend", false],
    ["candid", false],
    ["low-feet", false],
  ])("%s: %p", (capture, hand) => {
    expect(isHandCapture(capture)).toBe(hand);
  });

  test("a hand-held capture faces the phone: front or three-quarter only; the others take every pose", () => {
    for (const capture of CAPTURES) expect([...posesFor(capture)]).toEqual(isHandCapture(capture) ? ["front", "three-quarter"] : ["front", "three-quarter", "profile", "back"]);
  });

  test("the legs captures are «Ножки»'s own (5a.2c)", () => {
    expect([...LEGS_CAPTURES].sort()).toEqual(["low-feet", "pov-legs"]);
  });
});

describe("faceVisibleOf (I5.32)", () => {
  test.each<[Capture, ScenePose, "legs" | undefined, "yes" | "no" | "maybe"]>([
    ["mirror-hidden", "front", undefined, "no"],
    ["pov-legs", "front", "legs", "no"],
    ["friend", "back", undefined, "no"],
    ["timer", "back", undefined, "no"],
    ["low-feet", "front", "legs", "maybe"],
    ["mirror-hidden", "front", "legs", "no"],
    ["friend", "front", "legs", "maybe"],
    ["mirror", "three-quarter", undefined, "yes"],
    ["friend", "profile", undefined, "yes"],
    ["prone", "front", undefined, "yes"],
    ["over-shoulder", "three-quarter", undefined, "yes"],
    ["above", "three-quarter", undefined, "yes"],
    ["candid", "front", undefined, "yes"],
  ])("%s, %s, framing %p: %s", (capture, pose, framing, visible) => {
    expect(faceVisibleOf({ capture, pose, ...(framing === undefined ? {} : { framing }) })).toBe(visible);
  });

  test("an old slot with no capture reads it from its shot", () => {
    expect(faceVisibleOf({ shot: "mirror", pose: "front" })).toBe("yes");
    expect(faceVisibleOf({ shot: "photographer", pose: "back" })).toBe("no");
  });
});
