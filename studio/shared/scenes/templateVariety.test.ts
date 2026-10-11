import { describe, expect, test } from "bun:test";
import { BANKS } from "./banks";
import { BANK_CATEGORIES, type BankCategory, type Level } from "./banks/types";
import { isHandCapture, posesFor, shotOf } from "./captures";
import { momentAllowed } from "./render";
import { simulatePlan, type SimulatedSlot } from "./simulatePlan.testkit";
import { templateSentence } from "./template";

// 5a.2 (S5.6a, I5.24, I5.32, plan s5a2 r1.2 §5.2): template sentences must not read mechanical at scale. Over 100-slot plans of each built-in
// category, at each level, for 50 seeds: distinct sentences ÷ slots ≥ 0.8; no moment more than ⌈n_c / (moments the category can draw)⌉ + 1 times;
// with the run-level dedup only a bare sentence repeats; and «Дом» never falls back to a friend's photo. The plans are the planner stand-in's
// (simulatePlan.testkit.ts): S5.6b re-runs these bounds on the real one.

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
const N = 100;
const LEVELS: readonly Level[] = ["ordinary", "flirty"];

/** Renders a plan the way a run would: in slot order, each slot seeing the sentences before it (dedup on), or each alone (dedup off). */
function render(slots: readonly SimulatedSlot[], level: Level, dedup: boolean): string[] {
  const seen = new Set<string>();
  return slots.map((slot) => {
    const sentence = templateSentence(slot, { key: slot.key, level, ...(dedup ? { seen } : {}) });
    if (sentence === null) throw new Error(`${slot.category}/${slot.location}: «${slot.activity}» did not render on ${slot.capture} ${slot.pose}`);
    seen.add(sentence);
    return sentence;
  });
}

/**
 * The repeats the dedup contract allows (§5.2): a slot may keep a sentence the run already has only when its first draw and all 8 dedup redraws
 * (`${key}:dedup:${i}`) are taken (a face-hidden or back frame in a room has one text; one whose only clause left is the detail has 2 or 3).
 */
function unjustifiedRepeats(slots: readonly SimulatedSlot[], level: Level): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slot of slots) {
    const sentence = templateSentence(slot, { key: slot.key, level, seen }) ?? "";
    if (seen.has(sentence)) {
      const variants = [slot.key, ...Array.from({ length: 8 }, (_, i) => `${slot.key}:dedup:${i + 1}`)].map((key) => templateSentence(slot, { key, level }));
      if (variants.some((v) => v !== null && !seen.has(v))) out.push(sentence);
    }
    seen.add(sentence);
  }
  return out;
}

/** The moments a slot of the category can draw at the level: some capture of its deck takes it at some pose, at a place that capture can land on. */
function drawableMoments(category: BankCategory, level: Level): number {
  const captures = [...new Set(BANKS[category].captureDeck)];
  return BANKS[category].places.reduce(
    (n, place) =>
      n +
      place.moments.filter((m) => captures.some((capture) => (shotOf(capture) !== "mirror" || place.mirror === true) && posesFor(capture).some((pose) => momentAllowed(m, capture, pose, level)))).length,
    0,
  );
}

function worstMomentRepeat(slots: readonly SimulatedSlot[]): number {
  const counts = new Map<string, number>();
  for (const slot of slots) counts.set(`${slot.location}|${slot.activity}`, (counts.get(`${slot.location}|${slot.activity}`) ?? 0) + 1);
  return Math.max(...counts.values());
}

describe.each([...BANK_CATEGORIES])("%s: a 100-slot plan", (category) => {
  test.each([...LEVELS])("at %s: every slot renders, ≥ 0.8 of the sentences are distinct without the dedup, and with it a sentence repeats only when every redraw is taken", (level) => {
    let worstRatio = 1;
    for (const seed of SEEDS) {
      const slots = simulatePlan(category, N, seed, level);
      worstRatio = Math.min(worstRatio, new Set(render(slots, level, false)).size / N);
      render(slots, level, true);
      expect(unjustifiedRepeats(slots, level)).toEqual([]);
    }
    expect(worstRatio).toBeGreaterThanOrEqual(0.8);
  });

  test.each([...LEVELS])("at %s: no moment repeats more than ⌈n / moments⌉ + 1 times", (level) => {
    const bound = Math.ceil(N / drawableMoments(category, level)) + 1;
    for (const seed of SEEDS) for (const away of [true, false]) expect(worstMomentRepeat(simulatePlan(category, N, seed, level, away))).toBeLessThanOrEqual(bound);
  });

  // The plan critic (r1.3): the capture fallback never fires for a built-in plan (a «Дом» timer would become a friend's photo); only a place may be
  // redrawn, when the drawn place has no moment for the capture.
  test("never steps a capture or a pose down: only the place is ever redrawn", () => {
    for (const seed of SEEDS) {
      for (const away of [true, false]) {
        const steps = simulatePlan(category, N, seed, "ordinary", away).flatMap((s) => s.fallbacks.filter((f) => !f.startsWith("place ")));
        expect(steps).toEqual([]);
      }
    }
  });
});

test("«Дом» never gets a friend's or a candid photo, and about a third of its frames hide her face behind the phone (I5.32)", () => {
  let hidden = 0;
  let total = 0;
  for (const seed of SEEDS) {
    for (const slot of simulatePlan("home", 60, seed)) {
      expect(["friend", "candid"]).not.toContain(slot.capture);
      total++;
      if (slot.capture === "mirror-hidden") hidden++;
    }
  }
  expect(hidden / total).toBeGreaterThan(0.28);
  expect(hidden / total).toBeLessThan(0.39);
});

test("legwear reaches the plans: on «Дом» outfits that show her legs, never on a moment that clashes with it", () => {
  const withLegwear = SEEDS.flatMap((seed) => simulatePlan("home", N, seed)).filter((s) => s.legwear !== undefined);
  expect(withLegwear.length).toBeGreaterThan(200);
  for (const slot of withLegwear) {
    expect(slot.moment.feetUp).toBeUndefined();
    expect(slot.moment.text).not.toMatch(/\b(socks?|socked|tights|stockings?|bare|barefoot|soles?|heels)\b/i);
  }
});

describe("the stand-in planner itself", () => {
  test("is deterministic", () => {
    const line = (s: SimulatedSlot) => `${s.location}|${s.activity}|${s.capture}|${s.pose}|${s.wearing}`;
    expect(simulatePlan("home", 30, 7).map(line)).toEqual(simulatePlan("home", 30, 7).map(line));
  });

  test("puts a mirror capture only on a mirror place and never a two-handed or phone moment on a hand-held capture", () => {
    for (const category of BANK_CATEGORIES) {
      for (const slot of simulatePlan(category, N, 3)) {
        if (shotOf(slot.capture) === "mirror") expect(slot.place.mirror).toBe(true);
        if (isHandCapture(slot.capture)) expect(slot.moment.twoHanded || slot.moment.phone === true).toBe(false);
      }
    }
  });

  test("draws the prone selfie only in its pinned outfit", () => {
    for (const slot of SEEDS.flatMap((seed) => simulatePlan("home", N, seed)).filter((s) => s.capture === "prone")) expect(slot.moment.outfits).toContain(slot.outfit);
  });
});
