import { describe, expect, test } from "bun:test";
import { plan } from "./planner";
import { POOLS } from "./pools";
import { ORDINARY_BUILT_INS } from "./types";
import { sweepTest } from "../../testing/bunTiers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();
// 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): scoped to the five ordinary built-ins (ORDINARY_BUILT_INS), every assertion kept. The «Смелая» banks run their own sweeps.

// S5.7b round 2: variety is guarded. Every moment of every built-in bank must be reachable by the planner: over enough seeds at the usual run sizes, an ordinary plan
// draws every ordinary moment and a flirty plan draws every moment. (The away preference once turned every «Дом» timer frame away and starved six moments of it.)

// Push: the first 300 seeds. Heavy: the 3000 seeds (as before); a moment that only the heavy run reaches is a sign the bank outgrew the push sample.
const SEEDS = 3000;
const SEED_COUNTS = { push: { seeds: 300 }, heavy: { seeds: SEEDS } };
/** «Дом» at «Кокетливая» holds a rare moment («lies on her stomach, legs bent up»): a 20-slot plan reaches it only by seed 622 (measured), so its push sample is wider. */
const seedCountsOf = (category: string, level: string): typeof SEED_COUNTS => (category === "home" && level === "flirty" ? { push: { seeds: 1000 }, heavy: { seeds: SEEDS } } : SEED_COUNTS);

describe.each([12, 20])("a category plan of %i slots", (count) => {
  for (const category of ORDINARY_BUILT_INS) {
    for (const level of ["ordinary", "flirty"] as const) {
      sweepTest(`${category}, ${level}: every moment of the bank appears at least once over ${SEEDS} seeds`, seedCountsOf(category, level), ({ seeds }) => {
        const wanted = new Set(POOLS[category].locations.flatMap((l) => l.activities.filter((a) => a.legs === undefined && (level === "flirty" || a.level !== "flirty")).map((a) => `${l.name} | ${a.text}`)));
        const seen = new Set<string>();
        for (let seed = 1; seed <= seeds; seed++) {
          for (const slot of plan({ seed, count, categories: [category], ...(level === "flirty" ? { level } : {}) }).slots) seen.add(`${slot.location} | ${slot.activity}`);
        }
        expect([...wanted].filter((moment) => !seen.has(moment))).toEqual([]);
      });
    }
  }
});

describe("«Дом»: the timer frame turns away about one time in three, and nothing forces it", () => {
  sweepTest("of the timer frames of 12-slot plans, between a quarter and two fifths face away", SEED_COUNTS, ({ seeds }) => {
    let timers = 0;
    let away = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      for (const slot of plan({ seed, count: 12, categories: ["home"] }).slots) {
        if (slot.capture !== "timer") continue;
        timers++;
        if (slot.pose === "profile" || slot.pose === "back") away++;
      }
    }
    expect(timers).toBeGreaterThan(seeds - 1);
    expect(away / timers).toBeGreaterThan(0.25);
    expect(away / timers).toBeLessThan(0.4);
  });
});

// S5.8a («Ножки», I5.29): the same guard for the legs banks. A plan with no legs never draws a legs moment (above); at 30 % every legs moment of every bank must appear: a
// legs slot picks the least-used place and the least-used moment there, so none may starve.
describe.each([12, 20])("a category plan of %i slots at 30 % legs", (count) => {
  for (const category of ORDINARY_BUILT_INS) {
    for (const level of ["ordinary", "flirty"] as const) {
      sweepTest(`${category}, ${level}: every legs moment of the bank appears at least once over ${SEEDS} seeds`, seedCountsOf(category, level), ({ seeds }) => {
        const wanted = new Set(POOLS[category].locations.flatMap((l) => l.activities.filter((a) => a.legs !== undefined).map((a) => `${l.name} | ${a.text}`)));
        const seen = new Set<string>();
        for (let seed = 1; seed <= seeds; seed++) {
          for (const slot of plan({ seed, count, categories: [category], legsShare: 30, ...(level === "flirty" ? { level } : {}) }).slots) if (slot.framing === "legs") seen.add(`${slot.location} | ${slot.activity}`);
        }
        expect([...wanted].filter((moment) => !seen.has(moment))).toEqual([]);
      });
    }
  }
});

describe("the legs slots do not starve the other moments", () => {
  for (const count of [12, 20]) sweepTest(`a category plan of ${count} slots at 30 % legs still draws every ordinary moment of every bank over the seeds`, SEED_COUNTS, ({ seeds }) => {
    for (const category of ORDINARY_BUILT_INS) {
      const wanted = new Set(POOLS[category].locations.flatMap((l) => l.activities.filter((a) => a.legs === undefined && a.level === undefined).map((a) => `${l.name} | ${a.text}`)));
      const seen = new Set<string>();
      for (let seed = 1; seed <= seeds; seed++) {
        for (const slot of plan({ seed, count, categories: [category], legsShare: 30 }).slots) if (slot.framing === undefined) seen.add(`${slot.location} | ${slot.activity}`);
      }
      expect([...wanted].filter((moment) => !seen.has(moment)), category).toEqual([]);
    }
  });
});
