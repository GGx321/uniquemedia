import { describe, expect, test } from "bun:test";
import { POOL_TEXT_MAX } from "../../shared/engine";
import { captureOfShot, shotOf, type Capture } from "../../shared/scenes/captures";
import { momentAllowed } from "../../shared/scenes/render";
import { legwearFits, templateSentence } from "../../shared/scenes/template";
import { fittingMoments, fittingPlaces, poseForCapture } from "./fit";
import { plan, planWithPools, poseSeed } from "./planner";
import { drawPose, NO_EXTRA_POSES } from "./poses";
import { POOLS, type Activity, type Pool } from "./pools";
import { makeRng } from "./rngUtil";
import { ScenePlanSchema, type PlanSlot } from "./schema";
import { ORDINARY_BUILT_INS, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();
// 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): scoped to the five ordinary built-ins (ORDINARY_BUILT_INS), every assertion kept. The «Смелая» banks run their own sweeps.

// 5a.2 (S5.6b, plan s5a2 r1.5 §5.2, I5.23, I5.32): the built-in planner order. Per slot, each step on its own stream: the capture, from the category's deck
// (exact Bag cycles); the pose; a PLACE THAT HAS A FITTING MOMENT (the least-used of them, ties on `fit:${category}`); the least-used fitting moment there;
// the outfit (the moment's pinned outfits first); the legwear. Nothing here reads `clean:` (the fallback chain is for a custom pool and impossible cases).

const isAwayPose = (pose: string): boolean => pose === "profile" || pose === "back";
/** The poses the pose stream drew for the plan's slots (front or three-quarter; the over-the-shoulder POV turns three-quarter). A moment's own angle then replaces it. */
function drawnPosesOf(category: Category, seed: number, slots: readonly PlanSlot[]) {
  const rng = makeRng(poseSeed(seed, category));
  return slots.map((s) => poseForCapture(captureOf(s), drawPose(rng, s.shot, NO_EXTRA_POSES)));
}
const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const placeOf = (slot: PlanSlot) => POOLS[slot.category as Category].locations.find((l) => l.name === slot.location);
const momentOf = (slot: PlanSlot): Activity | undefined => placeOf(slot)?.activities.find((a) => a.text === slot.activity);
const deckLength = (category: Category): number => POOLS[category].captureDeck?.length ?? 0;
const counted = <T,>(items: readonly T[]): Map<T, number> => items.reduce((m, item) => m.set(item, (m.get(item) ?? 0) + 1), new Map<T, number>());

describe("the capture comes from the category's deck, in exact cycles (I5.32)", () => {
  test.each([...ORDINARY_BUILT_INS])("%s: a plan of one deck holds exactly the deck's captures", (category) => {
    const slots = plan({ seed: 7, count: deckLength(category), categories: [category] }).slots;
    expect(counted(slots.map(captureOf))).toEqual(counted(POOLS[category].captureDeck ?? []));
  });

  test.each([...ORDINARY_BUILT_INS])("%s: a plan of two decks holds each capture exactly twice as often", (category) => {
    const slots = plan({ seed: 11, count: deckLength(category) * 2, categories: [category] }).slots;
    const once = counted(POOLS[category].captureDeck ?? []);
    expect(counted(slots.map(captureOf))).toEqual(new Map([...once].map(([capture, n]) => [capture, n * 2])));
  });

  test("«Дом» deals 4 phone-over-face mirror selfies and 1 over-the-shoulder POV in 12, and never a friend", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const captures = plan({ seed, count: 12, categories: ["home"] }).slots.map(captureOf);
      expect(captures.filter((c) => c === "mirror-hidden")).toHaveLength(4);
      expect(captures.filter((c) => c === "over-shoulder")).toHaveLength(1);
      expect(captures).not.toContain("friend");
      expect(captures).not.toContain("candid");
    }
  });

  test("«Улица» and «Виды» deal 3 friends in 6", () => {
    for (const category of ["photoshoot", "travel"] as const) expect(plan({ seed: 3, count: 6, categories: [category] }).slots.filter((s) => captureOf(s) === "friend")).toHaveLength(3);
  });

  test("the stored shot is the shot of the capture", () => {
    for (const category of ORDINARY_BUILT_INS) for (const slot of plan({ seed: 5, count: 24, categories: [category] }).slots) expect(slot.shot).toBe(shotOf(captureOf(slot)));
  });

  test("a capture is stored only when it says more than the stored shot does", () => {
    for (const slot of plan({ seed: 5, count: 60, categories: [...ORDINARY_BUILT_INS] }).slots) {
      expect(slot.capture === undefined || slot.capture !== captureOfShot(slot.shot)).toBe(true);
    }
    const timer = plan({ seed: 5, count: 60, categories: ["home"] }).slots.find((s) => captureOf(s) === "timer");
    expect(timer?.capture).toBe("timer");
  });

  // Review S5.6b #1, #2: the prone and over-the-shoulder lines say «on the bed», and the look back along her body is turned.
  test("a prone or over-the-shoulder slot lies on her bed, and an over-the-shoulder slot is always three-quarter", () => {
    let seen = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (const slot of plan({ seed, count: 24, categories: ["home"] }).slots) {
        const capture = captureOf(slot);
        if (capture !== "prone" && capture !== "over-shoulder") continue;
        seen++;
        expect(slot.location).toBe("her bed");
        if (capture === "over-shoulder") expect(slot.pose).toBe("three-quarter");
      }
    }
    expect(seen).toBeGreaterThan(100);
  });

  test("a mirror capture sits on a mirror place", () => {
    for (const category of ORDINARY_BUILT_INS) {
      for (const slot of plan({ seed: 9, count: 36, categories: [category] }).slots) if (shotOf(captureOf(slot)) === "mirror") expect(placeOf(slot)?.mirror).toBe(true);
    }
  });
});

describe("pose, then a place with a fitting moment, then the least-used moment (plan r1.5)", () => {
  test.each([...ORDINARY_BUILT_INS])("%s: every slot's moment fits its capture and pose, at a place of the pool", (category) => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const slot of plan({ seed, count: 30, categories: [category] }).slots) {
        const moment = momentOf(slot);
        expect(moment, `${slot.location} / ${slot.activity}`).toBeDefined();
        if (moment !== undefined) expect(momentAllowed(moment, captureOf(slot), slot.pose)).toBe(true);
      }
    }
  });

  test.each([...ORDINARY_BUILT_INS])("%s: the pose is the moment's angle, else the pose stream's, drawn for the capture's shot, whatever the place and the moment (no step down)", (category) => {
    const seed = 42;
    const slots = plan({ seed, count: 40, categories: [category] }).slots;
    // The over-the-shoulder POV looks back along her body: whatever the stream draws, its pose is three-quarter (poseForCapture); no other pose moves.
    const drawn = drawnPosesOf(category, seed, slots);
    expect(slots.map((s) => s.pose)).toEqual(slots.map((s, i) => momentOf(s)?.angle ?? drawn[i]));
  });

  // The balance is kept inside each kind of slot: a slot facing away (its moment has a profile or back angle) takes the least-used place and moment among the ones that
  // face away, any other slot the least-used among the ones that do not (a wanted away slot is restricted to the former, and an excess one redrawn among the latter).
  test.each([...ORDINARY_BUILT_INS])("%s: each slot takes the least-used place that has a fitting moment, and the least-used fitting moment there, of its own kind", (category) => {
    for (const seed of [3, 4, 5]) {
      const slots = plan({ seed, count: 40, categories: [category] }).slots;
      const drawn = drawnPosesOf(category, seed, slots);
      const placeUses = new Map<string, number>();
      const momentUses = new Map<string, number>();
      slots.forEach((slot, i) => {
        const pool = POOLS[category];
        const kindOf = (angle: string | undefined): boolean => isAwayPose(angle ?? "front");
        const away = isAwayPose(slot.pose);
        const places = fittingPlaces(pool, captureOf(slot), drawn[i] ?? "front").filter((p) => fittingMoments(p, captureOf(slot), drawn[i] ?? "front").some((m) => kindOf(m.angle) === away));
        const fewest = Math.min(...places.map((p) => placeUses.get(p.name) ?? 0));
        expect(placeUses.get(slot.location) ?? 0, `place ${slot.location}`).toBe(fewest);
        const place = placeOf(slot);
        const moments = fittingMoments(place ?? { activities: [] }, captureOf(slot), drawn[i] ?? "front").filter((m) => kindOf(m.angle) === away);
        const key = (text: string): string => `${slot.location}\u0000${text}`;
        const fewestMoment = Math.min(...moments.map((m) => momentUses.get(key(m.text)) ?? 0));
        expect(momentUses.get(key(slot.activity)) ?? 0, `moment ${slot.activity}`).toBe(fewestMoment);
        placeUses.set(slot.location, (placeUses.get(slot.location) ?? 0) + 1);
        momentUses.set(key(slot.activity), (momentUses.get(key(slot.activity)) ?? 0) + 1);
      });
    }
  });

  test("a place's use never runs more than one ahead of another's in a category whose every place fits every slot («Виды», 12 slots, front poses)", () => {
    for (const seed of [1, 2, 3]) {
      const slots = plan({ seed, count: 12, categories: ["travel"] }).slots;
      const uses = [...counted(slots.map((s) => s.location)).values()];
      const drawn = drawnPosesOf("travel", seed, slots);
      const fitsAll = POOLS.travel.locations.every((place) => slots.every((s, i) => fittingMoments(place, captureOf(s), drawn[i] ?? "front").length > 0));
      if (fitsAll) expect(Math.max(...uses) - Math.min(...uses, 0)).toBeLessThanOrEqual(Math.ceil(12 / POOLS.travel.locations.length));
      expect(uses.reduce((a, b) => a + b, 0)).toBe(12);
    }
  });

  test("the same seed plans the same slots; a different seed another plan", () => {
    const a = plan({ seed: 20261011, count: 24, categories: [...ORDINARY_BUILT_INS] });
    expect(plan({ seed: 20261011, count: 24, categories: [...ORDINARY_BUILT_INS] })).toEqual(a);
    expect(plan({ seed: 20261012, count: 24, categories: [...ORDINARY_BUILT_INS] })).not.toEqual(a);
  });

  test("every plan parses against the plan schema", () => {
    for (const category of ORDINARY_BUILT_INS) expect(() => ScenePlanSchema.parse(plan({ seed: 13, count: 30, categories: [category] }))).not.toThrow();
  });

  test("a category's slots do not depend on which other categories are in the plan", () => {
    const alone = plan({ seed: 77, count: 12, categories: ["home"] }).slots.map(({ slotIndex: _i, attemptIdBase: _b, ...rest }) => rest);
    const withOthers = plan({ seed: 77, count: 60, categories: [...ORDINARY_BUILT_INS] }).slots.filter((s) => s.category === "home").map(({ slotIndex: _i, attemptIdBase: _b, ...rest }) => rest);
    expect(withOthers).toEqual(alone);
  });
});

describe("no built-in plan reads the fallback chain (coverage, r1.3 M1)", () => {
  test.each([...ORDINARY_BUILT_INS])("%s: over 10 000 seeds, every slot's capture is a deck capture and its pose the moment's angle or the one drawn", (category) => {
    const deck = new Set(POOLS[category].captureDeck);
    const n = deckLength(category);
    for (let seed = 1; seed <= 10_000; seed++) {
      const slots = plan({ seed, count: n, categories: [category] }).slots;
      const captures = slots.map(captureOf);
      if (!captures.every((c) => deck.has(c)) || counted(captures).size !== deck.size) throw new Error(`${category} seed ${seed}: a slot stepped off its deck (${captures.join(", ")})`);
      const drawn = drawnPosesOf(category, seed, slots);
      slots.forEach((slot, i) => {
        if (slot.pose !== (momentOf(slot)?.angle ?? drawn[i])) throw new Error(`${category} seed ${seed}: slot ${slot.slotIndex} changed its pose`);
      });
    }
  });
});

describe("outfits: pinned and pin-only (plan r1.5, 22.3)", () => {
  const pinnedByAMoment = (category: Category): Set<string> => new Set(POOLS[category].locations.flatMap((l) => l.activities.flatMap((a) => a.outfits ?? [])));

  test("a moment that pins outfits draws only those", () => {
    let pinned = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const slot of plan({ seed, count: 48, categories: ["home"] }).slots) {
        const moment = momentOf(slot);
        if (moment?.outfits === undefined) continue;
        pinned++;
        expect(moment.outfits).toContain(slot.outfit);
      }
    }
    expect(pinned).toBeGreaterThan(20);
  });

  test("the prone selfie draws only its pinned outfits", () => {
    const prone = plan({ seed: 8, count: 48, categories: ["home"] }).slots.filter((s) => captureOf(s) === "prone");
    expect(prone.length).toBeGreaterThan(0);
    for (const slot of prone) expect(["grey jersey lounge shorts and a tee", "grey leggings and a cropped tee"]).toContain(slot.outfit);
  });

  // Plan 22.3: only pin-only outfits leave the general draw; an outfit some moment pins (the prone lounge shorts) is still a general outfit for the others.
  test("a pin-only outfit stays out of the general draw, and an outfit some moment pins is still drawn by other moments", () => {
    const banned = new Set((POOLS.home.outfitInfo ?? []).filter((o) => o.pinOnly === true).map((o) => o.text));
    expect(banned.size).toBeGreaterThan(0);
    const worn = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const slot of plan({ seed, count: 48, categories: ["home"] }).slots) {
        if (momentOf(slot)?.outfits === undefined) {
          expect(banned.has(slot.outfit), `${slot.activity} wore ${slot.outfit}`).toBe(false);
          worn.add(slot.outfit);
        }
      }
    }
    expect([...pinnedByAMoment("home")].some((outfit) => worn.has(outfit))).toBe(true);
  });

  test("an outfit that breaks the owner's denim rule is never drawn, in a pinned list or a general one", () => {
    const denim = "a tee and denim shorts";
    const place = { name: "a", times: ["morning"], activities: [{ text: "waits", twoHanded: false, captures: ["friend"] as const }, { text: "sits", twoHanded: false, captures: ["friend"] as const, outfits: [denim, "a plain dress"] }] };
    const pool: Pool = { ...POOLS.travel, locations: [place], captureDeck: ["friend"], shotDeck: ["friend"], outfits: [denim, "a plain dress", "a cozy hoodie"], outfitInfo: [{ text: denim }, { text: "a plain dress" }, { text: "a cozy hoodie" }] };
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const slot of planWithPools({ seed, count: 20, categories: ["travel"] }, { ...POOLS, travel: pool }).slots) expect(slot.outfit).not.toBe(denim);
    }
  });
});

describe("legwear (I5.29, K-17, plan r1.4)", () => {
  const info = (category: Category, text: string) => POOLS[category].outfitInfo?.find((o) => o.text === text);

  test("only an outfit that shows her legs wears legwear, on a moment that names none and is not tagged noLegwear", () => {
    let withLegwear = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const slot of plan({ seed, count: 60, categories: ["home"] }).slots) {
        if (slot.legwear === undefined) continue;
        withLegwear++;
        const outfit = info("home", slot.outfit);
        const moment = momentOf(slot);
        expect(outfit && moment && legwearFits(moment, outfit), `${slot.activity} / ${slot.outfit}`).toBe(true);
        expect(POOLS.home.legwear?.items).toContain(slot.legwear);
      }
    }
    expect(withLegwear).toBeGreaterThan(10);
  });

  test("about 40 % of the slots that may wear legwear do", () => {
    let may = 0;
    let wear = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (const slot of plan({ seed, count: 60, categories: ["home"] }).slots) {
        const outfit = info("home", slot.outfit);
        const moment = momentOf(slot);
        if (outfit === undefined || moment === undefined || !legwearFits(moment, outfit)) continue;
        may++;
        if (slot.legwear !== undefined) wear++;
      }
    }
    expect(wear / may).toBeGreaterThan(0.3);
    expect(wear / may).toBeLessThan(0.5);
  });

  test("a category with no legwear slot never draws any", () => {
    for (const category of ORDINARY_BUILT_INS.filter((c) => POOLS[c].legwear === undefined)) {
      for (const slot of plan({ seed: 4, count: 40, categories: [category] }).slots) expect(slot.legwear).toBeUndefined();
    }
  });

  test("allowed on «sits with one leg crossed» and «stretches her legs», refused on bare feet and raised feet", () => {
    const legs = POOLS.home.outfitInfo?.find((o) => o.showsLegs === true);
    expect(legs).toBeDefined();
    if (legs === undefined) return;
    expect(legwearFits({ text: "sits with one leg crossed" }, legs)).toBe(true);
    expect(legwearFits({ text: "stretches her legs along the bed" }, legs)).toBe(true);
    expect(legwearFits({ text: "sits, soles toward the mirror" }, legs)).toBe(false);
    expect(legwearFits({ text: "lies with her bare feet forward" }, legs)).toBe(false);
    expect(legwearFits({ text: "lies on her stomach, feet raised", noLegwear: true }, legs)).toBe(false);
  });
});

describe("recent (place, moment) pairs are avoided softly (I5.24)", () => {
  test("a moment the avatar used recently at a place is not drawn again while the place has another that fits", () => {
    let moved = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const first = plan({ seed, count: 1, categories: ["travel"] }).slots[0];
      if (first === undefined) throw new Error("no slot");
      const again = plan({ seed, count: 1, categories: ["travel"], excludePairs: [{ location: first.location, outfit: first.outfit, activity: first.activity }] }).slots[0];
      if (again === undefined) throw new Error("no slot");
      if (again.location === first.location && again.activity === first.activity) throw new Error(`seed ${seed}: drew ${first.location} / ${first.activity} again`);
      moved++;
    }
    expect(moved).toBe(40);
  });

  test("when every fitting moment is recent, the plan still draws one (soft, never a block)", () => {
    const pairs = POOLS.photoshoot.locations.flatMap((l) => l.activities.map((a) => ({ location: l.name, outfit: "a fitted mini dress", activity: a.text })));
    const slots = plan({ seed: 2, count: 6, categories: ["photoshoot"], excludePairs: pairs }).slots;
    expect(slots).toHaveLength(6);
  });

  test("a history line with no moment (written before 5a.2) reads as it always did", () => {
    const slots = plan({ seed: 2, count: 6, categories: ["photoshoot"], excludePairs: [{ location: "a busy road", outfit: "a hoodie, a knit mini and sneakers" }] }).slots;
    expect(slots).toHaveLength(6);
  });
});

describe("the fallback chain, on `clean:` only (a custom pool or an impossible case)", () => {
  const without = (drop: (capture: Capture) => boolean): Pool => ({
    ...POOLS.home,
    locations: POOLS.home.locations.map((place) => ({ ...place, activities: place.activities.filter((a) => !(a.captures ?? []).some(drop)) })).filter((place) => place.activities.length > 0),
  });

  test("a «Дом» pool with no prone moment still plans every slot, never a friend or a candid", () => {
    const pool = without((c) => c === "prone");
    for (let seed = 1; seed <= 30; seed++) {
      const slots = planWithPools({ seed, count: 24, categories: ["home"] }, { ...POOLS, home: pool }).slots;
      expect(slots).toHaveLength(24);
      for (const slot of slots) {
        expect(captureOf(slot)).not.toBe("friend");
        expect(captureOf(slot)).not.toBe("candid");
      }
    }
  });

  test("a pool with no prone moment steps prone down to above, never off the self-shot family", () => {
    const pool = without((c) => c === "prone");
    const captures = new Set(
      Array.from({ length: 30 }, (_, i) => planWithPools({ seed: i + 1, count: 12, categories: ["home"] }, { ...POOLS, home: pool }).slots.map(captureOf)).flat(),
    );
    expect(captures.has("prone")).toBe(false);
    expect(captures.has("above")).toBe(true);
    expect(captures.has("friend")).toBe(false);
  });

  test("the chain is deterministic", () => {
    const pool = without((c) => c === "prone");
    const draw = (): PlanSlot[] => planWithPools({ seed: 9, count: 24, categories: ["home"] }, { ...POOLS, home: pool }).slots;
    expect(draw()).toEqual(draw());
  });
});

// I5.22, I5.24: whatever the planner draws, the code template renders (no slot of a built-in plan falls to the LLM writer), and a long plan's sentences are mostly distinct.
describe("what the planner draws, the template renders", () => {
  test.each([...ORDINARY_BUILT_INS])("%s: every slot of 40 seeded plans renders a sentence, with every pose allowed", (category) => {
    for (let seed = 1; seed <= 40; seed++) {
      const seen = new Set<string>();
      for (const slot of plan({ seed, count: 30, categories: [category] }).slots) {
        const sentence = templateSentence({ ...slot, route: slot.route }, { key: `run-${seed}:${slot.attemptIdBase}`, seen });
        expect(sentence, `${slot.location} / ${slot.activity} / ${captureOf(slot)} / ${slot.pose}`).not.toBeNull();
        if (sentence !== null) seen.add(sentence);
      }
    }
  });

  test.each([...ORDINARY_BUILT_INS])("%s: at least 80 %% of a 100-slot plan's sentences are distinct (I5.24)", (category) => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const seen = new Set<string>();
      for (const slot of plan({ seed, count: 100, categories: [category] }).slots) {
        const sentence = templateSentence({ ...slot, route: slot.route }, { key: `run-${seed}:${slot.attemptIdBase}`, seen });
        if (sentence !== null) seen.add(sentence);
      }
      expect(seen.size, `${category} seed ${seed}`).toBeGreaterThanOrEqual(80);
    }
  });
});

describe("the banks' texts", () => {
  test("every moment text is within the pool text bound (35), not raised", () => {
    for (const category of ORDINARY_BUILT_INS) {
      for (const place of POOLS[category].locations) for (const activity of place.activities) expect(activity.text.length).toBeLessThanOrEqual(POOL_TEXT_MAX);
    }
    expect(POOL_TEXT_MAX).toBe(35);
  });
});
