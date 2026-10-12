import { describe, expect, test } from "bun:test";
import { CAPTURES, posesFor, type Capture } from "../../shared/scenes/captures";
import { fittingMoments, fittingPlaces, kindOfDeck, momentFits, settleFit, stepDownOf, type PoolKind } from "./fit";
import { POOLS, type Place, type Pool } from "./pools";
import { CATEGORIES } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6b, I5.23, plan s5a2 §5.2): the planner draws capture, then pose, then a place that has a fitting moment, then the least-used fitting moment.
// `fittingMoments` and `fittingPlaces` are that rule's pure core, shared by the planner and «Другая сцена» (redraw.ts); `stepDownOf` is the fallback chain's
// capture step (read on `clean:` only by a custom pool or an impossible case, never by a built-in plan).

describe("fittingMoments", () => {
  const bed = (): Place => {
    const place = POOLS.home.locations.find((l) => l.name === "her bed");
    if (place === undefined) throw new Error("no bed");
    return place;
  };

  test("a prone selfie takes only the moments that list prone", () => {
    const fits = fittingMoments(bed(), "prone", "front");
    expect(fits.length).toBeGreaterThan(0);
    expect(fits.every((m) => m.captures?.includes("prone") === true)).toBe(true);
  });

  // S5.7b (I5.26): the pose argument is the DRAWN pose (front or three-quarter); a moment with an angle sets the slot's pose itself, so it fits whatever was drawn.
  test("a moment with an angle fits whatever front or three-quarter pose was drawn, and sets its own pose", () => {
    for (const drawn of ["front", "three-quarter"] as const) {
      expect(fittingMoments(bed(), "timer", drawn).some((m) => m.angle === "back")).toBe(true);
    }
  });

  test("a hand-held capture refuses a moment whose angle is profile or back, and a timer takes it", () => {
    const away = POOLS.home.locations.flatMap((l) => l.activities).filter((m) => m.angle === "back" || m.angle === "profile");
    expect(away.length).toBeGreaterThan(0);
    for (const capture of ["selfie", "mirror", "mirror-hidden", "above", "prone", "over-shoulder"] as const) {
      for (const moment of away) expect(momentFits(moment, capture, "front")).toBe(false);
    }
    expect(away.some((moment) => momentFits(moment, "timer", "front"))).toBe(true);
  });

  test("a hand-held capture never takes a two-handed or a phone moment", () => {
    for (const category of CATEGORIES) {
      for (const place of POOLS[category].locations) {
        for (const capture of ["selfie", "mirror", "mirror-hidden", "above", "prone", "over-shoulder"] as const) {
          expect(fittingMoments(place, capture, "front").some((m) => m.twoHanded || m.phone === true)).toBe(false);
        }
      }
    }
  });

  test("a viewer-gaze moment is never on a candid, a profile, a back or a face-hidden frame", () => {
    for (const category of CATEGORIES) {
      for (const place of POOLS[category].locations) {
        for (const [capture, pose] of [["candid", "front"], ["friend", "profile"], ["friend", "back"], ["mirror-hidden", "front"]] as const) {
          expect(fittingMoments(place, capture, pose).some((m) => m.gaze === "viewer")).toBe(false);
        }
      }
    }
  });

  test("a flirty moment is never offered to an ordinary slot", () => {
    const flirty: Place = { name: "x", times: ["morning"], activities: [{ text: "winks", twoHanded: false, level: "flirty", captures: ["friend"] }, { text: "waits", twoHanded: false, captures: ["friend"] }] };
    expect(fittingMoments(flirty, "friend", "front").map((m) => m.text)).toEqual(["waits"]);
  });
});

describe("fittingPlaces", () => {
  test("a mirror capture lands only on a mirror place", () => {
    for (const category of CATEGORIES) {
      for (const capture of ["mirror", "mirror-hidden"] as const) {
        const places = fittingPlaces(POOLS[category], capture, "front");
        expect(places.every((p) => p.mirror === true)).toBe(true);
      }
    }
  });

  test("a place with no fitting moment is left out", () => {
    const pool: Pool = {
      ...POOLS.travel,
      locations: [
        { name: "a", times: ["morning"], activities: [{ text: "waits", twoHanded: false, captures: ["friend"] }] },
        { name: "b", times: ["morning"], activities: [{ text: "sits", twoHanded: false, captures: ["selfie"] }] },
      ],
    };
    expect(fittingPlaces(pool, "friend", "front").map((p) => p.name)).toEqual(["a"]);
  });

  // The coverage rule of the banks (plan §5.1): each capture of a deck has a moment, at some place, for every pose the slice can draw. The planner
  // never reads the fallback chain for a built-in plan because of it.
  test.each([...CATEGORIES])("%s: every deck capture has a place with a moment for each pose it can take", (category) => {
    const pool = POOLS[category];
    for (const capture of new Set(pool.captureDeck)) {
      for (const pose of posesFor(capture)) expect(fittingPlaces(pool, capture, pose).length, `${capture} ${pose}`).toBeGreaterThan(0);
    }
  });
});

describe("stepDownOf (the fallback chain's capture step)", () => {
  const SELF: PoolKind = "self";
  const ASKED: PoolKind = "asked";
  const MIXED: PoolKind = "mixed";

  test.each<[PoolKind, Capture, Capture | undefined]>([
    [SELF, "mirror-hidden", "mirror"],
    [SELF, "mirror", "selfie"],
    [SELF, "over-shoulder", "prone"],
    [SELF, "prone", "above"],
    [SELF, "above", "selfie"],
    [SELF, "timer", "selfie"],
    [SELF, "selfie", undefined],
    [ASKED, "timer", "friend"],
    [ASKED, "selfie", "friend"],
    [ASKED, "friend", undefined],
    [MIXED, "mirror-hidden", "mirror"],
    [MIXED, "mirror", "selfie"],
    [MIXED, "selfie", "friend"],
    [MIXED, "timer", "selfie"],
  ])("%#: %s steps %s down to %s", (kind, capture, down) => {
    expect(stepDownOf(kind, capture)).toBe(down);
  });

  test("a self-shot chain never reaches a friend (I5.32: «Дом» without friend)", () => {
    for (const start of CAPTURES) {
      let capture: Capture | undefined = start;
      const seen: Capture[] = [];
      while (capture !== undefined) {
        seen.push(capture);
        capture = stepDownOf("self", capture);
      }
      if (start !== "friend" && start !== "candid" && start !== "low-feet") expect(seen).not.toContain("friend");
    }
  });

  test("every step keeps the hand-held / asked family of its kind and ends", () => {
    for (const kind of ["self", "asked", "mixed"] as const) {
      for (const start of CAPTURES) {
        let capture: Capture | undefined = start;
        for (let i = 0; i < 10 && capture !== undefined; i++) capture = stepDownOf(kind, capture);
        expect(capture).toBeUndefined();
      }
    }
  });
});

describe("kindOfDeck", () => {
  // 5a.3 (S5.9b2): «Ночнушки и бельё» is at home, self-shot; «Пляж и бассейн» is outside, asked.
  test.each([...CATEGORIES])("%s: the kind its deck says (self-shot at home and in her bedroom's nightwear, asked outside and at the beach, mixed for glamour and fitness)", (category) => {
    const kind = kindOfDeck(POOLS[category].captureDeck ?? []);
    expect(kind).toBe(category === "home" || category === "nightwear" ? "self" : category === "glamour" || category === "fitness" ? "mixed" : "asked");
  });
});

describe("settleFit (the fallback chain, read on `clean:` only)", () => {
  const only = (keep: (capture: Capture) => boolean): Pool => ({
    ...POOLS.home,
    locations: POOLS.home.locations.map((place) => ({ ...place, activities: place.activities.filter((a) => (a.captures ?? []).every(keep)) })).filter((place) => place.activities.length > 0),
  });

  test("a capture and pose that fit are returned as they are, with no step", () => {
    expect(settleFit(POOLS.home, "self", "mirror-hidden", "front")).toMatchObject({ capture: "mirror-hidden", pose: "front" });
  });

  test("a home pool with no prone moment steps prone down to a selfie from above, never to a friend", () => {
    const pool = only((c) => c !== "prone");
    const settled = settleFit(pool, "self", "prone", "front");
    expect(settled.capture).toBe("above");
  });

  test("a home pool with no timer moment steps a timer down to a selfie, never to a friend", () => {
    const pool: Pool = { ...POOLS.home, locations: [{ name: "a", times: ["morning"], activities: [{ text: "waits", twoHanded: false, captures: ["selfie", "friend"] }] }] };
    expect(settleFit(pool, "self", "timer", "front").capture).toBe("selfie");
  });

  test("a back pose that nothing fits becomes three-quarter", () => {
    const pool: Pool = { ...POOLS.travel, locations: [{ name: "a", times: ["morning"], activities: [{ text: "waits", twoHanded: false, captures: ["friend"], gaze: "viewer" }] }] };
    expect(settleFit(pool, "asked", "friend", "back")).toMatchObject({ capture: "friend", pose: "three-quarter" });
  });

  test("a candid that nothing fits becomes a friend on an asked pool, and stays unsettled on a self-shot one", () => {
    const pool: Pool = { ...POOLS.travel, locations: [{ name: "a", times: ["morning"], activities: [{ text: "waits", twoHanded: false, captures: ["friend"] }] }] };
    expect(settleFit(pool, "asked", "candid", "front").capture).toBe("friend");
    expect(() => settleFit(pool, "self", "candid", "front")).toThrow(RangeError);
  });

  test("an empty pool throws a RangeError instead of looping", () => {
    expect(() => settleFit({ locations: [] }, "asked", "friend", "front")).toThrow(RangeError);
  });
});
