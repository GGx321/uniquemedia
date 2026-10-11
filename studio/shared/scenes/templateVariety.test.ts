import { describe, expect, test } from "bun:test";
import { BANKS } from "./banks";
import { BANK_CATEGORIES, type BankCategory, type Level } from "./banks/types";
import { simulatePlan, type SimulatedSlot } from "./simulatePlan.testkit";
import { momentAllowed, templateSentence } from "./template";

// 5a.2 (S5.6a, I5.24, plan s5a2 §5.2 step 3): template sentences must not read mechanical at scale. Over 100-slot plans of each built-in category, at
// each level, for 50 seeds: distinct sentences ÷ slots ≥ 0.8; no moment more than ⌈n_c / (moments the category can draw)⌉ + 1 times; and with the
// run-level dedup, no two equal sentences. The plans are the planner stand-in's (simulatePlan.testkit.ts): S5.6b re-runs these bounds on the real one.

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
const N = 100;
const LEVELS: readonly Level[] = ["ordinary", "flirty"];

/** Renders a plan the way a run would: in slot order, each slot seeing the sentences before it (dedup on), or each alone (dedup off). */
function render(slots: readonly SimulatedSlot[], level: Level, dedup: boolean): string[] {
  const seen = new Set<string>();
  return slots.map((slot) => {
    const sentence = templateSentence(slot, { key: slot.key, level, ...(dedup ? { seen } : {}) });
    if (sentence === null) throw new Error(`${slot.category}/${slot.location}: «${slot.activity}» did not render on ${slot.shot} ${slot.pose}`);
    seen.add(sentence);
    return sentence;
  });
}

/** The moments a slot of the category can draw at the level (a moment of the bank no shot or pose of its deck allows does not count). */
function drawableMoments(category: BankCategory, level: Level): number {
  const shots = [...new Set(BANKS[category].shotDeck)];
  return BANKS[category].places.reduce(
    (n, place) =>
      n +
      place.moments.filter((m) => shots.some((shot) => (shot !== "mirror" || place.mirror === true) && (["front", "three-quarter", "profile", "back"] as const).some((pose) => momentAllowed(m, shot, pose, level)))).length,
    0,
  );
}

function worstMomentRepeat(slots: readonly SimulatedSlot[]): number {
  const counts = new Map<string, number>();
  for (const slot of slots) counts.set(`${slot.location}|${slot.activity}`, (counts.get(`${slot.location}|${slot.activity}`) ?? 0) + 1);
  return Math.max(...counts.values());
}

/** A sentence the dedup cannot redraw: no gaze, no cue and no detail clause (a back pose or a hidden face, in a room). */
function isBare(slot: SimulatedSlot, sentence: string): boolean {
  return sentence === `${slot.place.at.charAt(0).toUpperCase()}${slot.place.at.slice(1)}, she ${slot.moment.text}, wearing ${slot.outfit}.`;
}

describe.each([...BANK_CATEGORIES])("%s: a 100-slot plan", (category) => {
  test.each([...LEVELS])("at %s: every slot renders, ≥ 0.8 of the sentences are distinct without the dedup, and with it only a bare sentence repeats", (level) => {
    let worstRatio = 1;
    for (const seed of SEEDS) {
      const slots = simulatePlan(category, N, seed, level);
      const plain = render(slots, level, false);
      worstRatio = Math.min(worstRatio, new Set(plain).size / N);
      // §5.2 step 3: an equal sentence redraws its gaze, cue and detail; one with none of them keeps its text (the moment-repeat bound below flags it).
      const deduped = render(slots, level, true);
      const repeats = deduped.flatMap((sentence, i) => (deduped.indexOf(sentence) < i && !isBare(slots[i] as SimulatedSlot, sentence) ? [sentence] : []));
      expect(repeats).toEqual([]);
    }
    expect(worstRatio).toBeGreaterThanOrEqual(0.8);
  });

  test.each([...LEVELS])("at %s: no moment repeats more than ⌈n / moments⌉ + 1 times", (level) => {
    const bound = Math.ceil(N / drawableMoments(category, level)) + 1;
    for (const seed of SEEDS) for (const away of [true, false]) expect(worstMomentRepeat(simulatePlan(category, N, seed, level, away))).toBeLessThanOrEqual(bound);
  });
});

describe("the stand-in planner itself", () => {
  test("is deterministic", () => {
    expect(simulatePlan("home", 30, 7).map((s) => `${s.location}|${s.activity}|${s.shot}|${s.pose}|${s.outfit}`)).toEqual(
      simulatePlan("home", 30, 7).map((s) => `${s.location}|${s.activity}|${s.shot}|${s.pose}|${s.outfit}`),
    );
  });

  test("puts a mirror shot only on a mirror place and never a two-handed or phone moment on a hand shot", () => {
    for (const category of BANK_CATEGORIES) {
      for (const slot of simulatePlan(category, N, 3)) {
        if (slot.shot === "mirror") expect(slot.place.mirror).toBe(true);
        if (slot.shot === "selfie" || slot.shot === "mirror") expect(slot.moment.twoHanded || slot.moment.phone === true).toBe(false);
      }
    }
  });
});
