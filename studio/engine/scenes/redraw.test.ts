import { describe, expect, test } from "bun:test";
import { POOLS, type Pool } from "./pools";
import { drawOwnScenes, redrawSlot } from "./redraw";
import { PlanSlotSchema, type PlanSlot } from "./schema";
import { plan } from "./planner";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: the one-slot redraw of «Другая сцена» and the draw of an own scene's shot and pose. Both are pure functions of (seed, write number, scene) and the
// pool as it is now: a crash-resume of the same write needs no draw at all (the draw is stored with the write), and the same inputs draw the same slot.

const POOL: Pool = POOLS.home;
const NO_AVOID = { locations: new Set<string>(), outfits: new Set<string>() };
const NONE = { profile: false, back: false };
const ALL = { profile: true, back: true };

function slotOf(shot: PlanSlot["shot"], over: Partial<PlanSlot> = {}): PlanSlot {
  const slots = plan({ seed: 7, count: 20, categories: ["home"] }).slots;
  const base = slots.find((s) => s.shot === shot) ?? slots[0];
  if (base === undefined) throw new Error("no slot");
  return { ...base, shot, ...over };
}

const draw = (slot: PlanSlot, k: number, over: Partial<Parameters<typeof redrawSlot>[0]> = {}) => redrawSlot({ seed: 99, k, slot, pool: POOL, avoid: NO_AVOID, poses: NONE, ...over });

describe("redrawSlot", () => {
  test("draws the same slot for the same seed, scene and write number", () => {
    const slot = slotOf("friend");
    expect(draw(slot, 3)).toEqual(draw(slot, 3));
  });

  test("draws different places across write numbers (it is not a constant)", () => {
    const slot = slotOf("friend");
    const places = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((k) => draw(slot, k).location));
    expect(places.size).toBeGreaterThan(2);
  });

  test("draws different slots for different scenes of the same write", () => {
    const a = slotOf("friend", { slotIndex: 1 });
    const b = slotOf("friend", { slotIndex: 2 });
    const same = [1, 2, 3, 4, 5, 6].filter((k) => draw(a, k).location === draw(b, k).location).length;
    expect(same).toBeLessThan(6);
  });

  test("keeps the scene's id, category, shot and attempt id base", () => {
    const slot = slotOf("friend", { slotIndex: 4, attemptIdBase: "slot-4" });
    const out = draw(slot, 2);
    expect([out.slotIndex, out.category, out.shot, out.attemptIdBase]).toEqual([4, slot.category, "friend", "slot-4"]);
  });

  test("never draws the place or outfit the scene already has when the pool has others", () => {
    const slot = slotOf("friend");
    for (let k = 1; k <= 30; k++) {
      const out = draw(slot, k, { avoid: { locations: new Set([slot.location]), outfits: new Set([slot.outfit]) } });
      expect(out.location).not.toBe(slot.location);
      expect(out.outfit).not.toBe(slot.outfit);
    }
  });

  test("avoids every place and outfit already in the set while some are left", () => {
    const slot = slotOf("friend");
    const keepPlace = POOL.locations.find((l) => l.mirror !== true);
    const keepOutfit = POOL.outfits[0] ?? "";
    const avoid = { locations: new Set(POOL.locations.map((l) => l.name).filter((n) => n !== keepPlace?.name)), outfits: new Set(POOL.outfits.filter((o) => o !== keepOutfit)) };
    for (let k = 1; k <= 10; k++) {
      const out = draw({ ...slot, location: "somewhere else", outfit: "something else" }, k, { avoid });
      expect([out.location, out.outfit]).toEqual([keepPlace?.name ?? "", keepOutfit]);
    }
  });

  test("when every place is in the set it still draws, away from the scene's own place where it can", () => {
    const slot = slotOf("friend");
    const everything = { locations: new Set(POOL.locations.map((l) => l.name)), outfits: new Set(POOL.outfits) };
    for (let k = 1; k <= 20; k++) {
      const out = draw(slot, k, { avoid: everything });
      expect(out.location).not.toBe(slot.location);
      expect(out.outfit).not.toBe(slot.outfit);
    }
  });

  test("the time of day and the activity belong to the drawn place", () => {
    const slot = slotOf("friend");
    for (let k = 1; k <= 20; k++) {
      const out = draw(slot, k);
      const place = POOL.locations.find((l) => l.name === out.location);
      expect(place?.times).toContain(out.timeOfDay);
      expect(place?.activities.map((a) => a.text)).toContain(out.activity);
    }
  });

  test("a selfie never gets a two-handed activity", () => {
    const slot = slotOf("selfie");
    for (let k = 1; k <= 60; k++) {
      const out = draw(slot, k);
      const place = POOL.locations.find((l) => l.name === out.location);
      expect(place?.activities.find((a) => a.text === out.activity)?.twoHanded).toBe(false);
    }
  });

  test("a mirror shot is redrawn onto a mirror place", () => {
    const slot = slotOf("mirror");
    for (let k = 1; k <= 40; k++) {
      const out = draw(slot, k);
      expect(POOL.locations.find((l) => l.name === out.location)?.mirror).toBe(true);
    }
  });

  test("a selfie or mirror scene keeps to front or three-quarter even when every pose is allowed", () => {
    for (const shot of ["selfie", "mirror"] as const) {
      for (let k = 1; k <= 60; k++) expect(["front", "three-quarter"]).toContain(draw(slotOf(shot), k, { poses: ALL }).pose);
    }
  });

  test("another shot draws profile or back only when the set allows them", () => {
    const slot = slotOf("friend");
    const seen = new Set<string>();
    for (let k = 1; k <= 120; k++) {
      expect(["front", "three-quarter"]).toContain(draw(slot, k, { poses: NONE }).pose);
      seen.add(draw(slot, k, { poses: ALL }).pose);
    }
    expect([...seen].some((p) => p === "profile" || p === "back")).toBe(true);
  });

  test("the result is a valid plan slot", () => {
    for (let k = 1; k <= 20; k++) expect(PlanSlotSchema.safeParse(draw(slotOf("friend"), k, { poses: ALL })).success).toBe(true);
  });

  test("a mirror scene in a pool with no mirror place becomes a selfie rather than a mirror on a wall that is not there", () => {
    const noMirror: Pool = { ...POOL, locations: POOL.locations.filter((l) => l.mirror !== true) };
    expect(draw(slotOf("mirror"), 1, { pool: noMirror }).shot).toBe("selfie");
  });
});

describe("drawOwnScenes", () => {
  const own = (over: Partial<Parameters<typeof drawOwnScenes>[0]> = {}) => drawOwnScenes({ seed: 5, k: 2, count: 5, shot: null, poses: NONE, ...over });

  test("draws one shot and pose per scene, the same for the same seed and write number", () => {
    expect(own()).toHaveLength(5);
    expect(own()).toEqual(own());
  });

  test("an explicit shot is every scene's shot, the mirror included", () => {
    expect(own({ shot: "mirror" }).every((d) => d.shot === "mirror")).toBe(true);
    expect(own({ shot: "photographer" }).every((d) => d.shot === "photographer")).toBe(true);
  });

  test("auto never draws the mirror, whatever the seed or write number", () => {
    for (let k = 1; k <= 200; k++) {
      for (const d of drawOwnScenes({ seed: k * 7919, k, count: 5, shot: null, poses: ALL })) expect(d.shot).not.toBe("mirror");
    }
  });

  test("auto draws more than one kind of shot", () => {
    const shots = new Set(Array.from({ length: 40 }, (_, k) => drawOwnScenes({ seed: 1, k: k + 1, count: 5, shot: null, poses: NONE })).flat().map((d) => d.shot));
    expect(shots.size).toBeGreaterThan(1);
  });

  test("a selfie or mirror scene is front or three-quarter even when every pose is allowed", () => {
    for (const shot of ["selfie", "mirror"] as const) {
      for (let k = 1; k <= 60; k++) for (const d of drawOwnScenes({ seed: 3, k, count: 5, shot, poses: ALL })) expect(["front", "three-quarter"]).toContain(d.pose);
    }
  });

  test("poses follow the set's allowance: none beyond front and three-quarter unless allowed", () => {
    for (let k = 1; k <= 60; k++) for (const d of drawOwnScenes({ seed: 3, k, count: 5, shot: "friend", poses: NONE })) expect(["front", "three-quarter"]).toContain(d.pose);
    const allowed = new Set(Array.from({ length: 80 }, (_, k) => drawOwnScenes({ seed: 3, k: k + 1, count: 5, shot: "friend", poses: ALL })).flat().map((d) => d.pose));
    expect([...allowed].some((p) => p === "profile" || p === "back")).toBe(true);
  });

  test("a different write number draws differently", () => {
    const draws = new Set(Array.from({ length: 30 }, (_, k) => JSON.stringify(drawOwnScenes({ seed: 3, k: k + 1, count: 5, shot: null, poses: ALL }))));
    expect(draws.size).toBeGreaterThan(5);
  });
});
