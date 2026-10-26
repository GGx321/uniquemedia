import { describe, expect, test } from "bun:test";
import type { Capture } from "../captures";
import { swimwearWordsIn } from "./boldRules";
import { AWAY_ACTION_WORDS, unfabricBottomsIn, WALKS_AWAY_WORDS } from "../words";
import { BEACH } from "./beach";
import { boldAnyProblems, boldBankProblems } from "./schema";
import type { Moment, Outfit } from "./types";

// 5a.3 (S5.9b2, plan s5a3 §6.3, answer (a)): «Пляж и бассейн», a «Смелая» bank. At the beach and the pool she mostly asks someone (a friend three times in six, a
// candid), sometimes a selfie or the phone on a timer. Swimwear on every frame: every outfit is swimwear on Seedream with its coverage sentence, and every moment in
// the water pins it (M6); the level picks the cut, the pose and the gaze. No prone frame (prone is for her bed only), no mirror, no friend crouching at her feet.

const moments = BEACH.places.flatMap((place) => place.moments.map((moment) => ({ place: place.name, moment })));
const momentNamed = (text: string): { place: string; moment: Moment } | undefined => moments.find((m) => m.moment.text === text);
const outfitNamed = (text: string): Outfit | undefined => BEACH.outfits.find((o) => o.text === text);
const sorted = (items: readonly string[]): string[] => [...items].sort();

const BIKINI = "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her.";
const SWIMSUIT = "Her swimsuit fully covers her chest and her hips.";
/** The swimwear a moment in the water pins: the swimsuits and bikinis of every level, no shirt, no sweatshirt, no sarong, no hat. */
const IN_THE_WATER = ["a one-piece swimsuit", "a sporty bikini", "a black bikini", "a white bikini", "a white string bikini", "a red triangle bikini", "a strapless bandeau bikini", "a high-leg black swimsuit"];
const LEGS = ["a one-piece swimsuit", "a bikini and a sarong", "a black bikini", "a white bikini", "a white string bikini", "a red triangle bikini"];
/** Review round 2: her feet in the water wear swimwear only, no sarong. */
const LEGS_IN_THE_WATER = ["a one-piece swimsuit", "a sporty bikini", "a black bikini", "a white bikini", "a white string bikini", "a red triangle bikini"];

describe("«Пляж и бассейн» validates as a «Смелая» bank", () => {
  test("it passes the «Смелая» schema", () => {
    expect(boldBankProblems(BEACH)).toEqual([]);
  });
});

describe("who takes the photo: mostly someone she asked (I5.32)", () => {
  test("the deck of 6: a friend three times, a selfie, a timer, a candid", () => {
    expect(sorted(BEACH.captureDeck)).toEqual(sorted(["friend", "friend", "friend", "selfie", "timer", "candid"]));
  });

  test("no mirror, no prone and no over-the-shoulder frame, and no friend crouching at her feet", () => {
    const never: Capture[] = ["mirror", "mirror-hidden", "prone", "over-shoulder", "above", "low-feet"];
    expect(moments.filter((m) => m.moment.captures.some((c) => never.includes(c))).map((m) => m.moment.text)).toEqual([]);
    expect(moments.filter((m) => /\bstomach\b|\bprone\b/.test(m.moment.text)).map((m) => m.moment.text)).toEqual([]);
  });

  test("her face is hidden only by a moment seen from behind, and the moments that turn away are few", () => {
    const away = moments.filter((m) => m.moment.angle === "back" || m.moment.angle === "profile").map((m) => m.moment.text);
    expect(away).toEqual([
      "ties her hair in a loose knot",
      "stretches her arms out, knee-deep",
      "stretches one arm along the edge",
      "adjusts the strap on her shoulder",
      // S5.R4 round 3: a second moment in profile at the rooftop pool, which draws more frames with one legs moment left there.
      "crouches, one hand in the water",
      "sits hugging her knees",
      "tucks her hair back in the breeze",
      "sits with her hands clasped",
    ]);
  });

  // S5.9c round 2: a flirty or bold slot never turns its back, so the plan's away frames fall on the moments in profile; with one of them in every place they go round the places
  // instead of repeating the rocks' one (beach at «Смелая», seed 26: «tucks her hair back in the breeze» in 10 of 100 frames).
  test("every place holds a moment in profile that a friend or a candid takes, so the away frames spread over the places", () => {
    for (const place of BEACH.places) {
      const profile = place.moments.filter((m) => m.angle === "profile" && m.level === undefined && (m.captures.includes("friend") || m.captures.includes("candid")));
      expect(profile.length, place.name).toBeGreaterThanOrEqual(1);
    }
  });

  test("every moment that is not a legs moment is outdoors (a cap goes only to one of them)", () => {
    for (const { moment } of moments) expect({ text: moment.text, outdoor: moment.outdoor }).toEqual({ text: moment.text, outdoor: moment.legs === undefined ? true : undefined });
  });
});

describe("the places (plan §6.3)", () => {
  // S5.R4: an object she could hold sits in the place («… beside her», «… on a side table»): said «…, with {detail}.», a bare one read as a prop in her hands.
  test("five places by the sea and the pool, with their times and details", () => {
    expect(BEACH.places.map((p) => ({ name: p.name, at: p.at, times: p.times, details: p.details, room: p.room, mirror: p.mirror }))).toEqual([
      { name: "the beach", at: "on a sandy beach", times: ["morning", "midday", "golden hour"], details: ["a canvas tote bag beside her", "a striped umbrella planted nearby", "some small waves behind her"], room: undefined, mirror: undefined },
      { name: "the water's edge", at: "at the edge of the sea", times: ["morning", "midday", "golden hour"], details: ["a sailboat on the horizon", "the open horizon behind her"], room: undefined, mirror: undefined },
      { name: "a hotel pool", at: "by a hotel pool", times: ["morning", "midday"], details: ["a folded towel on a deck chair", "two palm trees", "a glass of iced tea on a side table"], room: undefined, mirror: undefined },
      { name: "a rooftop pool", at: "by a rooftop pool", times: ["midday", "golden hour"], details: ["the city skyline behind her", "a low white daybed"], room: undefined, mirror: undefined },
      { name: "the rocks by the sea", at: "on the rocks by the sea", times: ["golden hour", "evening"], details: ["the warm evening sky", "a few gulls overhead"], room: undefined, mirror: undefined },
    ]);
  });

  // 5a.4 (S5.BA2, r2.1 N3): a water place, where every outfit a moment can wear is swimwear. A tag only: the planner does not read it, so no beach plan moves.
  test("every place is a water place", () => {
    expect(BEACH.places.map((p) => [p.name, p.water])).toEqual(BEACH.places.map((p) => [p.name, true]));
  });

  test("the 5a.4 rules pass beach as shipped: its 12 general swimwear outfits at its five water places", () => {
    expect(BEACH.outfits.filter((o) => o.pinOnly !== true)).toHaveLength(12);
    expect(boldAnyProblems(BEACH, "beach")).toEqual([]);
  });
});

describe("the moments and their levels (plan §6.3)", () => {
  test.each<[string, string, readonly Capture[], "flirty" | "bold" | undefined, string]>([
    // Review round 2: one «sits on the sand» at the beach (the legs one), and one rest on her knees in the bank (the rocks' hugged knees).
    ["the beach", "brushes sand off her legs", ["friend", "selfie", "timer", "candid"], undefined, "she brushes the sand off slowly"],
    // Review round 2: the bold moments stand at three places, and a timer or a candid takes them too.
    ["the beach", "lies back on her elbows", ["friend", "timer", "candid"], "bold", "she tilts her head back a little"],
    ["a hotel pool", "sits on the lounger, legs crossed", ["friend", "selfie", "timer", "candid"], "bold", "she sways her crossed foot slowly"],
    ["the beach", "shades her eyes with one hand", ["friend", "selfie", "timer", "candid"], undefined, "she lowers her hand slowly and smiles"],
    ["the beach", "lowers her sunglasses a little", ["selfie", "friend"], "flirty", "she slowly peeks over her sunglasses"],
    ["the beach", "wrings out her wet hair", ["friend", "timer", "candid"], undefined, "she squeezes her hair slowly"],
    ["the water's edge", "walks along the shore", ["friend", "candid"], undefined, "she walks on slowly, the water at her feet"],
    ["the water's edge", "stands waist-deep, looking back", ["friend"], "flirty", "she turns her head a little further and smiles"],
    ["the water's edge", "laughs as a wave reaches her", ["friend", "candid"], undefined, "she laughs and steps back a little"],
    ["the water's edge", "steps out of the water", ["friend", "candid"], undefined, "she keeps walking slowly"],
    ["a hotel pool", "lies back on a sun lounger", ["friend", "selfie", "timer", "candid"], undefined, "she tilts her face to the sun a little"],
    ["a hotel pool", "sits on the edge, feet in the water", ["friend", "selfie", "timer", "candid"], undefined, "she swirls her feet slowly"],
    ["a hotel pool", "leans on the edge in the water", ["friend", "timer", "candid"], undefined, "she kicks her feet slowly behind her"],
    ["a rooftop pool", "leans on the glass railing", ["friend", "selfie", "candid"], "flirty", "her hair lifts a little in the wind"],
    ["a rooftop pool", "looks back over her shoulder", ["friend", "timer"], "bold", "she turns her head a little further"],
    ["a rooftop pool", "sips a cold drink by the water", ["friend", "selfie", "candid"], undefined, "she lowers the glass a little"],
    ["the rocks by the sea", "sits hugging her knees", ["friend", "timer"], undefined, "her hair stirs in the wind a little"],
    ["the rocks by the sea", "sits cross-legged on a towel", ["friend", "selfie", "candid"], undefined, "she leans back a little"],
    ["the rocks by the sea", "leans back on her hands", ["friend", "timer", "candid"], undefined, "she leans her head back a little"],
    ["the rocks by the sea", "tucks her hair back in the breeze", ["friend", "candid"], undefined, "she tucks a strand back slowly"],
  ])("%s · «%s»", (place, text, captures, level, motion) => {
    const found = momentNamed(text);
    expect(found?.place).toBe(place);
    expect({ captures: found?.moment.captures, level: found?.moment.level, motion: found?.moment.motion, legs: found?.moment.legs }).toEqual({ captures, level, motion, legs: undefined });
  });

  test("the beach probe's compositions: waist-deep looking back, three-quarter with her own gaze; looking back on the rooftop pool, bold; from behind on the rocks, hugging her knees", () => {
    expect(momentNamed("stands waist-deep, looking back")?.moment).toMatchObject({ angle: "three-quarter", gaze: "own", water: true });
    expect(momentNamed("looks back over her shoulder")?.moment).toMatchObject({ angle: "three-quarter", gaze: "own", level: "bold", route: "seedream" });
    expect(momentNamed("sits hugging her knees")?.moment).toMatchObject({ angle: "back", twoHanded: true });
    expect(momentNamed("tucks her hair back in the breeze")?.moment).toMatchObject({ angle: "profile", hair: "own" });
  });

  test("the bold moments are drawn on Seedream, and only they carry a route: every outfit is Seedream anyway", () => {
    expect(moments.filter((m) => m.moment.route !== undefined).map((m) => m.moment.text)).toEqual(["lies back on her elbows", "sits on the lounger, legs crossed", "looks back over her shoulder"]);
  });

  test("the bold moments stand at three places and not only a friend takes them (review round 2)", () => {
    const bold = moments.filter((m) => m.moment.level === "bold");
    expect(new Set(bold.map((m) => m.place)).size).toBe(3);
    expect(bold.every((m) => m.moment.captures.some((c) => c !== "friend"))).toBe(true);
  });

  test("no place holds two moments that open alike, and only one moment rests on her knees (review round 2)", () => {
    for (const place of BEACH.places) {
      const openings = place.moments.map((m) => m.text.split(/[ ,]+/).slice(0, 4).join(" "));
      expect({ place: place.name, repeats: openings.filter((o, i) => openings.indexOf(o) !== i) }).toEqual({ place: place.name, repeats: [] });
    }
    expect(moments.filter((m) => /\bknees\b/.test(`${m.moment.text} ${m.moment.motion}`)).map((m) => m.moment.text)).toEqual(["sits hugging her knees"]);
  });

  test("a laugh and her hair are the moment's own: the laugh takes no cue, the hair no hair line", () => {
    expect(momentNamed("laughs as a wave reaches her")?.moment.expression).toBe(true);
    expect(momentNamed("wrings out her wet hair")?.moment).toMatchObject({ hair: "own", twoHanded: true });
  });
});

describe("swimwear on every frame (answer (a), M6)", () => {
  test("every moment in the water or at its edge carries the water tag and pins only swimwear", () => {
    const water = moments.filter((m) => m.moment.water === true).map((m) => m.moment.text);
    expect(sorted(water)).toEqual(
      sorted([
        "walks along the shore",
        "stands waist-deep, looking back",
        "laughs as a wave reaches her",
        "steps out of the water",
        "wrings out her wet hair",
        "sits on the edge, feet in the water",
        "leans on the edge in the water",
        "dangles her feet in the water",
        "lets the waves wash over her feet",
        "stretches her arms out, knee-deep",
        "stretches one arm along the edge",
        "crouches, one hand in the water",
      ]),
    );
    for (const { moment } of moments.filter((m) => m.moment.water === true)) {
      expect(moment.outfits?.length ?? 0, moment.text).toBeGreaterThan(0);
      for (const outfit of moment.outfits ?? []) expect(swimwearWordsIn(outfit).length, `${moment.text}: ${outfit}`).toBeGreaterThan(0);
      // Review round 2: nothing worn over the swimwear in the water, her feet in it included.
      expect((moment.outfits ?? []).filter((o) => /\b(?:shirt|sweatshirt|sarong)\b/.test(o)), moment.text).toEqual([]);
    }
  });

  // S5.9c round 3: the strap action met «a strapless bandeau bikini» (43 of 489 bold frames) and «bikini bottoms and a sweatshirt» (71).
  test("the action on a strap pins the outfits that have shoulder straps, and none of the strapless, shirt or sweatshirt ones", () => {
    const pinned = momentNamed("adjusts the strap on her shoulder")?.moment.outfits ?? [];
    expect(pinned.length).toBeGreaterThanOrEqual(4);
    expect(pinned).not.toContain("a strapless bandeau bikini");
    expect(pinned).not.toContain("bikini bottoms and a sweatshirt");
    expect(pinned).not.toContain("a bikini under a linen shirt");
    expect(pinned).toContain("a one-piece swimsuit");
  });

  test("in the water she wears a swimsuit or a bikini of every level; waist-deep also the bikini and straw hat she was drawn in (P-5a3 #5)", () => {
    for (const { moment } of moments.filter((m) => m.moment.water === true && m.moment.legs === undefined && m.moment.text !== "stands waist-deep, looking back")) expect(moment.outfits, moment.text).toEqual(IN_THE_WATER);
    expect(momentNamed("stands waist-deep, looking back")?.moment.outfits).toEqual([...IN_THE_WATER, "a bikini and a straw hat"]);
  });

  test("every outfit is swimwear, drawn on Seedream, with its coverage sentence", () => {
    for (const outfit of BEACH.outfits) expect({ text: outfit.text, route: outfit.route, swimwear: swimwearWordsIn(outfit.text).length > 0, coverage: outfit.coverage !== undefined }).toEqual({ text: outfit.text, route: "seedream", swimwear: true, coverage: true });
  });

  test.each<[string, "flirty" | "bold" | undefined, string]>([
    ["a one-piece swimsuit", undefined, SWIMSUIT],
    ["a sporty bikini", undefined, BIKINI],
    ["a bikini and a sarong", undefined, "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her; the sarong is tied at her hips."],
    ["a bikini under a linen shirt", undefined, "Her linen shirt hangs open over her bikini, which fully covers her breasts and her hips."],
    ["a black bikini", "flirty", BIKINI],
    ["a white bikini", "flirty", BIKINI],
    ["a bikini and a straw hat", "flirty", BIKINI],
    ["bikini bottoms and a sweatshirt", "flirty", "Her sweatshirt covers her chest, and her bikini bottoms fully cover her."],
    ["a white string bikini", "bold", BIKINI],
    ["a red triangle bikini", "bold", BIKINI],
    ["a strapless bandeau bikini", "bold", BIKINI],
    // Review round 2: a high-leg cut shows her hips; it covers her bottom.
    ["a high-leg black swimsuit", "bold", "Her swimsuit fully covers her chest and her bottom."],
  ])("«%s» at %s", (text, level, coverage) => {
    expect(outfitNamed(text)).toEqual({ text, showsLegs: true, ...(level === undefined ? {} : { level }), route: "seedream", coverage });
  });

  test("no other outfit is in the bank, and no legwear: bare legs at the sea", () => {
    expect(BEACH.outfits).toHaveLength(12);
    expect(BEACH.legwear).toBeUndefined();
  });
});

// Review round 2 (C3′, the owner: «просто стоит спиной без какой-либо позы»): a moment seen from behind or in profile names what she is doing.
test("every moment seen from behind or in profile names a readable action and never walks away (C3′, main's rule)", () => {
  const away = moments.filter((m) => m.moment.angle === "back" || m.moment.angle === "profile");
  expect(away.length).toBeGreaterThan(0);
  expect(away.filter((m) => (!AWAY_ACTION_WORDS.test(m.moment.text) || WALKS_AWAY_WORDS.test(m.moment.text))).map((m) => m.moment.text)).toEqual([]);
});

// Review round 2 (C3′): a skirt or shorts names its fabric; the beach has none, and bikini bottoms are swimwear.
test("every skirt or shorts of the bank names its fabric (C3′, main's detector)", () => {
  const texts = [...BEACH.outfits.map((o) => o.text), ...moments.flatMap((m) => m.moment.outfits ?? [])];
  expect(texts.filter((t) => unfabricBottomsIn(t).length > 0)).toEqual([]);
});

describe("the legs moments (plan §6.3, M5): her own look down along her legs, never a low-feet frame", () => {
  test.each<[string, string, boolean, string]>([
    // S5.R4 round 2: «stretches her legs on the lounger» was «sits on the sand, legs out» again.
    ["a hotel pool", "lies on the lounger, one knee bent", false, "she sways her bent knee slowly"],
    ["the beach", "sits on the sand, legs out", false, "she slowly buries her toes in the sand"],
    // S5.R4 round 3: its motion was «Дом»'s and «Ночнушки»'s word for word.
    ["the beach", "crosses her ankles on the towel", false, "she taps her crossed feet together slowly"],
    ["a rooftop pool", "dangles her feet in the water", true, "she dips her toes in the water slowly"],
    // S5.R4: three more, so the six legs slots of a 20-photo run at «Ножки» 30 % never repeat one; round 2: each a pose of its own.
    ["the water's edge", "lets the waves wash over her feet", true, "she wiggles her toes in the foam slowly"],
    // S5.R4 round 3: «steps down into the water» was the third «feet in the water» picture; a dry step on the sand instead; polish after C4: standing with her feet in the sand, which reads from above.
    ["the beach", "stands with her feet in the sand", false, "she shifts from one foot to the other slowly"],
    ["the rocks by the sea", "lifts one leg, toes pointed", false, "she lowers her lifted leg slowly"],
  ])("%s · «%s»", (place, text, water, motion) => {
    const found = momentNamed(text);
    expect(found?.place).toBe(place);
    expect({ captures: found?.moment.captures, motion: found?.moment.motion, legs: found?.moment.legs, water: found?.moment.water, outfits: found?.moment.outfits }).toEqual({
      captures: ["pov-legs"],
      motion,
      legs: { framing: "legs" },
      water: water ? true : undefined,
      outfits: water ? LEGS_IN_THE_WATER : LEGS,
    });
  });
});

// S5.R4 round 3 (re-review, LOW): a look down at her feet sees what is at her feet, so every legs moment says details of its own, and none of them is far off.
test("every legs moment says details of its own: what is at her feet or under her", () => {
  for (const { moment } of moments.filter((m) => m.moment.legs !== undefined)) {
    expect(moment.details?.length ?? 0, moment.text).toBeGreaterThanOrEqual(2);
    for (const detail of moment.details ?? []) expect(detail, moment.text).toMatch(/\b(?:feet|toes|ankles|legs|under her|ahead of her)\b|\b(?:sand|foam)\b/);
  }
});

// Review of S5.9b2: two moments said the very same motion, so a clip of one read as a clip of the other.
describe("the motions", () => {
  test("no two moments of the bank say the same motion", () => {
    const motions = BEACH.places.flatMap((place) => place.moments.map((m) => m.motion));
    expect(motions.filter((motion, i) => motions.indexOf(motion) !== i)).toEqual([]);
  });
});
