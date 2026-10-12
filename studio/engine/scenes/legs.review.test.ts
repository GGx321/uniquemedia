import { describe, expect, test } from "bun:test";
import { templateSentence } from "../../shared/scenes/template";
import { slotKeyOf } from "./phoneLook";
import { plan } from "./planner";
import { CATEGORIES } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.8a review: «Ножки» must not read mechanical (I5.24): at 30 % the legs slots of «Фитнес» and «Виды» repeated one sentence (0.70 and 0.76 distinct per slot), and every 12-slot plan of «Фитнес» repeated it.

const RUN = "run-review-1";
const keyOf = (slot: { attemptIdBase: string }): string => slotKeyOf(RUN, slot.attemptIdBase);

describe("variety at 30 % legs (I5.24)", () => {
  test.each([...CATEGORIES])("%s: 100-slot plans average at least 0.8 distinct sentences per slot, each slot rendered alone", (category) => {
    let sum = 0;
    const plans = 50;
    for (let seed = 1; seed <= plans; seed++) {
      const slots = plan({ seed, count: 100, categories: [category], legsShare: 30 }).slots;
      const sentences = slots.map((slot) => templateSentence(slot, { key: keyOf(slot) }));
      expect(sentences.every((s) => s !== null)).toBe(true);
      sum += new Set(sentences).size / slots.length;
    }
    expect(sum / plans).toBeGreaterThanOrEqual(0.8);
  });

  test.each([...CATEGORIES])("%s: the legs slots of a 12-slot plan go round the legs moments before any repeats", (category) => {
    let repeating = 0;
    const plans = 300;
    for (let seed = 1; seed <= plans; seed++) {
      const legs = plan({ seed, count: 12, categories: [category], legsShare: 30 }).slots.filter((s) => s.framing === "legs");
      if (new Set(legs.map((s) => `${s.location}|${s.activity}`)).size < legs.length) repeating++;
    }
    expect(repeating / plans).toBeLessThanOrEqual(0.02);
  });
});
