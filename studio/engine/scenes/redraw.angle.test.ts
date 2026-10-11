import { describe, expect, test } from "bun:test";
import { captureOfShot, isHandCapture, type Capture } from "../../shared/scenes/captures";
import { momentAllowed } from "../../shared/scenes/render";
import { plan } from "./planner";
import { POOLS, type Activity } from "./pools";
import { redrawSlot } from "./redraw";
import type { PlanSlot } from "./schema";
import { CATEGORIES, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2b (S5.7b, I5.26): the angle comes from the scene in «Другая сцена» too. The redrawn scene's pose is its moment's `angle`, or front / three-quarter, and a
// redraw never adds an away scene: a scene that faces the camera never redraws into one that faces away, so the set keeps its ⌊n/5⌋ cap whatever the replacements.

const NO_AVOID = { locations: new Set<string>(), outfits: new Set<string>() };
const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const draw = (slot: PlanSlot, k: number): PlanSlot => redrawSlot({ seed: 99, k, slot, pool: POOLS[slot.category as Category], avoid: NO_AVOID });
const momentOf = (slot: PlanSlot): Activity | undefined => POOLS[slot.category as Category].locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);
const isAway = (slot: PlanSlot): boolean => slot.pose === "profile" || slot.pose === "back";
const slotsOf = (category: Category): PlanSlot[] => [3, 4, 5, 6].flatMap((seed) => plan({ seed, count: 30, categories: [category] }).slots);

describe.each([...CATEGORIES])("redrawing a %s scene follows the angle of the moment", (category) => {
  test("the pose is the moment's angle, else front or three-quarter, and the moment fits the capture and that pose", () => {
    for (const slot of slotsOf(category)) {
      for (let k = 1; k <= 4; k++) {
        const out = draw(slot, k);
        const moment = momentOf(out);
        expect(moment, `${out.location} / ${out.activity}`).toBeDefined();
        if (moment === undefined) continue;
        if (moment.angle !== undefined) expect(out.pose).toBe(moment.angle);
        else expect(["front", "three-quarter"]).toContain(out.pose);
        expect(momentAllowed(moment, captureOf(out), out.pose)).toBe(true);
      }
    }
  });

  test("a scene facing the camera never redraws into one facing away", () => {
    const facing = slotsOf(category).filter((s) => !isAway(s));
    expect(facing.length).toBeGreaterThan(30);
    for (const slot of facing) for (let k = 1; k <= 6; k++) expect(isAway(draw(slot, k)), `${slot.activity} → ${draw(slot, k).activity}`).toBe(false);
  });

  test("a hand-held capture is never redrawn into an away pose", () => {
    for (const slot of slotsOf(category)) {
      if (!isHandCapture(captureOf(slot))) continue;
      for (let k = 1; k <= 3; k++) expect(isAway(draw(slot, k))).toBe(false);
    }
  });
});

describe("a scene facing away", () => {
  test("may redraw into another away scene, and may redraw into one facing the camera", () => {
    const away = CATEGORIES.flatMap((category) => slotsOf(category).filter(isAway));
    expect(away.length).toBeGreaterThan(20);
    const outs = away.flatMap((slot) => [1, 2, 3, 4, 5, 6].map((k) => draw(slot, k)));
    expect(outs.some(isAway)).toBe(true);
    expect(outs.some((o) => !isAway(o))).toBe(true);
  });
});
