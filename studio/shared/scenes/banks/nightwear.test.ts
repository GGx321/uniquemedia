import { describe, expect, test } from "bun:test";
import type { Capture } from "../captures";
import { boldWordsIn, lingerieWordsIn } from "./boldRules";
import { NIGHTWEAR } from "./nightwear";
import { boldBankProblems, categoryBankProblems } from "./schema";
import type { Moment, Outfit } from "./types";

// 5a.3 (S5.9b2, plan s5a3 §6.2 r3.1): «Ночнушки и бельё», a «Смелая» bank. At home she shoots herself: in the mirror (a third of the frames with the phone over her
// face), at arm's length from above as she lies there, lying on her stomach on her bed, over her own shoulder, on a timer. Ordinary is cotton nightwear on the owner's
// model; flirty is satin nightwear and bold is lingerie, both on Seedream at 2K, each with a positive coverage sentence. P-5a3 decided four items: the arm over her
// chest with only lace panties was refused 6/6 and left; the bedsheet, the babydoll with stockings and the prone bra and briefs were drawn and stay; a legs frame wears
// satin with stockings, never lingerie (#6). The bank text is the product: these rows pin it.

const moments = NIGHTWEAR.places.flatMap((place) => place.moments.map((moment) => ({ place: place.name, moment })));
const momentNamed = (text: string): { place: string; moment: Moment } | undefined => moments.find((m) => m.moment.text === text);
const outfitNamed = (text: string): Outfit | undefined => NIGHTWEAR.outfits.find((o) => o.text === text);
const sorted = (items: readonly string[]): string[] => [...items].sort();

const LACE = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
const SATIN_DRESS = "Her nightdress is opaque satin.";

describe("«Ночнушки и бельё» validates as a «Смелая» bank", () => {
  test("it passes the «Смелая» schema", () => {
    expect(boldBankProblems(NIGHTWEAR)).toEqual([]);
  });

  test("the five's schema refuses it: its fields are «Смелая» only", () => {
    expect(categoryBankProblems(NIGHTWEAR, "home").join("\n")).toMatch(/\[shape\] : Unrecognized key: "bold"/);
  });
});

describe("who takes the photo: she shoots herself (I5.32)", () => {
  test("the deck of 12: four phone-over-face mirror frames, three mirrors, two from above, one prone, one over her shoulder, one timer", () => {
    expect(sorted(NIGHTWEAR.captureDeck)).toEqual(sorted(["mirror-hidden", "mirror-hidden", "mirror-hidden", "mirror-hidden", "mirror", "mirror", "mirror", "above", "above", "prone", "over-shoulder", "timer"]));
  });

  test("no moment is a photo someone else took: no friend, no candid, no low-feet", () => {
    const asked: Capture[] = ["friend", "candid", "low-feet"];
    expect(moments.filter((m) => m.moment.captures.some((c) => asked.includes(c))).map((m) => m.moment.text)).toEqual([]);
  });

  test("she lies on her stomach, and looks back over her shoulder, only on her bed; a close selfie from above lies there too", () => {
    for (const { place, moment } of moments) {
      if (moment.captures.some((c) => c === "prone" || c === "over-shoulder" || c === "above")) expect(place, moment.text).toBe("her bed");
      if (/\bstomach\b|\bprone\b/.test(moment.text)) expect(place, moment.text).toBe("her bed");
    }
  });

  test("a prone or over-the-shoulder frame wears no legwear (the approved prone frames had bare legs)", () => {
    for (const { moment } of moments.filter((m) => m.moment.captures.some((c) => c === "prone" || c === "over-shoulder"))) expect(moment.noLegwear, moment.text).toBe(true);
  });

  test("side or back to the mirror, only her reflection: three phone-over-face moments, tagged mirrorBack", () => {
    expect(moments.filter((m) => m.moment.mirrorBack === true).map((m) => `${m.place}: ${m.moment.text}`)).toEqual([
      "her bedroom: stands sideways to the mirror",
      "her bedroom: pulls her jeans up over her panties",
      "her bathroom: sits on the counter",
    ]);
    for (const { moment } of moments.filter((m) => m.moment.mirrorBack === true)) expect({ captures: moment.captures, angle: moment.angle }).toEqual({ captures: ["mirror-hidden"], angle: "three-quarter" });
  });
});

describe("the places (plan §6.2)", () => {
  test("five rooms of her home, with their lamp, mirror, times and details", () => {
    expect(NIGHTWEAR.places.map((p) => ({ name: p.name, at: p.at, room: p.room, lamp: p.lamp, mirror: p.mirror, times: p.times }))).toEqual([
      { name: "her bed", at: "on her bed", room: true, lamp: true, mirror: true, times: ["morning", "evening", "night"] },
      { name: "her bedroom", at: "in her bedroom", room: true, lamp: true, mirror: true, times: ["morning", "evening", "night"] },
      { name: "her bathroom", at: "in her bathroom", room: true, lamp: undefined, mirror: true, times: ["morning", "evening", "night"] },
      { name: "an armchair in her bedroom", at: "in an armchair in her bedroom", room: true, lamp: true, mirror: true, times: ["evening", "night"] },
      { name: "her bedroom window", at: "by her bedroom window", room: true, lamp: undefined, mirror: undefined, times: ["morning", "evening"] },
    ]);
  });
});

describe("the moments and their levels (plan §6.2)", () => {
  test.each<[string, string, readonly Capture[], "flirty" | "bold" | undefined, string]>([
    ["her bed", "lies back against the pillows", ["above"], undefined, "she slowly blinks and smiles"],
    ["her bed", "sits cross-legged with her coffee", ["mirror"], undefined, "she sips and smiles a little"],
    ["her bed", "lies on her stomach, one arm out", ["prone"], undefined, "she swings her feet a little"],
    ["her bed", "lies prone, glancing back", ["over-shoulder"], undefined, "she turns her head a little further"],
    ["her bed", "lies prone, chin on her hand", ["prone"], "flirty", "she kicks her feet slowly behind her"],
    ["her bed", "lies on her stomach, hips behind", ["prone"], "bold", "she lifts her hips a little"],
    ["her bed", "lies on her stomach, feet up", ["over-shoulder"], "bold", "her raised feet swing slowly"],
    ["her bed", "lies back with her arms up", ["above"], "bold", "she stretches slowly and smiles"],
    ["her bed", "lies holding the sheet to her chest", ["above"], "bold", "she pulls the sheet a little higher"],
    ["her bedroom", "stretches after waking up", ["mirror-hidden", "mirror", "timer"], undefined, "she stretches her arms up slowly"],
    ["her bedroom", "sits on the edge of the bed", ["mirror-hidden", "mirror", "timer"], "flirty", "she swings one foot slowly"],
    ["her bedroom", "leans on the doorframe", ["mirror", "timer"], "flirty", "she shifts her shoulder slowly"],
    ["her bedroom", "stands with one hand on her hip", ["mirror-hidden", "mirror"], "bold", "she turns her hips a little"],
    ["her bedroom", "stands sideways to the mirror", ["mirror-hidden"], "bold", "she turns her head a little toward the mirror"],
    ["her bedroom", "pulls her jeans up over her panties", ["mirror-hidden"], "bold", "she tugs the waistband up slowly"],
    ["her bathroom", "brushes her hair", ["mirror-hidden", "mirror"], undefined, "she draws the brush down slowly"],
    ["her bathroom", "leans on the edge of the tub", ["mirror-hidden", "mirror"], undefined, "she leans back a little"],
    ["her bathroom", "leans toward the mirror", ["mirror"], "flirty", "she leans in a little closer"],
    ["her bathroom", "sits on the counter", ["mirror-hidden"], "bold", "she turns her head a little toward the mirror"],
    ["an armchair in her bedroom", "sits with one leg crossed", ["mirror-hidden", "mirror", "timer"], undefined, "she wiggles her crossed foot a bit"],
    ["an armchair in her bedroom", "tucks one leg under her", ["mirror-hidden", "mirror"], "flirty", "she settles a little deeper"],
    ["an armchair in her bedroom", "sits back, knees together", ["mirror-hidden", "mirror"], "bold", "she rocks a little in place"],
    ["her bedroom window", "looks out at the street", ["timer"], undefined, "she leans her head a little to one side"],
    ["her bedroom window", "opens the curtains", ["timer"], undefined, "she pulls the curtain a little wider"],
    ["her bedroom window", "leans against the wall", ["timer"], undefined, "she shifts her weight a little"],
    ["her bedroom window", "sits on the windowsill", ["timer"], "flirty", "she swings one foot a little"],
  ])("%s · «%s»", (place, text, captures, level, motion) => {
    const found = momentNamed(text);
    expect(found?.place).toBe(place);
    expect({ captures: found?.moment.captures, level: found?.moment.level, motion: found?.moment.motion, legs: found?.moment.legs }).toEqual({ captures, level, motion, legs: undefined });
  });

  test("every bold moment is drawn on Seedream, and no other moment is", () => {
    for (const { moment } of moments) expect({ text: moment.text, route: moment.route }).toEqual({ text: moment.text, route: moment.level === "bold" ? "seedream" : undefined });
  });

  test("the over-her-shoulder frames are three-quarter: she looks back along her body", () => {
    for (const { moment } of moments.filter((m) => m.moment.captures.includes("over-shoulder"))) expect(moment.angle, moment.text).toBe("three-quarter");
  });

  test("seen from behind at the window, she carries her own gaze", () => {
    expect(momentNamed("looks out at the street")?.moment).toMatchObject({ angle: "back", gaze: "own" });
    expect(momentNamed("opens the curtains")?.moment).toMatchObject({ twoHanded: true, gaze: "focus" });
  });

  test("the prone selfies wear what drew: grey lounge shorts on the owner's model, satin or lingerie on Seedream", () => {
    expect(momentNamed("lies on her stomach, one arm out")?.moment.outfits).toEqual(["grey lounge shorts and a fitted tee"]);
    expect(momentNamed("lies prone, glancing back")?.moment.outfits).toEqual(["grey lounge shorts and a fitted tee"]);
    expect(momentNamed("lies prone, chin on her hand")?.moment).toMatchObject({ outfits: ["grey lounge shorts and a fitted tee", "a satin cami and sleep shorts"], handAtFace: true });
    // P-5a3 #4: Seedream drew it, and no phone in her hands.
    expect(momentNamed("lies on her stomach, hips behind")?.moment.outfits).toEqual(["a black bra and briefs"]);
    expect(momentNamed("lies on her stomach, feet up")?.moment.outfits).toEqual(["a black lace bra and panties"]);
  });
});

describe("the P-5a3 decisions", () => {
  test("the arm over her chest with only lace panties left the bank (refused 6/6)", () => {
    const texts = [...moments.map((m) => m.moment.text), ...NIGHTWEAR.outfits.map((o) => o.text)].join(" | ");
    expect(texts).not.toMatch(/covers her chest with her arm|only lace panties/);
  });

  test("the bedsheet stays (drawn 3/3): the moment pins it and carries the coverage", () => {
    expect(momentNamed("lies holding the sheet to her chest")?.moment).toMatchObject({
      outfits: ["only the white bedsheet"],
      coverage: "The white sheet is held up to her chest and fully covers her breasts and her hips.",
      level: "bold",
      route: "seedream",
    });
    expect(outfitNamed("only the white bedsheet")).toEqual({ text: "only the white bedsheet", pinOnly: true, level: "bold", route: "seedream" });
  });

  test("the sheer babydoll over a lace set stays (drawn with thigh-high stockings), bold, with its coverage", () => {
    expect(outfitNamed("a sheer babydoll over a lace set")).toEqual({
      text: "a sheer babydoll over a lace set",
      showsLegs: true,
      level: "bold",
      route: "seedream",
      coverage: "Under her sheer babydoll, her lace bra and panties are lined and opaque and fully cover her.",
    });
  });

  test("a legs frame wears no lingerie (#6: stockings with lingerie on a legs frame was refused): cotton, or satin with the bold stockings", () => {
    const legs = moments.filter((m) => m.moment.legs !== undefined);
    expect(legs.length).toBe(4);
    for (const { moment } of legs) {
      expect(moment.outfits, moment.text).toEqual(["cotton pajama shorts and a tee", "a long cotton nightshirt", "a satin cami and sleep shorts", "a satin midi nightdress"]);
      for (const outfit of moment.outfits ?? []) expect(lingerieWordsIn(outfit), outfit).toEqual([]);
    }
  });
});

describe("the legs moments (plan §6.2, S5.8a rules, M5)", () => {
  test.each<[string, string, readonly Capture[], string]>([
    ["her bed", "lies with her legs crossed", ["pov-legs"], "she crosses and uncrosses her ankles slowly"],
    ["an armchair in her bedroom", "sits with her legs stretched out", ["pov-legs"], "she points her toes slowly"],
    ["her bedroom", "lifts one foot to the mirror", ["mirror-hidden"], "she lifts her foot a little and lowers it"],
    ["her bedroom", "sits with her feet to the mirror", ["mirror-hidden"], "she taps her feet together a little"],
  ])("%s · «%s»", (place, text, captures, motion) => {
    const found = momentNamed(text);
    expect(found?.place).toBe(place);
    expect({ captures: found?.moment.captures, motion: found?.moment.motion, legs: found?.moment.legs, level: found?.moment.level }).toEqual({ captures, motion, legs: { framing: "legs" }, level: undefined });
  });
});

describe("the outfits: cotton, satin, lingerie (plan §6.2)", () => {
  test.each<[string, boolean, boolean]>([
    ["an oversized sleep tee", true, false],
    ["cotton pajama shorts and a tee", true, false],
    ["a long cotton nightshirt", true, false],
    ["silk pajamas", false, false],
    ["grey lounge shorts and a fitted tee", true, true],
  ])("ordinary, on the owner's model: «%s»", (text, showsLegs, pinOnly) => {
    const outfit = outfitNamed(text);
    expect(outfit).toEqual({ text, ...(showsLegs ? { showsLegs: true } : {}), ...(pinOnly ? { pinOnly: true } : {}) });
  });

  test.each<[string, string]>([
    ["a satin slip nightdress", SATIN_DRESS],
    ["a satin midi nightdress", SATIN_DRESS],
    ["a satin cami and sleep shorts", "Her cami and shorts are opaque satin."],
    ["a short tied satin robe", "Her robe is tied and closed over her chest."],
  ])("flirty, on Seedream (Grok refused satin 2/2): «%s»", (text, coverage) => {
    expect(outfitNamed(text)).toEqual({ text, showsLegs: true, level: "flirty", route: "seedream", coverage });
  });

  test.each<[string, string, boolean]>([
    ["a black lace bra and panties", LACE, false],
    ["a white lace bra and panties", LACE, false],
    ["a lace bodysuit", "Her bodysuit is lined and opaque over her chest and fully covers her hips.", false],
    ["a cropped tee and cotton panties", "Her tee covers her chest, and her panties fully cover her.", false],
    ["an open white shirt and panties", "The shirt's two edges fall over her chest and fully cover both breasts, leaving only a narrow gap of skin down the middle; her panties fully cover her.", false],
    ["a black bra and briefs", "Her bra fully covers her breasts and her briefs fully cover her.", true],
  ])("bold, on Seedream: «%s»", (text, coverage, pinOnly) => {
    expect(outfitNamed(text)).toEqual({ text, showsLegs: true, ...(pinOnly ? { pinOnly: true } : {}), level: "bold", route: "seedream", coverage });
  });

  test("pulling her jeans up over her panties pins a crop top and jeans, and the moment carries the coverage", () => {
    expect(outfitNamed("a crop top and jeans")).toEqual({ text: "a crop top and jeans", pinOnly: true, level: "bold", route: "seedream" });
    expect(momentNamed("pulls her jeans up over her panties")?.moment).toMatchObject({ outfits: ["a crop top and jeans"], coverage: "Her panties fully cover her bottom, and her crop top covers her chest." });
  });

  test("no other outfit is in the bank", () => {
    expect(NIGHTWEAR.outfits).toHaveLength(18);
  });

  test("every Seedream outfit names the «Смелая» vocabulary or is bold, and the cotton ones name none of it", () => {
    for (const outfit of NIGHTWEAR.outfits) expect({ text: outfit.text, seedream: outfit.route === "seedream" }).toEqual({ text: outfit.text, seedream: boldWordsIn(outfit.text).length > 0 || outfit.level === "bold" });
  });
});

describe("the legwear: socks and tights at ordinary and flirty, stockings on a bold slot (Q-A)", () => {
  test("the slots and their shares", () => {
    expect(NIGHTWEAR.legwear).toEqual({
      items: ["thigh-high socks", "sheer black tights"],
      share: 0.3,
      bold: { items: ["black thigh-high stockings", "sheer black stockings", "white lace-top stockings"], share: 0.5, route: "seedream" },
    });
  });
});
