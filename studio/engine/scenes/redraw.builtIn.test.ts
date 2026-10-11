import { describe, expect, test } from "bun:test";
import { captureOfShot, shotOf, type Capture } from "../../shared/scenes/captures";
import { momentAllowed } from "../../shared/scenes/render";
import { legwearFits } from "../../shared/scenes/template";
import { plan } from "./planner";
import { EVERYDAY_OUTFITS, POOLS, type Activity, type Pool } from "./pools";
import { redrawSlot } from "./redraw";
import { PlanSlotSchema, type PlanSlot } from "./schema";
import { CATEGORIES, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6b): «Другая сцена» on a built-in scene follows the planner: the scene keeps its capture (who took the photo), draws a pose, then a place with a
// fitting moment and one of its fitting moments, the moment's pinned outfits first, and the legwear. It never throws (an old scene whose capture its pool no
// longer deals takes one of the deck's, preferring its own shot).

const NO_AVOID = { locations: new Set<string>(), outfits: new Set<string>() };
const ALL = { profile: true, back: true };
const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const draw = (slot: PlanSlot, k: number, pool: Pool, over: Partial<Parameters<typeof redrawSlot>[0]> = {}): PlanSlot => redrawSlot({ seed: 99, k, slot, pool, avoid: NO_AVOID, poses: ALL, ...over });
const slotsOf = (category: Category): PlanSlot[] => plan({ seed: 5, count: 36, categories: [category], poses: ALL }).slots;
const momentOf = (category: Category, slot: PlanSlot): Activity | undefined => POOLS[category].locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);

describe.each([...CATEGORIES])("redrawing a %s scene", (category) => {
  const pool = POOLS[category];

  test("keeps the scene's capture, id, category and attempt id base", () => {
    for (const slot of slotsOf(category)) {
      for (let k = 1; k <= 3; k++) {
        const out = draw(slot, k, pool);
        expect([captureOf(out), out.shot, out.slotIndex, out.category, out.attemptIdBase]).toEqual([captureOf(slot), slot.shot, slot.slotIndex, slot.category, slot.attemptIdBase]);
      }
    }
  });

  test("draws a moment that fits the capture and the pose, at a place of the pool", () => {
    for (const slot of slotsOf(category)) {
      for (let k = 1; k <= 6; k++) {
        const out = draw(slot, k, pool);
        const moment = momentOf(category, out);
        expect(moment, `${out.location} / ${out.activity}`).toBeDefined();
        if (moment !== undefined) expect(momentAllowed(moment, captureOf(out), out.pose)).toBe(true);
        if (shotOf(captureOf(out)) === "mirror") expect(pool.locations.find((l) => l.name === out.location)?.mirror).toBe(true);
      }
    }
  });

  test("a moment that pins outfits draws only those; any other moment draws no pin-only outfit", () => {
    const pinOnly = new Set((pool.outfitInfo ?? []).filter((o) => o.pinOnly === true).map((o) => o.text));
    for (const slot of slotsOf(category)) {
      for (let k = 1; k <= 6; k++) {
        const out = draw(slot, k, pool);
        const moment = momentOf(category, out);
        if (moment?.outfits !== undefined) expect(moment.outfits).toContain(out.outfit);
        else {
          expect(pinOnly.has(out.outfit)).toBe(false);
        }
      }
    }
  });

  test("legwear goes only with an outfit that shows her legs, on a moment that allows it", () => {
    for (const slot of slotsOf(category)) {
      for (let k = 1; k <= 6; k++) {
        const out = draw(slot, k, pool);
        if (out.legwear === undefined) continue;
        const outfit = pool.outfitInfo?.find((o) => o.text === out.outfit);
        const moment = momentOf(category, out);
        expect(outfit && moment && legwearFits(moment, outfit)).toBe(true);
        expect(pool.legwear?.items).toContain(out.legwear);
      }
    }
  });

  test("is a pure function of the seed, the write number and the scene", () => {
    const slot = slotsOf(category)[0];
    if (slot === undefined) throw new Error("no slot");
    expect(draw(slot, 4, pool)).toEqual(draw(slot, 4, pool));
  });

  test("returns a valid plan slot", () => {
    for (const slot of slotsOf(category)) expect(PlanSlotSchema.safeParse(draw(slot, 2, pool)).success).toBe(true);
  });

  test("a hand-held capture keeps to front or three-quarter whatever the set allows", () => {
    for (const slot of slotsOf(category).filter((s) => s.shot === "selfie" || s.shot === "mirror")) {
      for (let k = 1; k <= 8; k++) expect(["front", "three-quarter"]).toContain(draw(slot, k, pool).pose);
    }
  });
});

describe("redrawing within a set", () => {
  test("draws away from the places and outfits the set already shows, while some are left (tiers as before)", () => {
    const pool = POOLS.photoshoot;
    const slot = slotsOf("photoshoot").find((s) => captureOf(s) === "friend");
    if (slot === undefined) throw new Error("no friend slot");
    for (let k = 1; k <= 20; k++) {
      const out = draw(slot, k, pool, { avoid: { locations: new Set([slot.location]), outfits: new Set([slot.outfit]) } });
      expect(out.location).not.toBe(slot.location);
      expect(out.outfit).not.toBe(slot.outfit);
    }
  });

  test("draws different places across write numbers (it is not a constant)", () => {
    const slot = slotsOf("photoshoot")[0];
    if (slot === undefined) throw new Error("no slot");
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map((k) => draw(slot, k, POOLS.photoshoot).location)).size).toBeGreaterThan(2);
  });

  test("an old «Дом» scene stored as a friend's shot (the pool deals none) takes a capture of the deck, never throws", () => {
    const old: PlanSlot = { slotIndex: 1, category: "home", location: "a bright kitchen", timeOfDay: "morning", activity: "slicing fruit on a cutting board", outfit: "a cozy hoodie", shot: "friend", pose: "front", attemptIdBase: "slot-1", repeatedPair: false };
    for (let k = 1; k <= 20; k++) {
      const out = draw(old, k, POOLS.home);
      expect(POOLS.home.captureDeck).toContain(captureOf(out));
      expect(PlanSlotSchema.safeParse(out).success).toBe(true);
    }
  });

  test("an old scene whose shot the pool still deals keeps that shot", () => {
    const old: PlanSlot = { slotIndex: 2, category: "photoshoot", location: "a plain wall in her hallway", timeOfDay: "evening", activity: "tucking her hair behind her ear", outfit: "a black going-out dress", shot: "candid", pose: "front", attemptIdBase: "slot-2", repeatedPair: false };
    for (let k = 1; k <= 10; k++) expect(draw(old, k, POOLS.photoshoot).shot).toBe("candid");
  });
});

describe("the owner's denim rule, on a custom pool (S5.6b)", () => {
  const custom: Pool = {
    locations: [{ name: "a corner cafe", times: ["midday"], activities: [{ text: "stirring a coffee", twoHanded: false }] }],
    outfits: ["a tee and denim shorts", "a denim miniskirt and a top", "a plain dress"],
    shotDeck: ["friend"],
  };
  const slot: PlanSlot = { slotIndex: 1, category: "cat-denim", location: "a corner cafe", timeOfDay: "midday", activity: "stirring a coffee", outfit: "a plain dress", shot: "friend", pose: "front", attemptIdBase: "slot-1", repeatedPair: false };

  test("never draws denim shorts or a denim skirt", () => {
    for (let k = 1; k <= 40; k++) expect(draw(slot, k, custom).outfit).toBe("a plain dress");
  });

  test("a pool left with none draws the shared everyday list", () => {
    const allDenim: Pool = { ...custom, outfits: ["a tee and denim shorts", "a denim skirt and a top"] };
    for (let k = 1; k <= 40; k++) expect(EVERYDAY_OUTFITS).toContain(draw(slot, k, allDenim).outfit);
  });
});
