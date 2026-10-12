import { describe, expect, test } from "bun:test";
import { ORDINARY_BANK_CATEGORIES, type Level } from "./banks/types";
import { simulatePlan } from "./simulatePlan.testkit";
import { templateSentence } from "./template";
// 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): scoped to the five ordinary banks (ORDINARY_BANK_CATEGORIES), every assertion kept. The «Смелая» banks run their own sweeps.

// S5.6R (round D): «looking back at the viewer» landed on front frames and contradicted «face and body oriented toward the camera»; an image model reads
// «looking back» as an over-the-shoulder turn. A gaze that says «back» belongs to no front frame, and the gaze bank must not add «back … back» repeats.

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
const LEVELS: readonly Level[] = ["ordinary", "flirty"];

/** Measured on this sample with no «back» in the gaze bank (its level before round C added «looking back at the viewer»;  the rest come from moments and outfits). */
const BACK_REPEATS_BASELINE = 339;

function sentences(): { text: string; pose: string }[] {
  const out: { text: string; pose: string }[] = [];
  for (const category of ORDINARY_BANK_CATEGORIES)
    for (const level of LEVELS)
      for (const seed of SEEDS)
        for (const slot of simulatePlan(category, 100, seed, level)) {
          const text = templateSentence(slot, { key: slot.key, level });
          if (text !== null) out.push({ text, pose: slot.pose });
        }
  return out;
}

const ALL = sentences();

describe("the gaze bank and the word «back» (S5.6R round D)", () => {
  test("the sample holds at least 2000 front sentences", () => {
    expect(ALL.filter((s) => s.pose === "front").length).toBeGreaterThanOrEqual(2000);
  });

  test("no front sentence says «looking back»", () => {
    expect(ALL.filter((s) => s.pose === "front" && /looking back/i.test(s.text)).map((s) => s.text).slice(0, 3)).toEqual([]);
  });

  test("sentences that say «back» twice stay at or under the pre-round-C level", () => {
    const repeats = ALL.filter((s) => (s.text.match(/\bback\b/gi) ?? []).length >= 2).length;
    expect(repeats).toBeLessThanOrEqual(BACK_REPEATS_BASELINE);
  });
});
