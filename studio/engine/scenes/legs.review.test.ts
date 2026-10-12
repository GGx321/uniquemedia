import { describe, expect, test } from "bun:test";
import { templateSentence } from "../../shared/scenes/template";
import { localSentences } from "./localSentences";
import { slotKeyOf } from "./phoneLook";
import { plan } from "./planner";
import { ORDINARY_BUILT_INS } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();
// 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): scoped to the five ordinary built-ins (ORDINARY_BUILT_INS), every assertion kept. The «Смелая» banks run their own sweeps.

// S5.8a review: «Ножки» must not read mechanical (I5.24): at 30 % the legs slots of «Фитнес» and «Виды» repeated one sentence (0.70 and 0.76 distinct per slot), and every 12-slot plan of «Фитнес» repeated it.

const RUN = "run-review-1";
const keyOf = (slot: { attemptIdBase: string }): string => slotKeyOf(RUN, slot.attemptIdBase);

describe("variety at 30 % legs (I5.24)", () => {
  // I5.24 is a bound on EVERY plan, as templateVariety and planner.builtIn hold it: at least 0.8 distinct sentences per slot over a 100-slot plan of each category and level, with no
  // dedup (each slot alone, the strict reading) and with the run's own dedup (an equal sentence is redrawn).
  for (const level of ["ordinary", "flirty"] as const) {
    test.each([...ORDINARY_BUILT_INS])(`${level}, %s: every 100-slot plan keeps at least 0.8 distinct sentences per slot, alone and with the run's dedup`, (category) => {
      let worstAlone = 1;
      let worstDedup = 1;
      for (let seed = 1; seed <= 50; seed++) {
        const slots = plan({ seed, count: 100, categories: [category], legsShare: 30, ...(level === "flirty" ? { level } : {}) }).slots;
        const alone = slots.map((slot) => templateSentence(slot, { key: keyOf(slot) }));
        expect(alone.every((s) => s !== null)).toBe(true);
        worstAlone = Math.min(worstAlone, new Set(alone).size / slots.length);
        const local = localSentences({ slots, keyOf });
        const deduped = slots.map((slot) => local(slot));
        expect(deduped.every((s) => s !== null)).toBe(true);
        worstDedup = Math.min(worstDedup, new Set(deduped).size / slots.length);
      }
      expect(worstAlone).toBeGreaterThanOrEqual(0.8);
      expect(worstDedup).toBeGreaterThanOrEqual(0.8);
    });
  }

  test.each([...ORDINARY_BUILT_INS])("%s: the legs slots of a 12-slot plan go round the legs moments before any repeats", (category) => {
    let repeating = 0;
    const plans = 300;
    for (let seed = 1; seed <= plans; seed++) {
      const legs = plan({ seed, count: 12, categories: [category], legsShare: 30 }).slots.filter((s) => s.framing === "legs");
      if (new Set(legs.map((s) => `${s.location}|${s.activity}`)).size < legs.length) repeating++;
    }
    expect(repeating / plans).toBeLessThanOrEqual(0.02);
  });
});
