import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "../../shared/scenes/banks/companions";
import type { CategoryBank } from "../../shared/scenes/banks/types";
import { captureOfShot, posesFor, shotOf, type Capture } from "../../shared/scenes/captures";
import { slotCoverageOf, templateSentence } from "../../shared/scenes/template";
import { fittingMoments } from "./fit";
import { poolOfSlot, withoutImplied } from "./poolAt";
import { POOLS } from "./pools";
import { isImpliedSlot, outdoorAtTheWater, redressSlot } from "./redress";
import { PlanSlotSchema, type PlanSlot } from "./schema";
import { ORDINARY_BUILT_INS } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 2026-11-04 (the owner's answer after S5.BAR, «2 А»): an imported avatar, or one of unknown origin, is never drawn under an implied cover (a sheet, a towel, bath foam, a bare back),
// even when the scene was stored before the origin rule. A stored slot that has no sentence yet is re-dressed: the same place, capture, pose, level, route and world, a moment of
// the same bank that is no implied one, and an outfit it may wear, drawn on a seeded stream of its own. The run decides when (runJob.ts); this file pins the draw.

const CUSTOM = "cat-fixture-trip";
const SEED = 4_242;

/** Every implied moment of a bank, as a stored «Смелая» slot at each capture it lists. */
function impliedSlotsOf(category: PlanSlot["category"], bank: CategoryBank, world?: string): PlanSlot[] {
  const out: PlanSlot[] = [];
  for (const place of bank.places) {
    for (const moment of place.moments.filter((m) => m.tier === "implied")) {
      for (const capture of moment.captures) {
        const shot = shotOf(capture);
        const pose = moment.angle ?? (posesFor(capture).includes("front") ? "front" : "three-quarter");
        out.push({
          slotIndex: out.length + 1,
          category,
          location: place.name,
          timeOfDay: place.times[0] ?? "evening",
          activity: moment.text,
          outfit: moment.outfits?.[0] ?? "",
          shot,
          pose,
          attemptIdBase: `slot-${out.length + 1}`,
          repeatedPair: false,
          ...(capture === captureOfShot(shot) ? {} : { capture }),
          level: "bold",
          route: "seedream",
          ...(world === undefined ? {} : { world }),
        });
      }
    }
  }
  return out;
}

const BUILT_IN: readonly (readonly [PlanSlot["category"], CategoryBank])[] = [["nightwear", BANKS.nightwear], ...ORDINARY_BUILT_INS.map((category) => [category, BOLD_COMPANIONS[category]] as const)];
const STORED: PlanSlot[] = [...BUILT_IN.flatMap(([category, bank]) => impliedSlotsOf(category, bank)), ...impliedSlotsOf(CUSTOM, CUSTOM_BOLD_BANKS.rooms, "a corner cafe in Paris")];
const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);

describe("isImpliedSlot: a stored slot under an implied cover, by its bank's data", () => {
  test("every implied moment of nightwear, the five's companions and «rooms» reads as one", () => {
    expect(STORED.length).toBeGreaterThan(10);
    for (const slot of STORED) expect({ place: slot.location, moment: slot.activity, implied: isImpliedSlot(slot) }).toEqual({ place: slot.location, moment: slot.activity, implied: true });
  });

  test("an old nightwear slot whose moment was reworded (5a.3 «lies holding the sheet to her chest») reads as one by its cover", () => {
    const sheet = STORED.find((s) => s.category === "nightwear" && /sheet/.test(s.outfit));
    if (sheet === undefined) throw new Error("nightwear has no sheet moment");
    expect(isImpliedSlot({ ...sheet, activity: "lies holding the sheet to her chest" })).toBe(true);
  });

  test("a lingerie slot, a slot of an unknown place and an unrouted custom slot do not", () => {
    const [first] = STORED;
    if (first === undefined) throw new Error("no stored slot");
    expect(isImpliedSlot({ ...first, activity: "lies back, one arm up on the pillow", outfit: "a white lace bra and panties" })).toBe(false);
    expect(isImpliedSlot({ ...first, location: "a room the bank never had", outfit: "a white lace bra and panties" })).toBe(false);
    expect(isImpliedSlot({ category: CUSTOM, route: undefined, location: "a corner cafe", activity: "sips a coffee", outfit: "a trench coat" })).toBe(false);
  });
});

describe("redressSlot: the same frame in lingerie, deterministically", () => {
  /** Whether the slot's own place has a moment for its capture, pose and level once the implied ones are gone: then the re-dress stays there. */
  const placeKeeps = (slot: PlanSlot): boolean => {
    const place = withoutImplied(poolOfSlot(slot, true) ?? POOLS.home).locations.find((l) => l.name === slot.location);
    return place !== undefined && fittingMoments(place, captureOf(slot), slot.pose, slot.level ?? "ordinary").length > 0;
  };

  test("every stored implied slot is re-dressed in its own pool at its capture, level, route and world, at its own place when that place has a fitting moment, in an outfit that is no implied cover", () => {
    expect(STORED.filter(placeKeeps).length).toBeGreaterThan(STORED.length / 2);
    for (const slot of STORED) {
      const out = redressSlot(slot, SEED);
      if (out === null) throw new Error(`no re-dress for «${slot.activity}» at ${slot.location} (${captureOf(slot)})`);
      const pool = poolOfSlot(slot, true);
      expect({ moment: slot.activity, samePool: pool?.locations.some((l) => l.name === out.location) === true, keptPlace: !placeKeeps(slot) || out.location === slot.location }).toEqual({ moment: slot.activity, samePool: true, keptPlace: true });
      expect({ capture: captureOf(out), level: out.level, route: out.route, world: out.world, time: out.timeOfDay, index: out.slotIndex, base: out.attemptIdBase }).toEqual({
        capture: captureOf(slot),
        level: slot.level,
        route: "seedream",
        world: slot.world,
        time: slot.timeOfDay,
        index: slot.slotIndex,
        base: slot.attemptIdBase,
      });
      expect({ moment: slot.activity, implied: isImpliedSlot(out), parses: PlanSlotSchema.safeParse(out).success }).toEqual({ moment: slot.activity, implied: false, parses: true });
    }
  });

  test("a built-in one is the template's, and ends with its kept coverage (an imported avatar's sentence)", () => {
    for (const slot of STORED.filter((s) => s.category !== CUSTOM)) {
      const out = redressSlot(slot, SEED);
      if (out === null) throw new Error("no re-dress");
      const sentence = templateSentence({ ...out, route: out.route }, { key: `run:${out.attemptIdBase}` });
      const coverage = slotCoverageOf({ ...out, route: out.route }, false);
      expect({ moment: slot.activity, renders: sentence !== null, kept: coverage !== undefined && (sentence ?? "").endsWith(coverage) }).toEqual({ moment: slot.activity, renders: true, kept: true });
    }
  });

  test("is a function of the slot and the seed", () => {
    for (const slot of STORED) expect(redressSlot(slot, SEED)).toEqual(redressSlot(slot, SEED));
    const moments = new Set(STORED.flatMap((slot) => [1, 2, 3, 4, 5, 6].map((seed) => redressSlot(slot, seed)?.activity)));
    expect(moments.size).toBeGreaterThan(STORED.length / 4);
  });

  test("the old reworded sheet slot is re-dressed at its place", () => {
    const sheet = STORED.find((s) => s.category === "nightwear" && /sheet/.test(s.outfit));
    if (sheet === undefined) throw new Error("nightwear has no sheet moment");
    const out = redressSlot({ ...sheet, activity: "lies holding the sheet to her chest" }, SEED);
    expect({ place: out?.location, implied: out === null ? null : isImpliedSlot(out) }).toEqual({ place: sheet.location, implied: false });
  });

  test("a slot that is no implied one comes back as it is, and one whose place the bank no longer has cannot be re-dressed", () => {
    const [first] = STORED;
    if (first === undefined) throw new Error("no stored slot");
    const lace = { ...first, activity: "lies back, one arm up on the pillow", outfit: "a white lace bra and panties" };
    expect(redressSlot(lace, SEED)).toBe(lace);
    expect(redressSlot({ ...first, location: "a room the bank never had" }, SEED)).toBeNull();
  });
});

// 2026-11-04 (the owner's answer after S5.BAR, «1 А»): a «rooms» slot stored on her balcony with a world at the water is lingerie outdoors over the water: it can never be written as
// the owner wants it, so a run skips it for free.
describe("outdoorAtTheWater: an old «rooms» slot on her balcony in a world at the water", () => {
  const balcony = (world: string, overrides: Partial<PlanSlot> = {}): PlanSlot => ({
    slotIndex: 1,
    category: CUSTOM,
    location: "her balcony",
    timeOfDay: "morning",
    activity: "leans on the railing in the sun",
    outfit: "a white lace bra and panties",
    shot: "friend",
    capture: "timer",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    level: "flirty",
    route: "seedream",
    world,
    ...overrides,
  });

  test("is one in a world at the water, and not in a dry one", () => {
    expect(outdoorAtTheWater(balcony("a balcony over the sea"))).toBe(true);
    expect(outdoorAtTheWater(balcony("the sundeck of a sailing yacht"))).toBe(true);
    expect(outdoorAtTheWater(balcony("a rooftop terrace in Paris"))).toBe(false);
  });

  test("an indoor «rooms» slot, a swimwear slot and a slot without the route are not", () => {
    expect(outdoorAtTheWater(balcony("a balcony over the sea", { location: "her room", activity: "sits up in bed, knees drawn up" }))).toBe(false);
    expect(outdoorAtTheWater(balcony("a balcony over the sea", { location: "a lounger by the water", activity: "lies back, soaking up the heat", outfit: "a white string bikini", capture: "friend" }))).toBe(false);
    const { world: _world, route: _route, level: _level, ...unrouted } = balcony("a balcony over the sea");
    expect(outdoorAtTheWater(unrouted)).toBe(false);
  });
});
