import { describe, expect, test } from "bun:test";
import { allowedActivities, hasCleanActivity, isPhoneActivity, POOLS, type Activity, type Place, type Pool } from "./pools";
import { planWithPools } from "./planner";
import { redrawSlot } from "./redraw";
import { PlanSlotSchema, type PlanSlot } from "./schema";
import { CATEGORIES, SHOTS, type Shot } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.1c (T11, M3, N1): one shared filter decides which activities a shot may draw. A selfie or mirror has one hand on the phone, so it never gets a two-handed
// activity, and it never gets a phone activity either (the «second phone» defect: I5.2). The planner and «Другая сцена» (redraw.ts) both call it.

const one = (text: string, extra: Partial<Activity> = {}): Activity => ({ text, twoHanded: false, ...extra });
const two = (text: string): Activity => ({ text, twoHanded: true });
const SCROLL = one("scrolling her phone", { phone: true });
const MUG = one("holding a ceramic coffee mug");
const COOK = two("cooking pancakes");

const placeOf = (activities: Activity[], over: Partial<Place> = {}): Place => ({ name: "a place", times: ["morning"], activities, ...over });
const texts = (list: readonly Activity[]): string[] => list.map((a) => a.text);

describe("isPhoneActivity", () => {
  test("is true for an activity carrying the phone flag", () => {
    expect(isPhoneActivity({ text: "stretching", phone: true })).toBe(true);
  });

  test("is true for a custom activity whose text names her phone", () => {
    expect(isPhoneActivity({ text: "scrolling her phone" })).toBe(true);
    expect(isPhoneActivity({ text: "Checking a smartphone" })).toBe(true);
  });

  test("is true for the other ways a custom text names a phone: plural, iPhone, cellphone, texting, FaceTime", () => {
    for (const text of ["checking her phones", "holding her iPhone", "talking on a cellphone", "texting a friend", "on a FaceTime call", "taking a smartphones photo"]) {
      expect(isPhoneActivity({ text })).toBe(true);
    }
  });

  test("is false for text that only contains the letters of phone inside another word", () => {
    for (const text of ["adjusting her headphones", "waiting by the telephone box", "listening to a saxophone"]) expect(isPhoneActivity({ text })).toBe(false);
  });

  test("is false for an ordinary activity", () => {
    expect(isPhoneActivity({ text: "holding a ceramic coffee mug" })).toBe(false);
  });
});

describe("allowedActivities", () => {
  const place = placeOf([SCROLL, MUG, COOK]);

  test("a selfie drops two-handed and phone activities", () => {
    expect(texts(allowedActivities(place, "selfie"))).toEqual([MUG.text]);
  });

  test("a mirror shot drops two-handed and phone activities", () => {
    expect(texts(allowedActivities(place, "mirror"))).toEqual([MUG.text]);
  });

  test("a friend, candid or photographer shot keeps every activity", () => {
    for (const shot of ["friend", "candid", "photographer"] as const) expect(texts(allowedActivities(place, shot))).toEqual([SCROLL.text, MUG.text, COOK.text]);
  });

  test("a custom activity named by its text is dropped from a selfie too", () => {
    const custom = placeOf([one("texting on her phone"), one("leaning on the railing")]);
    expect(texts(allowedActivities(custom, "selfie"))).toEqual(["leaning on the railing"]);
  });

  test("a place whose only one-handed activity is a phone one has none for a selfie or mirror (S5.R1: no fallback to the phone), and all of them for the other shots", () => {
    const phoneOnly = placeOf([SCROLL, COOK]);
    expect(allowedActivities(phoneOnly, "selfie")).toEqual([]);
    expect(allowedActivities(phoneOnly, "mirror")).toEqual([]);
    expect(texts(allowedActivities(phoneOnly, "friend"))).toEqual([SCROLL.text, COOK.text]);
    expect(hasCleanActivity(phoneOnly)).toBe(false);
    expect(hasCleanActivity(placeOf([SCROLL, MUG]))).toBe(true);
  });

  test("a place with no phone activity draws the same list as the old two-handed filter", () => {
    const plain = placeOf([MUG, COOK, one("stretching")]);
    expect(texts(allowedActivities(plain, "mirror"))).toEqual([MUG.text, "stretching"]);
  });

  test("the filter is keyed to the two phone-in-hand shots only", () => {
    const both = placeOf([SCROLL, MUG]);
    for (const shot of SHOTS) expect(allowedActivities(both, shot).length).toBe(isPhoneHand(shot) ? 1 : 2);
  });
});

// ---------- the sweeps (N1) ----------

const CUSTOM_ID = "cat-phoneful" as const;
const SEEDS = Array.from({ length: 1000 }, (_, i) => i * 7919 + 1);
function isPhoneHand(shot: Shot): boolean {
  return shot === "selfie" || shot === "mirror";
}

const MIXED_CUSTOM: Pool = {
  locations: [
    placeOf([one("texting on her phone"), one("leaning on the railing"), two("cooking")], { name: "a bridge" }),
    placeOf([one("scrolling her phone"), one("browsing a shelf")], { name: "a bookshop", mirror: true }),
    placeOf([one("reading a menu"), SCROLL], { name: "a cafe" }),
  ],
  outfits: ["a trench coat and jeans", "a knit dress and boots"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};

/** Asserts that a selfie or mirror slot carries an activity of its place that is one-handed and not a phone one (S5.R1: a selfie or mirror never falls back to the phone). */
function expectCleanActivity(pool: Pool, slot: Pick<PlanSlot, "shot" | "location" | "activity">): void {
  if (!isPhoneHand(slot.shot)) return;
  const place = pool.locations.find((l) => l.name === slot.location) as Place;
  const activity = place.activities.find((a) => a.text === slot.activity) as Activity;
  expect(activity.twoHanded).toBe(false);
  expect(isPhoneActivity(activity)).toBe(false);
}

describe("the planner never plans a phone or two-handed activity on a selfie or mirror slot", () => {
  const pools: Record<string, Pool> = { ...POOLS, [CUSTOM_ID]: MIXED_CUSTOM };
  test("over 1000 seeds, every built-in category", () => {
    for (const seed of SEEDS) {
      for (const slot of planWithPools({ seed, count: 12, categories: [...CATEGORIES] }, pools).slots) expectCleanActivity(POOLS[slot.category as keyof typeof POOLS], slot);
    }
  });

  test("over 1000 seeds, a custom category with phone activities in its places", () => {
    for (const seed of SEEDS) {
      for (const slot of planWithPools({ seed, count: 10, categories: [CUSTOM_ID] }, pools).slots) expectCleanActivity(MIXED_CUSTOM, slot);
    }
  });
});

describe("«Другая сцена» (redrawSlot) never redraws a phone or two-handed activity onto a selfie or mirror slot", () => {
  const NO_AVOID = { locations: new Set<string>(), outfits: new Set<string>() };
  const NONE = { profile: false, back: false };
  const baseSlot = (shot: Shot, category: string, pool: Pool): PlanSlot =>
    PlanSlotSchema.parse({
      slotIndex: 1,
      category,
      location: (pool.locations[0] as Place).name,
      timeOfDay: "morning",
      activity: "x",
      outfit: pool.outfits[0],
      shot,
      pose: "front",
      attemptIdBase: "slot-1",
      repeatedPair: false,
    });

  const cases: Array<[string, Pool]> = [...CATEGORIES.map((c): [string, Pool] => [c, POOLS[c]]), [CUSTOM_ID, MIXED_CUSTOM]];
  for (const [category, pool] of cases) {
    for (const shot of ["selfie", "mirror"] as const) {
      test(`${category} ${shot}: 1000 seeds`, () => {
        const slot = baseSlot(shot, category, pool);
        for (const seed of SEEDS) {
          const out = redrawSlot({ seed, k: 1 + (seed % 5), slot, pool, avoid: NO_AVOID, poses: NONE });
          expectCleanActivity(pool, out);
        }
      });
    }
  }

  test("a friend slot may still redraw a phone activity (the filter is for selfie and mirror only)", () => {
    const pool: Pool = { locations: [placeOf([SCROLL], { name: "a bed" })], outfits: ["a hoodie", "a tee"], shotDeck: ["friend"] };
    const out = redrawSlot({ seed: 3, k: 1, slot: baseSlot("friend", "home", pool), pool, avoid: NO_AVOID, poses: NONE });
    expect(out.activity).toBe(SCROLL.text);
  });
});
