import { describe, expect, test } from "bun:test";
import { CODE_MOTIONS } from "./motion";
import { BANKS } from "../../shared/scenes/banks";
import { ClipMotionChoice, MOTION_TEXT_MAX } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC1 (review round 2, L8): the English a model or the owner's idea may put in a motion is the set the shipped motions use. Every bank motion and every code motion must pass the
// contract's text check, so a model is held to the vocabulary the bank already proves a video provider takes.

const BANK_MOTIONS = Object.values(BANKS).flatMap((bank) => bank.places.flatMap((place) => place.moments.map((moment) => moment.motion)));
const CODE_TEXTS = CODE_MOTIONS.map((motion) => motion.text);

describe("the vision and own text charset", () => {
  test("the shipped motions are 271 bank motions and 7 code motions", () => {
    expect(BANK_MOTIONS.length).toBe(271);
    expect(CODE_TEXTS.length).toBe(7);
  });

  test("every bank motion and every code motion would pass as a vision text and as an own text", () => {
    const failing: string[] = [];
    for (const [i, text] of [...BANK_MOTIONS, ...CODE_TEXTS].entries()) {
      for (const source of ["vision", "own"] as const) {
        const id = source === "vision" ? "v-1" : "o-1";
        if (!ClipMotionChoice.safeParse({ id, source, label: "Движение", text }).success) failing.push(`${i}: ${source}: ${text}`);
      }
    }
    expect(failing).toEqual([]);
  });

  test("they all fit the 60-character bound", () => {
    expect(Math.max(...BANK_MOTIONS.map((text) => text.length), ...CODE_TEXTS.map((text) => text.length))).toBeLessThanOrEqual(MOTION_TEXT_MAX);
  });
});
