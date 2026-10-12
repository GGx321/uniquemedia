import { describe, expect, test } from "bun:test";
import { BuiltInPoolSchema, isPhoneActivity, PHONE_WORDS, POOLS, validatePools, type Activity, type Place, type Pool } from "./pools";
import { POOL_TEXT_MAX } from "../../shared/engine";
import { withoutExemptLookPhrases } from "../../shared/scenes/words";
import { ORDINARY_BUILT_INS } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();
// 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): scoped to the five ordinary built-ins (ORDINARY_BUILT_INS), every assertion kept. The «Смелая» banks run their own sweeps.

// S5.1c (T11): the built-in pools are ordinary places of her own life: no paper, no screens but her phone, no studio, no luxury. The `phone` flag marks the
// activities with the phone in use; a room carries 2-3 ordinary details for the room draw (phoneLook.ts roomStateOf).

const allPlaces: Array<[string, Place]> = ORDINARY_BUILT_INS.flatMap((c) => POOLS[c].locations.map((p): [string, Place] => [c, p]));

// The paper, screen, luxury and soft-list words that must never enter a pool (the writer's 37-word list, plus paper and screens).
const BANNED =
  /\b(paper\w*|books?|magazines?|documents?|notebooks?|menus?|maps?|desks?|stud(?:y|ying|io)|laptops?|tablets?|screens?|newspapers?|television|tv|professional|photographer|photoshoot|editorial|fashion|models?|posing|captures?|candid|cinematic|bokeh|golden hour|softly lit|soft light|glow\w*|dramatic|moody|dreamy|elegant|luxurious|lavish|glamorous|chic|sophisticated|polished|pristine|marble|silk|satin|velvet|stunning|beautiful|perfect|flawless|gorgeous)\b/i;

const textsOf = (place: Place, outfits: readonly string[]): string[] => [place.name, place.at ?? "", ...(place.details ?? []), ...place.activities.map((a) => a.text), ...outfits];

describe("the built-in pools are ordinary places", () => {
  test("validate against the built-in schema at load", () => {
    expect(validatePools).not.toThrow();
  });

  for (const category of ORDINARY_BUILT_INS) {
    test(`${category}: no place, activity, detail or outfit uses a paper, screen, luxury or soft-list word`, () => {
      const pool = POOLS[category];
      for (const place of pool.locations) {
        for (const text of textsOf(place, [])) expect(withoutExemptLookPhrases(text)).not.toMatch(BANNED);
      }
      // K-22: «silk pajamas» is exempt from the luxury words (the owner's references); «satin» is not.
      for (const outfit of pool.outfits) expect(withoutExemptLookPhrases(outfit)).not.toMatch(BANNED);
    });
  }

  test("every place has at least one one-handed activity that is not a phone one", () => {
    for (const [, place] of allPlaces) expect(place.activities.some((a) => !a.twoHanded && !isPhoneActivity(a))).toBe(true);
  });

  test("the phone flag agrees with the words: an activity names her phone exactly when it is flagged", () => {
    for (const [, place] of allPlaces) for (const a of place.activities) expect(a.phone === true).toBe(PHONE_WORDS.test(a.text));
  });

  test("there are phone activities to filter (the rule is not vacuous on the real pools)", () => {
    const flagged = allPlaces.flatMap(([, place]) => place.activities.filter((a) => a.phone === true));
    expect(flagged.length).toBeGreaterThanOrEqual(2);
  });

  // K-3 (5a.2): every place carries 2 or 3 ordinary details; a room's go into its room phrase, the others into the sentence's `with {detail}`.
  test("every place carries 2 or 3 details", () => {
    for (const [, place] of allPlaces) expect([2, 3]).toContain(place.details?.length ?? 0);
  });

  test("messyOk marks an activity only in a room", () => {
    for (const [, place] of allPlaces) if (place.activities.some((a) => a.messyOk === true)) expect(place.room).toBe(true);
  });

  test("every place has a locative phrase for the sentence template", () => {
    for (const [, place] of allPlaces) expect(place.at?.length ?? 0).toBeGreaterThan(0);
  });

  // The place name goes to the writer as the slot's location whatever the room draw says, so mess in a name or a detail would contradict «The room is ordinary
  // and fairly tidy». The room draw (phoneLook.ts) is the only source of mess.
  test("no place name or detail carries mess: the room draw is the only source of it", () => {
    const MESS = /\b(unmade|clothes|messy|mess|clutter\w*|hoodie|charger|cables?|pile|piles)\b/i;
    for (const [, place] of allPlaces) for (const text of [place.name, place.at ?? "", ...(place.details ?? [])]) expect(text).not.toMatch(MESS);
  });

  test("a glamour place is lit by the evening or the night, never the morning (its outfits are going-out ones)", () => {
    for (const place of POOLS.glamour.locations) for (const time of place.times) expect(["evening", "night"]).toContain(time);
  });

  test("no travel outfit is a sundress that would sit oddly on a mountain viewpoint or a ferry deck", () => {
    expect(POOLS.travel.outfits).not.toContain("a light linen sundress");
  });

  test("the pavement cafe table has table moments and no counter", () => {
    const cafe = POOLS.photoshoot.locations.find((l) => l.name === "a cafe table on the pavement");
    expect(cafe?.activities.length).toBeGreaterThan(0);
    expect(cafe?.activities.map((a) => a.text).join(" ")).not.toMatch(/counter/);
  });

  test("every place name is unique within its category", () => {
    for (const category of ORDINARY_BUILT_INS) {
      const names = POOLS[category].locations.map((l) => l.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("the stored times stay inside the readable set, and no place is lit by «studio lighting»", () => {
    for (const [, place] of allPlaces) expect(place.times).not.toContain("studio lighting");
  });

  test("the photoshoot category deals friends, a selfie, a timer and a candid; the stored shots stay readable (no photographer is drawn any more)", () => {
    expect([...POOLS.photoshoot.shotDeck].sort()).toEqual(["candid", "friend", "friend", "friend", "friend", "selfie"]);
  });

  test("the rooms the owner pictured are there: a bedroom, a bed, a bathroom, a hallway, a front door and a floor", () => {
    const names = allPlaces.map(([, p]) => p.name);
    // S5.5: the glamour bedroom went with the other glamour places at home («вечер выхода»); the front door, where she gets ready, took its place.
    for (const expected of ["her bedroom", "her bed", "the floor of her bedroom", "her bathroom", "her hallway", "her front door"]) expect(names).toContain(expected);
  });
});

describe("the built-in pool schema", () => {
  const one = (text: string, extra: Partial<Activity> = {}): Activity => ({ text, twoHanded: false, ...extra });
  const place: Place = { name: "her small kitchen", times: ["morning"], activities: [one("holding a ceramic coffee mug")], room: true, details: ["a kettle on the counter", "a fruit bowl"], at: "in her small kitchen" };
  const pool: Pool = { locations: [place], outfits: ["a white t-shirt and cotton shorts"], shotDeck: ["friend"] };
  const withPlace = (over: Partial<Place>): Pool => ({ ...pool, locations: [{ ...place, ...over }] });

  test("accepts a well-formed room place", () => {
    expect(BuiltInPoolSchema.safeParse(pool).success).toBe(true);
  });

  test("rejects a place whose only one-handed activity is a phone one", () => {
    expect(BuiltInPoolSchema.safeParse(withPlace({ activities: [one("scrolling her phone", { phone: true }), { text: "cooking", twoHanded: true }] })).success).toBe(false);
  });

  test("rejects a phone activity without the flag (the flag must agree with the words)", () => {
    expect(BuiltInPoolSchema.safeParse(withPlace({ activities: [one("holding a ceramic coffee mug"), one("scrolling her phone")] })).success).toBe(false);
  });

  test("rejects a room with fewer than two details", () => {
    expect(BuiltInPoolSchema.safeParse(withPlace({ details: ["a fruit bowl"] })).success).toBe(false);
  });

  test("rejects a room with more than three details", () => {
    expect(BuiltInPoolSchema.safeParse(withPlace({ details: ["a", "b", "c", "d"].map((x) => `a ${x} on the counter`) })).success).toBe(false);
  });

  test("accepts details on a place that is not a room (K-3), and refuses a place with none", () => {
    const { room: _room, ...notRoom } = place;
    expect(BuiltInPoolSchema.safeParse({ ...pool, locations: [notRoom] }).success).toBe(true);
    const { details: _details, ...bare } = place;
    expect(BuiltInPoolSchema.safeParse({ ...pool, locations: [bare] }).success).toBe(false);
  });

  test("rejects messyOk outside a room", () => {
    const { room: _room, ...notRoom } = place;
    expect(BuiltInPoolSchema.safeParse({ ...pool, locations: [{ ...notRoom, activities: [one("stretching", { messyOk: true })] }] }).success).toBe(false);
  });

  test("rejects a paper or screen word in an activity", () => {
    expect(BuiltInPoolSchema.safeParse(withPlace({ activities: [one("reading a paperback")] })).success).toBe(false);
    expect(BuiltInPoolSchema.safeParse(withPlace({ activities: [one("typing on the laptop")] })).success).toBe(false);
  });

  test("rejects a luxury word in a detail and a soft-list word in an outfit", () => {
    expect(BuiltInPoolSchema.safeParse(withPlace({ details: ["a marble counter", "a fruit bowl"] })).success).toBe(false);
    expect(BuiltInPoolSchema.safeParse({ ...pool, outfits: ["a satin evening dress"] }).success).toBe(false);
  });

  test("rejects a detail that suggests a minor", () => {
    expect(BuiltInPoolSchema.safeParse(withPlace({ details: ["a schoolgirl uniform on the chair", "a fruit bowl"] })).success).toBe(false);
  });

  // S5.R1 H1: a non-mirror shot can land on any place, so no place may say «mirror» in its name; the mirror capture line names the mirror itself.
  test("rejects a place whose name says mirror, in any case", () => {
    expect(BuiltInPoolSchema.safeParse(withPlace({ name: "her bedroom mirror" })).success).toBe(false);
    expect(BuiltInPoolSchema.safeParse(withPlace({ name: "the Gym Mirror wall" })).success).toBe(false);
  });

  test("rejects a place whose locative phrase says mirror", () => {
    expect(BuiltInPoolSchema.safeParse(withPlace({ at: "at her bedroom mirror" })).success).toBe(false);
  });

  test("keeps the mirror flag on a place that does not name a mirror", () => {
    expect(BuiltInPoolSchema.safeParse(withPlace({ name: "her bedroom", at: "in her bedroom", mirror: true })).success).toBe(true);
  });

  // The writer's floor pins (writer.custom.test.ts) hold a custom pool to POOL_TEXT_MAX; the built-in pools are held to the same bound, so one worst chunk covers both.
  test(`rejects a place name, an activity or an outfit of more than ${POOL_TEXT_MAX} characters`, () => {
    const long = "x".repeat(POOL_TEXT_MAX + 1);
    expect(BuiltInPoolSchema.safeParse(withPlace({ name: long })).success).toBe(false);
    expect(BuiltInPoolSchema.safeParse(withPlace({ activities: [one(long)] })).success).toBe(false);
    expect(BuiltInPoolSchema.safeParse({ ...pool, outfits: [long] }).success).toBe(false);
  });

  test(`accepts texts of exactly ${POOL_TEXT_MAX} characters`, () => {
    const edge = "x".repeat(POOL_TEXT_MAX);
    expect(BuiltInPoolSchema.safeParse({ ...withPlace({ name: edge, activities: [one(edge)] }), outfits: [edge] }).success).toBe(true);
  });
});
