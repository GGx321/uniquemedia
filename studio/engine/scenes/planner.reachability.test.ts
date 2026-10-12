import { describe, expect, test } from "bun:test";
import { plan } from "./planner";
import { POOLS } from "./pools";
import { CATEGORIES } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.7b round 2: variety is guarded. Every moment of every built-in bank must be reachable by the planner: over enough seeds at the usual run sizes, an ordinary plan
// draws every ordinary moment and a flirty plan draws every moment. (The away preference once turned every «Дом» timer frame away and starved six moments of it.)

const SEEDS = 3000;

describe.each([12, 20])("a category plan of %i slots", (count) => {
  for (const category of CATEGORIES) {
    for (const level of ["ordinary", "flirty"] as const) {
      test(`${category}, ${level}: every moment of the bank appears at least once over ${SEEDS} seeds`, () => {
        const wanted = new Set(POOLS[category].locations.flatMap((l) => l.activities.filter((a) => level === "flirty" || a.level !== "flirty").map((a) => `${l.name} | ${a.text}`)));
        const seen = new Set<string>();
        for (let seed = 1; seed <= SEEDS; seed++) {
          for (const slot of plan({ seed, count, categories: [category], ...(level === "flirty" ? { level } : {}) }).slots) seen.add(`${slot.location} | ${slot.activity}`);
        }
        expect([...wanted].filter((moment) => !seen.has(moment))).toEqual([]);
      });
    }
  }
});

describe("«Дом»: the timer frame turns away about one time in three, and nothing forces it", () => {
  test("of the timer frames of 12-slot plans, between a quarter and two fifths face away", () => {
    let timers = 0;
    let away = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const slot of plan({ seed, count: 12, categories: ["home"] }).slots) {
        if (slot.capture !== "timer") continue;
        timers++;
        if (slot.pose === "profile" || slot.pose === "back") away++;
      }
    }
    expect(timers).toBeGreaterThan(SEEDS - 1);
    expect(away / timers).toBeGreaterThan(0.25);
    expect(away / timers).toBeLessThan(0.4);
  });
});
