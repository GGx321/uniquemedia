import { describe, expect, test } from "bun:test";
import { plan } from "./planner";
import { CATEGORIES } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9a, plan s5a3 §7.1 and I5.36): «Смелая» is on the contract, but only the two bold categories draw anything bolder, and they arrive with S5.9b2. Until then the five
// ordinary built-ins under `bold` plan EXACTLY as under `flirty` (and after it, "as «Кокетливая», byte-identical"), so the contract never yields a half-built plan.

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 3);
const SIZES = Array.from({ length: 30 }, (_, i) => i + 1);

describe("«Смелая» on the five ordinary built-ins is «Кокетливая»", () => {
  for (const category of CATEGORIES) {
    test(`${category}: every size from 1 to 30 plans byte for byte as flirty`, () => {
      for (const seed of SEEDS) for (const count of SIZES) expect(plan({ seed, count, categories: [category], level: "bold" })).toEqual(plan({ seed, count, categories: [category], level: "flirty" }));
    });
  }

  test("a mixed run plans as flirty and holds the flirty counts of each category", () => {
    for (const seed of SEEDS) {
      const bold = plan({ seed, count: 23, categories: [...CATEGORIES], level: "bold" });
      expect(bold).toEqual(plan({ seed, count: 23, categories: [...CATEGORIES], level: "flirty" }));
      for (const category of CATEGORIES) {
        const own = bold.slots.filter((s) => s.category === category);
        expect(own.filter((s) => s.level === "flirty")).toHaveLength(Math.round(own.length * 0.6));
      }
    }
  });

  test("with legs it plans as flirty with legs", () => {
    for (const seed of SEEDS) for (const legsShare of [15, 30] as const) expect(plan({ seed, count: 20, categories: ["home", "travel"], level: "bold", legsShare })).toEqual(plan({ seed, count: 20, categories: ["home", "travel"], level: "flirty", legsShare }));
  });

  test("only «Дом» at ten scenes holds the six flirty ones «Кокетливая» holds", () => {
    const slots = plan({ seed: 11, count: 10, categories: ["home"], level: "bold" }).slots;
    expect(slots.filter((s) => s.level === "flirty")).toHaveLength(6);
  });

  test("no slot is stored with a bold level or a route: nothing bolder is drawn yet", () => {
    const slots = plan({ seed: 5, count: 30, categories: [...CATEGORIES], level: "bold" }).slots;
    expect(slots.every((s) => (s.level === undefined || s.level === "flirty") && !("route" in s))).toBe(true);
  });
});
