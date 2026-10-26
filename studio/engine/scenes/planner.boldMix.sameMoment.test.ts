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

  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4, BA2 part 2 review L1): «Дом» at «Смелая» is planned from its companion with a share of the whole request's tiers, so what it holds depends on the
  // categories it is mixed with by design (r2.2 D1). The control is told on «Кокетливая», where «Дом» is still its own plan whatever it is mixed with.
  // Round 2, L-7: «Ножки» is asked again (legsShare 15) and the positions are compared. The legs slots are shared over the categories that can deal them in proportion to their slots, so the bank
  // «Дом» is mixed with is another one that deals them too (beach, as many slots): «Дом» then gets the same legs slots, the same places and the same positions.
  test("the ordinary category's slots are the same with or without the bank it is mixed with, at «Кокетливая», legs included", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const of = (other: "nightwear" | "beach") => plan({ seed, count: 20, categories: ["home", other], level: "flirty", legsShare: 15 }).slots.filter((s) => s.category === "home");
      const withNightwear = of("nightwear");
      expect(withNightwear.some((s) => s.framing === "legs")).toBe(true);
      const key = ({ slotIndex, location, activity, outfit, framing }: (typeof withNightwear)[number]) => ({ slotIndex, location, activity, outfit, framing });
      expect(withNightwear.map(key)).toEqual(of("beach").map(key));
    }
  });
});
