import { describe, expect, test } from "bun:test";
import { plan } from "./planner";
import { ORDINARY_BUILT_INS } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();
// 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): scoped to the five ordinary built-ins (ORDINARY_BUILT_INS), every assertion kept. The «Смелая» banks run their own sweeps.

// 5a.3 (S5.9a, plan s5a3 §7.1 and I5.36): «Смелая» is on the contract, but only the two bold categories draw anything bolder, and they arrive with S5.9b2. Until then the five
// ordinary built-ins under `bold` plan EXACTLY as under `flirty` (and after it, "as «Кокетливая», byte-identical"), so the contract never yields a half-built plan.
//
// 2026-10-26 (5a.4, S5.BA3, plan s5a4 I5.71, §7.4): «Смелая» is every category's now, so the five at `bold` are planned from their companions (planner.boldAny.test.ts) and no longer equal
// their `flirty` plan. Every «Кокетливая» assertion of this file is kept and told on a `flirty` request, which is the plan the five drew at «Смелая» before 5a.4 (QB-5: a set stored then
// keeps no route and redraws and renders as before). What each assertion said about `bold` is now said by planner.boldAny.test.ts: routed, in the companion, 40 / 40 / 20.

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 3);
const SIZES = Array.from({ length: 30 }, (_, i) => i + 1);

describe("«Кокетливая» on the five ordinary built-ins is the plan they drew at «Смелая» before 5a.4", () => {
  for (const category of ORDINARY_BUILT_INS) {
    test(`${category}: every size from 1 to 30 holds round(0.6 × n) flirty slots, none bold, none on the route`, () => {
      for (const seed of SEEDS) {
        for (const count of SIZES) {
          const slots = plan({ seed, count, categories: [category], level: "flirty" }).slots;
          expect(slots.filter((s) => s.level === "flirty")).toHaveLength(Math.round(count * 0.6));
          expect(slots.every((s) => s.level !== "bold" && s.route === undefined)).toBe(true);
        }
      }
    });
  }

  test("a mixed run holds the flirty counts of each category", () => {
    for (const seed of SEEDS) {
      const flirty = plan({ seed, count: 23, categories: [...ORDINARY_BUILT_INS], level: "flirty" });
      for (const category of ORDINARY_BUILT_INS) {
        const own = flirty.slots.filter((s) => s.category === category);
        expect(own.filter((s) => s.level === "flirty")).toHaveLength(Math.round(own.length * 0.6));
      }
    }
  });

  test("with legs it plans with legs", () => {
    for (const seed of SEEDS) {
      for (const legsShare of [15, 30] as const) {
        const slots = plan({ seed, count: 20, categories: ["home", "travel"], level: "flirty", legsShare }).slots;
        expect(slots.filter((s) => s.framing === "legs")).toHaveLength(legsShare === 15 ? 3 : 6);
      }
    }
  });

  test("only «Дом» at ten scenes holds the six flirty ones", () => {
    const slots = plan({ seed: 11, count: 10, categories: ["home"], level: "flirty" }).slots;
    expect(slots.filter((s) => s.level === "flirty")).toHaveLength(6);
  });

  test("no slot is stored with a bold level or a route: nothing bolder is drawn below «Смелая»", () => {
    for (const level of ["ordinary", "flirty"] as const) {
      const slots = plan({ seed: 5, count: 30, categories: [...ORDINARY_BUILT_INS], level }).slots;
      expect(slots.every((s) => (s.level === undefined || s.level === "flirty") && !("route" in s))).toBe(true);
    }
  });
});
