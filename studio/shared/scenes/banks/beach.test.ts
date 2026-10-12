import { describe, expect, test } from "bun:test";
import type { Capture } from "../captures";
import { swimwearWordsIn } from "./boldRules";
import { AWAY_ACTION, unfabricBottomsOf } from "./boldDesign.testkit";
import { BEACH } from "./beach";
import { boldBankProblems } from "./schema";
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
    expect(away).toEqual(["sits hugging her knees", "tucks her hair back in the breeze"]);
  });

  test("every moment that is not a legs moment is outdoors (a cap goes only to one of them)", () => {
    for (const { moment } of moments) expect({ text: moment.text, outdoor: moment.outdoor }).toEqual({ text: moment.text, outdoor: moment.legs === undefined ? true : undefined });
  });
});

describe("the places (plan §6.3)", () => {
  test("five places by the sea and the pool, with their times and details", () => {
    expect(BEACH.places.map((p) => ({ name: p.name, at: p.at, times: p.times, details: p.details, room: p.room, mirror: p.mirror }))).toEqual([
      { name: "the beach", at: "on a sandy beach", times: ["morning", "midday", "golden hour"], details: ["a canvas tote bag", "a striped umbrella", "some small waves behind her"], room: undefined, mirror: undefined },
      { name: "the water's edge", at: "at the edge of the sea", times: ["morning", "midday", "golden hour"], details: ["some wet sand", "a few seashells"], room: undefined, mirror: undefined },
      { name: "a hotel pool", at: "by a hotel pool", times: ["morning", "midday"], details: ["a folded towel", "two palm trees", "a glass of iced tea"], room: undefined, mirror: undefined },
      { name: "a rooftop pool", at: "by a rooftop pool", times: ["midday", "golden hour"], details: ["the city skyline behind her", "a low white daybed"], room: undefined, mirror: undefined },
      { name: "the rocks by the sea", at: "on the rocks by the sea", times: ["golden hour", "evening"], details: ["the warm evening sky", "a few gulls overhead"], room: undefined, mirror: undefined },
    ]);
  });
});

describe("the moments and their levels (plan §6.3)", () => {
  test.each<[string, string, readonly Capture[], "flirty" | "bold" | undefined, string]>([
    ["the beach", "sits on the sand, knees up", ["friend", "selfie", "timer"], undefined, "she slowly rests her chin on her knees"],
    ["the beach", "shades her eyes with one hand", ["friend"], undefined, "she lowers her hand slowly and smiles"],
    ["the beach", "lowers her sunglasses a little", ["selfie", "friend"], "flirty", "she slowly peeks over her sunglasses"],
    ["the beach", "wrings out her wet hair", ["friend", "candid"], undefined, "she squeezes her hair slowly"],
    ["the water's edge", "walks along the shore", ["friend", "candid"], undefined, "she walks on slowly, the water at her feet"],
    ["the water's edge", "stands waist-deep, looking back", ["friend"], "flirty", "she turns her head a little further and smiles"],
    ["the water's edge", "laughs as a wave reaches her", ["friend", "candid"], undefined, "she laughs and steps back a little"],
    ["the water's edge", "steps out of the water", ["friend", "candid"], undefined, "she keeps walking slowly"],
    ["a hotel pool", "lies back on a sun lounger", ["friend", "timer"], undefined, "she tilts her face to the sun a little"],
    ["a hotel pool", "sits on the edge, feet in the water", ["friend", "selfie", "candid"], undefined, "she swirls her feet slowly"],
    ["a hotel pool", "leans on the edge in the water", ["friend", "timer"], undefined, "she kicks her feet slowly behind her"],
    ["a rooftop pool", "leans on the glass railing", ["friend", "selfie"], "flirty", "her hair lifts a little in the wind"],
    ["a rooftop pool", "looks back over her shoulder", ["friend"], "bold", "she turns her head a little further"],
    ["a rooftop pool", "sips a cold drink by the water", ["friend", "selfie", "candid"], undefined, "she lowers the glass a little"],
    ["the rocks by the sea", "sits hugging her knees", ["friend", "timer"], undefined, "her hair lifts a little in the wind"],
    ["the rocks by the sea", "sits with her knees drawn up", ["friend", "selfie"], undefined, "she slowly rests her cheek on her knees"],
    ["the rocks by the sea", "leans back on her hands", ["friend", "timer", "candid"], undefined, "she tilts her head back a little"],
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

  test("the bold moment is drawn on Seedream, and only it carries a route: every outfit is Seedream anyway", () => {
    expect(moments.filter((m) => m.moment.route !== undefined).map((m) => m.moment.text)).toEqual(["looks back over her shoulder"]);
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
      ]),
    );
    for (const { moment } of moments.filter((m) => m.moment.water === true)) {
      expect(moment.outfits?.length ?? 0, moment.text).toBeGreaterThan(0);
      for (const outfit of moment.outfits ?? []) expect(swimwearWordsIn(outfit).length, `${moment.text}: ${outfit}`).toBeGreaterThan(0);
      // Review round 2: nothing worn over the swimwear in the water, her feet in it included.
      expect((moment.outfits ?? []).filter((o) => /\b(?:shirt|sweatshirt|sarong)\b/.test(o)), moment.text).toEqual([]);
    }
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
    ["a high-leg black swimsuit", "bold", SWIMSUIT],
  ])("«%s» at %s", (text, level, coverage) => {
    expect(outfitNamed(text)).toEqual({ text, showsLegs: true, ...(level === undefined ? {} : { level }), route: "seedream", coverage });
  });

  test("no other outfit is in the bank, and no legwear: bare legs at the sea", () => {
    expect(BEACH.outfits).toHaveLength(12);
    expect(BEACH.legwear).toBeUndefined();
  });
});

// Review round 2 (C3′, the owner: «просто стоит спиной без какой-либо позы»): a moment seen from behind or in profile names what she is doing.
test("every moment seen from behind or in profile names a readable action (C3′)", () => {
  const away = moments.filter((m) => m.moment.angle === "back" || m.moment.angle === "profile");
  expect(away.length).toBeGreaterThan(0);
  expect(away.filter((m) => !AWAY_ACTION.test(m.moment.text)).map((m) => m.moment.text)).toEqual([]);
});

// Review round 2 (C3′): a skirt or shorts names its fabric; the beach has none, and bikini bottoms are swimwear.
test("every skirt or shorts of the bank names its fabric (C3′)", () => {
  const texts = [...BEACH.outfits.map((o) => o.text), ...moments.flatMap((m) => m.moment.outfits ?? [])];
  expect(texts.filter((t) => unfabricBottomsOf(t).length > 0)).toEqual([]);
});

describe("the legs moments (plan §6.3, M5): her own look down along her legs, never a low-feet frame", () => {
  test.each<[string, string, boolean, string]>([
    ["a hotel pool", "stretches her legs on the lounger", false, "she points and flexes her toes slowly"],
    ["the beach", "sits on the sand, legs out", false, "she slowly buries her toes in the sand"],
    ["the beach", "crosses her ankles on the towel", false, "she crosses and uncrosses her ankles slowly"],
    ["a rooftop pool", "dangles her feet in the water", true, "she swirls her feet slowly"],
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
