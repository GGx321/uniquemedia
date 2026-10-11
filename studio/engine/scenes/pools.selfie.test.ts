import { describe, expect, test } from "bun:test";
import { plan, planWithPools } from "./planner";
import { allowedActivities, hasCleanActivity, POOLS, SELFIE_WORDS, type Activity, type Place, type Pool } from "./pools";
import { redrawSlot } from "./redraw";
import { PlanSlotSchema } from "./schema";
import { CATEGORIES } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// C1 (owner canary, 2026-10-11): the word «selfie» draws a phone, so a selfie slot's sentence may not say it (writer.ts, phone-in-selfie). A custom pool is
// LLM-written and may hold an activity or a place that says it; such a text must never reach a selfie slot, or the writer is told to use it, is refused twice
// and the run fails after two paid attempts (the same M3 scenario S5.R1 closed for phone words).

const one = (text: string): Activity => ({ text, twoHanded: false });

describe("SELFIE_WORDS", () => {
  test.each(["taking a selfie", "a Selfie wall", "snapping selfies", "front camera", "the front-camera look", "her front-facing camera", "a front facing camera", "FRONT-FACING-CAMERA"])("matches %j", (text) => {
    expect(SELFIE_WORDS.test(text)).toBe(true);
  });

  test.each(["the camera on the tripod", "a camera shop", "in front of the camera", "her front door", "a shelfie of books", "leaning on the railing", "the rear camera"])("does not match %j", (text) => {
    expect(SELFIE_WORDS.test(text)).toBe(false);
  });
});

describe("a selfie-worded activity or place is clean for no phone-in-hand shot", () => {
  const rail = one("leaning on the railing");
  const selfie = one("taking a selfie");

  test("a selfie slot does not draw an activity that says selfie", () => {
    expect(allowedActivities({ activities: [selfie, rail] }, "selfie")).toEqual([rail]);
  });

  test("a mirror slot follows the phone-word rule: it drops the activity too", () => {
    expect(allowedActivities({ activities: [selfie, rail] }, "mirror")).toEqual([rail]);
  });

  test.each(["friend", "candid", "photographer"] as const)("a %s slot may draw it: no phone is drawn for her", (shot) => {
    expect(allowedActivities({ activities: [selfie, rail] }, shot)).toEqual([selfie, rail]);
  });

  test("a place whose only free-hand activity says selfie has no clean activity", () => {
    expect(hasCleanActivity({ activities: [selfie, { text: "cooking", twoHanded: true }] })).toBe(false);
  });

  test("a place named with selfie has no clean activity, whatever it offers", () => {
    expect(hasCleanActivity({ name: "a selfie wall", activities: [rail] })).toBe(false);
    expect(hasCleanActivity({ name: "a wall", at: "at the front-camera mural", activities: [rail] })).toBe(false);
  });

  test("a place with a plain name and a plain activity is clean", () => {
    expect(hasCleanActivity({ name: "a wall", at: "at a wall", activities: [rail] })).toBe(true);
  });
});

describe("a custom pool with selfie words never feeds a selfie slot", () => {
  const REF = "cat-selfie-words";
  const POOL: Pool = {
    locations: [
      { name: "a selfie wall", times: ["morning", "midday"], mirror: true, activities: [one("leaning on the wall"), one("fixing her hair")] },
      { name: "a rooftop", times: ["evening"], mirror: true, activities: [one("taking a selfie"), one("leaning on the railing")] },
      { name: "a front-camera booth", at: "in a front-camera booth", times: ["midday"], activities: [one("fixing her hair")] },
      { name: "a plain bench", times: ["morning"], mirror: true, activities: [one("posing for a selfie"), one("sipping a tea")] },
      { name: "a bakery counter", times: ["morning"], activities: [one("choosing a croissant")] },
    ],
    outfits: ["a long cardigan and trousers", "a striped knit top and a midi skirt", "a denim jacket and jeans"],
    shotDeck: ["selfie", "mirror", "friend", "selfie", "candid"],
  };
  const POOLS_ALL: Record<string, Pool> = { ...POOLS, [REF]: POOL };
  const PHONE_IN_HAND = new Set(["selfie", "mirror"]);

  test("across many plans no selfie or mirror slot has a selfie-worded activity or place", () => {
    const offenders: string[] = [];
    let handShots = 0;
    for (let seed = 1; seed <= 200; seed++) {
      for (const slot of planWithPools({ seed: seed * 7919, count: 20, categories: [REF], poses: { profile: true, back: true } }, POOLS_ALL).slots) {
        if (!PHONE_IN_HAND.has(slot.shot)) continue;
        handShots += 1;
        const place = POOL.locations.find((l) => l.name === slot.location) as Place;
        if (SELFIE_WORDS.test(slot.activity) || SELFIE_WORDS.test(place.name) || SELFIE_WORDS.test(place.at ?? "")) offenders.push(`${seed}/${slot.slotIndex}: ${slot.shot} ${slot.location} / ${slot.activity}`);
      }
    }
    expect(handShots).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });

  test("a pool where every place says selfie turns its hand shots into friend snaps instead of failing", () => {
    const only: Pool = { ...POOL, locations: [POOL.locations[0] as Place, POOL.locations[2] as Place] };
    const slots = planWithPools({ seed: 5, count: 20, categories: [REF] }, { ...POOLS, [REF]: only }).slots;
    expect(slots.filter((s) => PHONE_IN_HAND.has(s.shot))).toEqual([]);
  });

  test("«Другая сцена» on a selfie slot never lands on a selfie-worded place or activity", () => {
    const NONE = { profile: false, back: false };
    const avoid = { locations: new Set<string>(), outfits: new Set<string>() };
    const offenders: string[] = [];
    for (let seed = 1; seed <= 100; seed++) {
      const slot = PlanSlotSchema.parse({ slotIndex: 1, category: REF, location: "a bakery counter", timeOfDay: "morning", activity: "choosing a croissant", outfit: POOL.outfits[0], shot: "selfie", pose: "front", attemptIdBase: "slot-1", repeatedPair: false });
      const out = redrawSlot({ seed: seed * 7919, k: 1 + (seed % 5), slot, pool: POOL, avoid, poses: NONE });
      const place = POOL.locations.find((l) => l.name === out.location) as Place;
      if (PHONE_IN_HAND.has(out.shot) && (SELFIE_WORDS.test(out.activity) || SELFIE_WORDS.test(place.name) || SELFIE_WORDS.test(place.at ?? ""))) offenders.push(`${seed}: ${out.location} / ${out.activity}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the built-in pools hold no selfie word at all, so their plans do not move", () => {
    for (const category of CATEGORIES) {
      const texts = POOLS[category].locations.flatMap((l) => [l.name, l.at ?? "", ...(l.details ?? []), ...l.activities.map((a) => a.text)]).concat(POOLS[category].outfits);
      expect(texts.filter((t) => SELFIE_WORDS.test(t))).toEqual([]);
    }
    expect(plan({ seed: 1, count: 5, categories: [...CATEGORIES] }).slots).toHaveLength(5);
  });
});
