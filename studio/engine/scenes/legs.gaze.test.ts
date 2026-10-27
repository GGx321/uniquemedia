import { describe, expect, test } from "bun:test";
import { CUES, GAZE } from "../../shared/scenes/banks";
import { captureOfShot } from "../../shared/scenes/captures";
import { localSentences } from "./localSentences";
import { slotKeyOf } from "./phoneLook";
import { plan } from "./planner";
import { ORDINARY_BUILT_INS } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();
// 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): scoped to the five ordinary built-ins (ORDINARY_BUILT_INS), every assertion kept. The «Смелая» banks run their own sweeps.

// S5.8a review: a legs frame must not stage the face (a low-feet frame kept a gaze at the viewer and a smile on a third of its sentences).

const RUN = "run-review-1";
const keyOf = (slot: { attemptIdBase: string }): string => slotKeyOf(RUN, slot.attemptIdBase);

describe("a legs frame does not stage the face", () => {
  const OTHER_GAZES = GAZE.filter((g) => g.kind !== "down").map((g) => g.text);
  const DOWN_GAZES = GAZE.filter((g) => g.kind === "down").map((g) => g.text);
  const sentencesOfLegs = (): { sentence: string; capture: string }[] => {
    const out: { sentence: string; capture: string }[] = [];
    for (const category of ORDINARY_BUILT_INS) {
      for (let seed = 1; seed <= 120; seed++) {
        const slots = plan({ seed, count: 20, categories: [category], legsShare: 30, ...(seed % 2 === 0 ? { level: "flirty" as const } : {}) }).slots;
        const local = localSentences({ slots: slots.map((s) => ({ ...s, route: s.route })), keyOf });
        for (const slot of slots) if (slot.framing === "legs") out.push({ sentence: local(slot) ?? "", capture: slot.capture ?? captureOfShot(slot.shot) });
      }
    }
    return out;
  };

  test("no legs sentence looks at the viewer, away or at her hands, and none carries an expression cue", () => {
    const legs = sentencesOfLegs();
    expect(legs.length).toBeGreaterThan(1000);
    expect(legs.filter((l) => l.sentence === "")).toEqual([]);
    expect(legs.filter((l) => OTHER_GAZES.some((g) => l.sentence.includes(g))).map((l) => l.sentence)).toEqual([]);
    expect(legs.filter((l) => CUES.some((c) => l.sentence.includes(c.text))).map((l) => l.sentence)).toEqual([]);
  });

  test("a low-feet frame may look down, and some do", () => {
    const lowFeet = sentencesOfLegs().filter((l) => l.capture === "low-feet");
    expect(lowFeet.length).toBeGreaterThan(200);
    expect(lowFeet.some((l) => DOWN_GAZES.some((g) => l.sentence.includes(g)))).toBe(true);
  });
});
