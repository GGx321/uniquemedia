import { describe, expect, test } from "bun:test";
import { plan, type PlanInput } from "./planner";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Polish after C4, round 2: the moment text is the only part of a moment the photo prompt carries, so one run that shows the same text in two categories shows the same photo twice
// ("On her bed, she lies prone, glancing back" in «Дом» and in «Ночнушки и бельё»). Under «Смелая» a slot of a «Смелая» category yields: it does not take a text another category's slot
// already holds in the run, while another fitting moment exists. The five ordinary categories never yield, so their plans do not move.

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const COUNTS = [10, 20];
const SHARES = [0, 15, 30] as const;
const MIXES = [
  ["home", "nightwear"],
  ["home", "beach"],
  ["travel", "beach"],
  ["glamour", "nightwear"],
  ["nightwear", "beach"],
] as const;

const textOf = (activity: string | undefined): string => (activity ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** The texts that two categories of one plan both hold. */
function sharedTexts(input: PlanInput): string[] {
  const { slots } = plan(input);
  const byText = new Map<string, Set<string>>();
  for (const slot of slots) {
    const key = textOf(slot.activity);
    byText.set(key, (byText.get(key) ?? new Set()).add(slot.category));
  }
  return [...byText].filter(([, categories]) => categories.size > 1).map(([text]) => text);
}

describe("a mixed «Смелая» run never shows one moment text in two categories", () => {
  for (const categories of MIXES) {
    for (const count of COUNTS) {
      test(`${categories.join(" + ")}, ${count} photos: 0 of ${SEEDS.length} seeds x 3 legs shares share a text, and no slot is empty`, () => {
        const repeats: string[] = [];
        for (const seed of SEEDS) {
          for (const legsShare of SHARES) {
            const input: PlanInput = { seed, count, categories: [...categories], level: "bold", legsShare };
            const shared = sharedTexts(input);
            if (shared.length > 0) repeats.push(`seed ${seed} legs ${legsShare}: ${shared.join(" | ")}`);
            const { slots } = plan(input);
            expect(slots).toHaveLength(count);
            expect(slots.filter((s) => s.activity === undefined || s.location === "")).toEqual([]);
          }
        }
        expect({ runs: repeats.length, sample: repeats.slice(0, 3) }).toEqual({ runs: 0, sample: [] });
      });
    }
  }

  test("the ordinary category's slots are the same with or without the bank it is mixed with", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const mixed = plan({ seed, count: 20, categories: ["home", "nightwear"], level: "bold", legsShare: 15 }).slots.filter((s) => s.category === "home");
      const flirty = plan({ seed, count: 20, categories: ["home", "nightwear"], level: "flirty", legsShare: 15 }).slots.filter((s) => s.category === "home");
      expect(mixed.map(({ slotIndex, location, activity, outfit }) => ({ slotIndex, location, activity, outfit }))).toEqual(flirty.map(({ slotIndex, location, activity, outfit }) => ({ slotIndex, location, activity, outfit })));
    }
  });
});
