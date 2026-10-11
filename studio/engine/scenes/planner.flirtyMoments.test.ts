import { describe, expect, test } from "bun:test";
import { POOLS, type Activity } from "./pools";
import { plan } from "./planner";
import type { PlanSlot } from "./schema";
import type { Category } from "./types";
import { captureOfShot, type Capture } from "../../shared/scenes/captures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2b (S5.7b, plan s5a2 §6.2): a flirty slot prefers the bank's flirty moments (a tie-break on use, never ahead of the balance), and an ordinary slot never takes one.

const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const momentOf = (slot: PlanSlot): Activity | undefined => POOLS[slot.category as Category].locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);
const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 3);

describe("a flirty slot prefers flirty moments", () => {
  const FLIRTY_MOMENT = (category: Category): Set<string> => new Set(POOLS[category].locations.flatMap((l) => l.activities.filter((a) => a.level === "flirty").map((a) => `${l.name}\u0000${a.text}`)));

  test("the banks hold flirty moments for «Дом» and «Гламур»", () => {
    expect(FLIRTY_MOMENT("home").size).toBeGreaterThanOrEqual(2);
    expect(FLIRTY_MOMENT("glamour").size).toBeGreaterThanOrEqual(1);
  });

  test("«Дом» under «Кокетливая»: some slot of most 12-slot plans is on a flirty moment, and an ordinary plan has none", () => {
    const flirtyMoments = FLIRTY_MOMENT("home");
    const onFlirty = (slots: readonly PlanSlot[]): number => slots.filter((s) => flirtyMoments.has(`${s.location}\u0000${s.activity}`)).length;
    let plansWithOne = 0;
    for (const seed of SEEDS) {
      expect(onFlirty(plan({ seed, count: 12, categories: ["home"] }).slots)).toBe(0);
      if (onFlirty(plan({ seed, count: 12, categories: ["home"], level: "flirty" }).slots) > 0) plansWithOne++;
    }
    expect(plansWithOne / SEEDS.length).toBeGreaterThan(0.8);
  });

  test("the first flirty prone slot of a «Дом» plan always takes the flirty prone moment", () => {
    let seen = 0;
    for (const seed of SEEDS) {
      const slots = plan({ seed, count: 24, categories: ["home"], level: "flirty" }).slots;
      const first = slots.find((s) => s.level === "flirty" && captureOf(s) === "prone");
      if (first === undefined) continue;
      seen++;
      expect(momentOf(first)?.level, `seed ${seed}: ${first.activity}`).toBe("flirty");
    }
    expect(seen).toBeGreaterThan(40);
  });
});
