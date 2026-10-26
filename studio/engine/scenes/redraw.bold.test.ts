import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import type { BankCategory, Level } from "../../shared/scenes/banks/types";
import { atOrBelow } from "../../shared/scenes/level";
import { templateSentence } from "../../shared/scenes/template";
import { plan } from "./planner";
import { POOLS } from "./pools";
import { redrawSlot } from "./redraw";
import type { PlanSlot } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9c, plan s5a3 §7.3): «Другая сцена» on a «Смелая» scene keeps its level and its framing and recomputes its route: it redraws within the scene's own level, never above it,
// wears stockings only when it is bold and the outfit is one the bold legwear names, and is on Seedream exactly when it drew a Seedream item.

const NO_AVOID = { locations: new Set<string>(), outfits: new Set<string>() };
const BOLD_BANKS = ["nightwear", "beach"] as const satisfies readonly BankCategory[];
const levelOf = (slot: PlanSlot): Level => slot.level ?? "ordinary";
const draw = (category: BankCategory, slot: PlanSlot, k: number): PlanSlot => redrawSlot({ seed: 99, k, slot, pool: POOLS[category], avoid: NO_AVOID });
const slotsOf = (category: BankCategory, legsShare: 0 | 15 | 30): PlanSlot[] => [3, 4, 5, 6].flatMap((seed) => plan({ seed, count: 30, categories: [category], level: "bold", legsShare }).slots);

describe.each([...BOLD_BANKS])("redrawing a %s scene", (category) => {
  const bank = BANKS[category];
  const itemsOf = (slot: PlanSlot) => {
    const moment = bank.places.find((p) => p.name === slot.location)?.moments.find((m) => m.text === slot.activity);
    const outfit = bank.outfits.find((o) => o.text === slot.outfit);
    if (moment === undefined || outfit === undefined) throw new Error(`${category}: the redraw named an item the bank does not have: ${slot.location} | ${slot.activity} | ${slot.outfit}`);
    return { moment, outfit };
  };

  test("keeps the scene's level, whatever it is", () => {
    for (const slot of slotsOf(category, 0)) for (let k = 1; k <= 3; k++) expect(draw(category, slot, k).level).toBe(slot.level);
  });

  test("keeps a legs scene a legs scene, at its level", () => {
    const legs = slotsOf(category, 30).filter((s) => s.framing === "legs");
    expect(legs.length).toBeGreaterThan(10);
    for (const slot of legs) for (let k = 1; k <= 3; k++) expect({ framing: draw(category, slot, k).framing, level: draw(category, slot, k).level }).toEqual({ framing: "legs", level: slot.level });
  });

  test("never takes a moment or an outfit above the scene's level", () => {
    for (const share of [0, 30] as const) {
      for (const slot of slotsOf(category, share)) {
        for (let k = 1; k <= 3; k++) {
          const out = draw(category, slot, k);
          const { moment, outfit } = itemsOf(out);
          expect({ level: levelOf(out), moment: atOrBelow(moment.level, levelOf(slot)), outfit: atOrBelow(outfit.level, levelOf(slot)) }).toEqual({ level: levelOf(slot), moment: true, outfit: true });
        }
      }
    }
  });

  test("is on the Seedream route exactly when it drew a Seedream item (the route is recomputed, not copied)", () => {
    const stockings = new Set(bank.legwear?.bold?.items ?? []);
    for (const slot of slotsOf(category, 15)) {
      for (let k = 1; k <= 3; k++) {
        const out = draw(category, slot, k);
        const { moment, outfit } = itemsOf(out);
        const seedream = moment.route === "seedream" || outfit.route === "seedream" || (out.legwear !== undefined && stockings.has(out.legwear));
        expect({ slot: `${out.activity} | ${out.outfit}`, route: out.route }).toEqual({ slot: `${out.activity} | ${out.outfit}`, route: seedream ? "seedream" : undefined });
      }
    }
  });

  test("wears stockings only when the scene is bold and its outfit is one the bold legwear names", () => {
    const stockings = new Set(bank.legwear?.bold?.items ?? []);
    const named = new Set(bank.legwear?.bold?.outfits ?? []);
    for (const share of [0, 30] as const) {
      for (const slot of slotsOf(category, share)) {
        for (let k = 1; k <= 3; k++) {
          const out = draw(category, slot, k);
          if (out.legwear !== undefined && stockings.has(out.legwear)) expect({ level: levelOf(out), named: named.has(out.outfit) }).toEqual({ level: "bold", named: true });
        }
      }
    }
  });

  test("renders: a redrawn scene is never left to the writer", () => {
    for (const slot of slotsOf(category, 15)) for (let k = 1; k <= 3; k++) expect(templateSentence(draw(category, slot, k), { key: `set:${slot.slotIndex}:${k}` })).not.toBeNull();
  });
});

describe("redrawing a bold nightwear scene", () => {
  test("gives stockings to some bold scenes: the redraw reads the bold legwear, not the bank's own", () => {
    const stockings = new Set(BANKS.nightwear.legwear?.bold?.items ?? []);
    const redrawn = slotsOf("nightwear", 15).filter((s) => s.level === "bold").flatMap((slot) => [1, 2, 3, 4].map((k) => draw("nightwear", slot, k)));
    expect(redrawn.filter((s) => s.legwear !== undefined && stockings.has(s.legwear)).length).toBeGreaterThan(5);
  });

  // S5.R4 (the whole-slice review, MEDIUM 4; plan §6.2 r3.1): «a bold legs slot wears satin nightwear with stockings (the stockings make it bold)», in the plan and in «Другая сцена» alike.
  test("a bold legs scene redraws to satin with the stockings, every time", () => {
    const stockings = new Set(BANKS.nightwear.legwear?.bold?.items ?? []);
    const redrawn = slotsOf("nightwear", 30).filter((s) => s.level === "bold" && s.framing === "legs").flatMap((slot) => [1, 2, 3, 4].map((k) => draw("nightwear", slot, k)));
    expect(redrawn.length).toBeGreaterThan(20);
    expect(redrawn.filter((s) => s.legwear === undefined || !stockings.has(s.legwear) || !/\bsatin\b/.test(s.outfit)).map((s) => `${s.activity} | ${s.outfit}`)).toEqual([]);
  });

  // 5a.4 (S5.BA2, 2026-10-26, Q-A2): the ordinary tier is plain underwear on Seedream now, so an ordinary nightwear scene redraws ordinary and on the route; the off-the-route control is
  // a «Кокетливая» «Дом» scene below (a «Смелая» one drew as that until S5.BA3 planned its companion).
  test("an ordinary scene redraws ordinary: plain underwear on Seedream, no level, on the route", () => {
    const ordinary = slotsOf("nightwear", 0).filter((s) => s.level === undefined);
    expect(ordinary.length).toBeGreaterThan(20);
    for (const slot of ordinary) {
      for (let k = 1; k <= 3; k++) {
        const out = draw("nightwear", slot, k);
        expect({ level: out.level, route: out.route }).toEqual({ level: undefined, route: "seedream" });
      }
    }
  });

  test("a «Кокетливая» «Дом» scene redraws at its own level with no route", () => {
    // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4, BA2 part 2 review L1): the control was a «Смелая» «Дом» plan, which drew as «Кокетливая» with no route until the five got their companions. A
    // «Смелая» «Дом» plan is routed now (redraw.boldAny.test.ts redraws it in its companion), so the control is the «Кокетливая» plan, which is what a set stored before 5a.4 holds.
    const home = [3, 4, 5, 6].flatMap((seed) => plan({ seed, count: 30, categories: ["home"], level: "flirty" }).slots);
    expect(home.length).toBeGreaterThan(20);
    for (const slot of home) {
      for (let k = 1; k <= 3; k++) {
        const out = redrawSlot({ seed: 99, k, slot, pool: POOLS.home, avoid: NO_AVOID });
        expect({ level: out.level, route: out.route }).toEqual({ level: slot.level, route: undefined });
      }
    }
  });
});
