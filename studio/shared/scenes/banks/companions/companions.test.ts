import { describe, expect, test } from "bun:test";
import { boldContentLevel } from "../../contentLine";
import { faceVisibleOf, isHandCapture, posesFor, type Capture } from "../../captures";
import { motionTextFindings } from "../../motionText";
import { HELD_OBJECT_WORDS } from "../../words";
import { poseFamilyOf } from "../boldDesign.testkit";
import { lingerieWordsIn, openClassOf, tierOfGarment } from "../boldRules";
import { BANKS } from "../index";
import { boldAnyProblems, type BoldAnyKind } from "../schema";
import { BANK_CATEGORIES, ORDINARY_BANK_CATEGORIES, type BankPlace, type CategoryBank, type Moment } from "../types";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS, impliedItemsOf, validateBoldBanks, type ImpliedItem } from "./index";

// 5a.4 (S5.BA2, plan s5a4 §5.2, §5.3.1, §8 BA2): the five companions and the two custom «Смелая» banks. They live in their own registry, never in BANKS, so every test and fixture
// that reads the seven stays as it was. Each is held to the 5a.3 and the 5a.4 rules at load; these rows pin what the probe decided and what the owner asked for (natural, private
// places; swimwear only at the water; the implied covers a Studio-created avatar's only).

type NewBank = { name: string; bank: CategoryBank; kind: BoldAnyKind };
const NEW_BANKS: readonly NewBank[] = [
  ...ORDINARY_BANK_CATEGORIES.map((category) => ({ name: category, bank: BOLD_COMPANIONS[category], kind: "companion" as const })),
  { name: "rooms", bank: CUSTOM_BOLD_BANKS.rooms, kind: "rooms" },
  { name: "water", bank: CUSTOM_BOLD_BANKS.water, kind: "water" },
];
const othersOf = (name: string): CategoryBank[] => [...BANK_CATEGORIES.map((c) => BANKS[c]), ...NEW_BANKS.filter((b) => b.name !== name).map((b) => b.bank)];
const momentsOf = (bank: CategoryBank): { place: BankPlace; moment: Moment }[] => bank.places.flatMap((place) => place.moments.map((moment) => ({ place, moment })));
const momentNamed = (bank: CategoryBank, text: string): { place: BankPlace; moment: Moment } | undefined => momentsOf(bank).find((m) => m.moment.text === text);

describe("the registry", () => {
  test("a companion for each of the five, and the two custom banks; none of them is in BANKS", () => {
    expect(Object.keys(BOLD_COMPANIONS)).toEqual([...ORDINARY_BANK_CATEGORIES]);
    expect(Object.keys(CUSTOM_BOLD_BANKS)).toEqual(["rooms", "water"]);
    const shipped = new Set<CategoryBank>(Object.values(BANKS));
    for (const { name, bank } of NEW_BANKS) expect({ name, shipped: shipped.has(bank), bold: bank.bold }).toEqual({ name, shipped: false, bold: true });
    expect(Object.keys(BANKS)).toEqual([...BANK_CATEGORIES]);
  });

  test("validateBoldBanks passes the shipped banks", () => {
    expect(() => validateBoldBanks()).not.toThrow();
  });

  test.each([...NEW_BANKS])("$name passes the 5a.3 and the 5a.4 rules", ({ name, bank, kind }) => {
    expect(boldAnyProblems(bank, kind, othersOf(name))).toEqual([]);
  });

  test("validateBoldBanks holds each bank to its kind, naming the bank and the rule", () => {
    const home = BOLD_COMPANIONS.home;
    const withSwimwear = { ...home, outfits: [...home.outfits, { text: "a black bikini", level: "flirty" as const, route: "seedream" as const, coverage: "Her bikini fully covers her." }] };
    expect(() => validateBoldBanks({ companions: { ...BOLD_COMPANIONS, home: withSwimwear } })).toThrow(/home: \[bold-floor\]/);
    const water = CUSTOM_BOLD_BANKS.water;
    const lingerie = { ...water, outfits: [...water.outfits, { text: "a black lace bra and panties", level: "flirty" as const, route: "seedream" as const, coverage: "The lace is lined." }] };
    expect(() => validateBoldBanks({ custom: { ...CUSTOM_BOLD_BANKS, water: lingerie } })).toThrow(/water: \[bold-floor\]/);
    // moment-unique reaches across the registries: a companion moment that is a shipped bank's.
    const nightwearMoment = BANKS.nightwear.places[0]?.moments[0];
    if (nightwearMoment === undefined) throw new Error("nightwear has no moment");
    const [first, ...rest] = home.places;
    if (first === undefined) throw new Error("the home companion has no place");
    const copying = { ...home, places: [{ ...first, moments: [...first.moments, { ...nightwearMoment, captures: ["timer" as const] }] }, ...rest] };
    expect(() => validateBoldBanks({ companions: { ...BOLD_COMPANIONS, home: copying } })).toThrow(/home: \[moment-unique\]/);
  });
});

describe("the re-read, per category (plan §5.2): private places only (I5.72)", () => {
  test.each<[string, CategoryBank, string[]]>([
    ["«Дом»: everyday home life", BOLD_COMPANIONS.home, ["her kitchen", "her sofa", "her bedroom", "her bed", "her bathroom"]],
    ["«Виды»: the view from somewhere private", BOLD_COMPANIONS.travel, ["the hotel balcony", "the hotel room window", "the hotel bed", "the villa terrace", "the villa's pool"]],
    ["«Улица»: before and after the walk", BOLD_COMPANIONS.photoshoot, ["her hallway", "her bedroom", "her hotel bed", "the hotel window at night"]],
    ["«Гламур»: getting ready, and the hotel room after the evening", BOLD_COMPANIONS.glamour, ["her vanity table", "her bedroom", "her hotel room after the evening", "the hotel bed the morning after"]],
    ["«Фитнес»: home after the workout", BOLD_COMPANIONS.fitness, ["her living room", "her bedroom", "her bathroom", "her bedroom floor", "her bed"]],
    // The five kinds the bold writer's place keys read (S5.BA4, r2.2 P8).
    ["custom «rooms»", CUSTOM_BOLD_BANKS.rooms, ["her room", "her bathroom", "her window", "her balcony", "her sofa"]],
    ["custom «by the water»", CUSTOM_BOLD_BANKS.water, ["a lounger by the water", "a sunny spot by the water", "in the water", "a railing over the water"]],
  ])("%s", (_name, bank, places) => {
    expect(bank.places.map((p) => p.name)).toEqual(places);
  });

  test("the only places that are not a room are her or the hotel's balcony, the villa's terrace and pool, and the custom water places", () => {
    const open = NEW_BANKS.flatMap(({ name, bank }) => bank.places.filter((p) => p.room !== true).map((p) => `${name}: ${p.at}`));
    expect(open).toEqual([
      "travel: on the balcony of her hotel room, over the rooftops",
      "travel: on the terrace of her villa, over the hills",
      "travel: by the pool of her villa",
      "rooms: on her balcony",
      "water: on a sun lounger by the water",
      "water: in a sunny spot at the edge",
      "water: in the water, waist-deep",
      "water: by a railing over the water",
    ]);
  });

  test("the water places are the villa's pool and every «by the water» place, and nothing else", () => {
    const wet = NEW_BANKS.flatMap(({ name, bank }) => bank.places.filter((p) => p.water === true).map((p) => `${name}: ${p.name}`));
    expect(wet).toEqual(["travel: the villa's pool", "water: a lounger by the water", "water: a sunny spot by the water", "water: in the water", "water: a railing over the water"]);
  });

  test("at a water place she wears swimwear and no legwear: no outfit a moment there can wear shows her legs", () => {
    for (const { bank } of NEW_BANKS) {
      const general = bank.outfits.filter((o) => o.pinOnly !== true).map((o) => o.text);
      for (const { place, moment } of momentsOf(bank).filter(({ place }) => place.water === true)) {
        for (const text of moment.outfits ?? general) expect({ place: place.name, text, legs: bank.outfits.find((o) => o.text === text)?.showsLegs }).toEqual({ place: place.name, text, legs: undefined });
      }
    }
  });
});

describe("who takes the photo (I5.32): she shoots herself at home; a friend never indoors", () => {
  test("a friend or a candid is dealt only by «Виды» (its terrace and pool) and «by the water»", () => {
    const asked = (bank: CategoryBank): boolean => bank.captureDeck.some((c) => c === "friend" || c === "candid");
    expect(NEW_BANKS.filter(({ bank }) => asked(bank)).map((b) => b.name)).toEqual(["travel", "water"]);
  });

  test("no moment of a room is a photo someone else took", () => {
    const indoors = NEW_BANKS.flatMap(({ name, bank }) =>
      momentsOf(bank)
        .filter(({ place, moment }) => place.room === true && moment.captures.some((c) => c === "friend" || c === "candid" || c === "low-feet"))
        .map(({ moment }) => `${name}: ${moment.text}`),
    );
    expect(indoors).toEqual([]);
  });

  test("each deck holds 6 to 12 cards", () => {
    for (const { name, bank } of NEW_BANKS) expect({ name, ok: bank.captureDeck.length >= 6 && bank.captureDeck.length <= 12 }).toEqual({ name, ok: true });
  });

  test("she lies on her stomach and looks back over her shoulder only on a bed, with no legwear (the owner: prone only on a bed)", () => {
    for (const { name, bank } of NEW_BANKS) {
      for (const { place, moment } of momentsOf(bank).filter(({ moment }) => moment.captures.some((c) => c === "prone" || c === "over-shoulder"))) {
        // A bed, her room or a hotel room (whose bed the prone capture line names).
        expect({ name, place: place.name, bed: /\bbed\b|\bhotel room\b/.test(`${place.name} ${place.at}`) || place.name === "her room", noLegwear: moment.noLegwear }).toEqual({ name, place: place.name, bed: true, noLegwear: true });
      }
    }
  });
});

describe("the outfits: the tier table, the floor, the coverage by origin (§5.1.1, §5.5)", () => {
  test("every outfit is in its tier by the tier table", () => {
    for (const { bank } of NEW_BANKS) for (const outfit of bank.outfits) expect({ text: outfit.text, level: outfit.level ?? "ordinary" }).toEqual({ text: outfit.text, level: tierOfGarment(outfit) ?? "none" });
  });

  test("each general draw holds at least 3 outfits of each tier, and at least 4 of the most revealing", () => {
    for (const { name, bank } of NEW_BANKS) {
      const general = bank.outfits.filter((o) => o.pinOnly !== true);
      const counts = { ordinary: 0, flirty: 0, bold: 0 };
      for (const o of general) counts[o.level ?? "ordinary"]++;
      expect({ name, ok: counts.ordinary >= 3 && counts.flirty >= 3 && counts.bold >= 4 }).toEqual({ name, ok: true });
    }
  });

  // Review M1: the classes P-BA drew without their kept coverage on a Studio-created avatar (B1 V1 S1 G1 F1 A1 A2 A3 G2 S2 C1 C3, and the cotton tops the controller reads as A1).
  // Such an outfit says no sentence to a Studio-created avatar; every other outfit (the satin) says its kept one to every avatar.
  const PROVEN: readonly (readonly [string, string | null])[] = [
    ["a tee and cotton panties", "A1"],
    ["a cotton bra and briefs", "A1"],
    ["a tank top and cotton briefs", "A1"],
    ["a cami and cotton panties", "A1"],
    ["a black bra and briefs", "A1"],
    ["a black bra and jeans", "S1"],
    ["a lace bra and jeans", "S1"],
    ["a sports bra and seamless briefs", "F1"],
    ["a sports bra and cotton panties", "F1"],
    ["a black lace bra and panties", "V1"],
    ["a white lace bra and panties", "V1"],
    ["a lace bralette and briefs", "V1"],
    ["a lace bodysuit", "G1"],
    ["a sheer babydoll over a lace set", "G2"],
    ["a white lace bra and a thong", "S2"],
    ["a black bra and a thong", "S2"],
    ["a sports bra and a thong", "F1"],
    ["an open white shirt and panties", "A3"],
    ["a one-piece swimsuit", "A2"],
    ["a black one-piece swimsuit", "A2"],
    ["a sporty bikini", "A2"],
    ["a black bikini", "A2"],
    ["a white bikini", "A2"],
    ["a bikini and a straw hat", "A2"],
    ["a white string bikini", "A2"],
    ["a red triangle bikini", "A2"],
    ["a strapless bandeau bikini", "A2"],
    ["a high-leg black swimsuit", "A2"],
    ["a satin cami and satin shorts", null],
    ["a satin slip nightdress", null],
    ["a satin midi nightdress", null],
    ["a short tied satin robe", null],
  ];

  test("the table names every outfit of the new banks but the implied covers", () => {
    const texts = [...new Set(NEW_BANKS.flatMap(({ bank }) => bank.outfits.filter((o) => o.tier !== "implied").map((o) => o.text)))].sort();
    expect(texts).toEqual(PROVEN.map(([text]) => text).filter((text) => texts.includes(text)).sort());
    for (const text of texts) expect(PROVEN.some(([t]) => t === text), text).toBe(true);
  });

  test.each(PROVEN.map(([text, probe]) => [text, probe] as const))("«%s»: class %p", (text, probe) => {
    if (probe === null) expect(openClassOf(text)).toBeNull();
    else expect(openClassOf(text)).toStartWith(probe);
  });

  test("every outfit but an implied cover keeps its kept coverage; only a proven class says no sentence, the rest say the kept one to every avatar", () => {
    for (const { name, bank } of NEW_BANKS) {
      for (const outfit of bank.outfits.filter((o) => o.tier !== "implied")) {
        const proven = PROVEN.find(([text]) => text === outfit.text)?.[1] ?? null;
        expect({ name, text: outfit.text, kept: outfit.coverage !== undefined, open: outfit.openCoverage }).toEqual({ name, text: outfit.text, kept: true, open: proven === null ? outfit.coverage : undefined });
      }
    }
  });

  test("an implied cover's moment says the towel's descriptive open sentence (P-BA B1), and the kept one for the sheet, the foam and the bare back (r2.2 P5)", () => {
    const TOWEL_OPEN = "The towel is wrapped around her, tucked in above her chest.";
    for (const { name, bank } of NEW_BANKS) {
      for (const { moment } of momentsOf(bank).filter(({ moment }) => moment.tier === "implied")) {
        const cover = moment.outfits?.[0] ?? "";
        const wrapped = cover === "only a white bath towel";
        expect({ name, cover, open: moment.openCoverage }).toEqual({ name, cover, open: wrapped ? TOWEL_OPEN : moment.coverage });
      }
    }
  });

  test.each<[string, CategoryBank, ImpliedItem[]]>([
    // r2.4 N1: what the card's cover clause names, from the bank data.
    ["«Дом»", BOLD_COMPANIONS.home, ["sheet", "towel", "foam"]],
    ["«Виды»", BOLD_COMPANIONS.travel, ["sheet", "towel"]],
    ["«Улица»", BOLD_COMPANIONS.photoshoot, ["towel"]],
    ["«Гламур»", BOLD_COMPANIONS.glamour, ["sheet", "towel"]],
    ["«Фитнес»", BOLD_COMPANIONS.fitness, ["towel"]],
    ["custom «rooms»", CUSTOM_BOLD_BANKS.rooms, ["sheet", "towel"]],
    ["custom «by the water»", CUSTOM_BOLD_BANKS.water, []],
    ["«Пляж и бассейн»", BANKS.beach, []],
  ])("the implied items of %s, in the clause's order", (_name, bank, items) => {
    expect(impliedItemsOf(bank)).toEqual(items);
  });

  test("impliedItemsOf reads the bank: a bank without implied covers has none", () => {
    const home = BOLD_COMPANIONS.home;
    const bare = { ...home, outfits: home.outfits.filter((o) => o.tier !== "implied"), places: home.places.map((p) => ({ ...p, moments: p.moments.filter((m) => m.tier !== "implied") })) };
    expect(impliedItemsOf(bare)).toEqual([]);
  });
});

// Review M2 (plan s5a4 §5.9, r2.3 L3, r2.4): the card's clothing words come from the bank data, so each bank's general draw and water places say what the caption table says:
// «белье» (lingerie or underwear in the general draw), «атлас» (satin in the general draw; on a legs frame only, «Ножки» > 0, for «Фитнес» and «Улица»), «купальник у воды»
// (a water place).
describe("the caption's words, from the bank data (§5.9)", () => {
  const satin = (text: string): boolean => /\bsatin\b/i.test(text);
  const generalOf = (bank: CategoryBank): string[] => bank.outfits.filter((o) => o.pinOnly !== true).map((o) => o.text);
  const wordsOf = (bank: CategoryBank) => ({
    underwear: generalOf(bank).some((t) => lingerieWordsIn(t).length > 0),
    satin: generalOf(bank).some(satin),
    satinOnLegs: momentsOf(bank).some(({ moment }) => moment.legs !== undefined && (moment.outfits ?? []).some(satin)),
    swimwearAtTheWater: bank.places.some((p) => p.water === true),
  });
  test.each<[string, CategoryBank, ReturnType<typeof wordsOf>]>([
    ["«Дом»: белье, атлас", BOLD_COMPANIONS.home, { underwear: true, satin: true, satinOnLegs: true, swimwearAtTheWater: false }],
    ["«Виды»: белье, атлас, купальник у воды", BOLD_COMPANIONS.travel, { underwear: true, satin: true, satinOnLegs: true, swimwearAtTheWater: true }],
    ["«Улица»: белье; атлас with «Ножки»", BOLD_COMPANIONS.photoshoot, { underwear: true, satin: false, satinOnLegs: true, swimwearAtTheWater: false }],
    ["«Гламур»: белье, атлас", BOLD_COMPANIONS.glamour, { underwear: true, satin: true, satinOnLegs: true, swimwearAtTheWater: false }],
    ["«Фитнес»: белье; атлас with «Ножки»", BOLD_COMPANIONS.fitness, { underwear: true, satin: false, satinOnLegs: true, swimwearAtTheWater: false }],
    ["custom «rooms»: белье", CUSTOM_BOLD_BANKS.rooms, { underwear: true, satin: false, satinOnLegs: false, swimwearAtTheWater: false }],
    ["custom «by the water»: купальник у воды", CUSTOM_BOLD_BANKS.water, { underwear: false, satin: false, satinOnLegs: false, swimwearAtTheWater: true }],
  ])("%s", (_name, bank, words) => {
    expect(wordsOf(bank)).toEqual(words);
  });

  test("«Фитнес» keeps three flirty outfits in its general draw without the satin: its lace", () => {
    expect(generalOf(BOLD_COMPANIONS.fitness).filter((t) => BOLD_COMPANIONS.fitness.outfits.find((o) => o.text === t)?.level === "flirty")).toEqual(["a black lace bra and panties", "a white lace bra and panties", "a lace bralette and briefs"]);
  });
});

// Review M3, M4: never lingerie where the frame reads as out in public.
describe("on the way out and by the pool (review M3, M4)", () => {
  test("«Улица»'s going-out moments in the hallway wear the bra and jeans, plain or lace: she is not on her way out in a thong or a bodysuit", () => {
    for (const text of ["checks her jeans before heading out", "stands by the door, ready to go", "sits on the bench, untying her boot"]) {
      expect({ text, outfits: momentNamed(BOLD_COMPANIONS.photoshoot, text)?.moment.outfits }).toEqual({ text, outfits: ["a black bra and jeans", "a lace bra and jeans"] });
    }
  });

  test("«Виды»: no lounger on the villa's terrace (Seedream draws a pool beside it); the lounger moments are the pool's, in swimwear", () => {
    const terrace = BOLD_COMPANIONS.travel.places.find((p) => p.name === "the villa terrace");
    expect(terrace?.moments.filter((m) => /\blounger\b/.test(m.text)).map((m) => m.text)).toEqual([]);
    for (const text of ["lies on a lounger, eyes closed", "sits on the edge of a lounger"]) {
      const found = momentNamed(BOLD_COMPANIONS.travel, text);
      expect({ text, place: found?.place.name, swimwear: (found?.moment.outfits ?? []).every((o) => /\b(?:bikini|swimsuit)\b/.test(o)) && (found?.moment.outfits ?? []).length > 0 }).toEqual({ text, place: "the villa's pool", swimwear: true });
    }
  });
});

describe("the probe's frames are in the banks (P-BA, the owner's eye fixes)", () => {
  test.each<[string, CategoryBank, string, string]>([
    ["B1 the towel after a shower", BOLD_COMPANIONS.home, "her bathroom", "stands by the sink after a shower"],
    ["B2 the bath foam", BOLD_COMPANIONS.home, "her bathroom", "lies back in the bath, hair up"],
    ["K1 the lace set in the bedroom mirror", BOLD_COMPANIONS.home, "her bedroom", "stands by the open wardrobe"],
    ["V1 lingerie on the hotel balcony", BOLD_COMPANIONS.travel, "the hotel balcony", "sits by the railing, legs crossed"],
    ["V2 the hotel sheet", BOLD_COMPANIONS.travel, "the hotel bed", "lies back on the big pillows"],
    ["S1 half-dressed in the hallway", BOLD_COMPANIONS.photoshoot, "her hallway", "checks her jeans before heading out"],
    ["S2 after the walk, prone", BOLD_COMPANIONS.photoshoot, "her hotel bed", "lies prone after a long walk"],
    ["G1 getting ready, reworded so one hand is free", BOLD_COMPANIONS.glamour, "her vanity table", "turns side-on, getting ready"],
    ["G2 after the evening", BOLD_COMPANIONS.glamour, "her hotel room after the evening", "sits on the bed, heels kicked off"],
    ["F1 the sports set in the mirror", BOLD_COMPANIONS.fitness, "her bedroom", "checks her progress after a workout"],
    ["F2 the bare back, prone on her bed", BOLD_COMPANIONS.fitness, "her bed", "lies prone, glancing at her feet"],
    ["L1 the sports set on a legs frame", BOLD_COMPANIONS.fitness, "her bed", "rests after a workout, legs crossed"],
    ["C1 her room in the world", CUSTOM_BOLD_BANKS.rooms, "her room", "lies back across the bed"],
    ["C2 the towel in her bathroom", CUSTOM_BOLD_BANKS.rooms, "her bathroom", "leans on the sink after a shower"],
    ["C3 her feet in the water", CUSTOM_BOLD_BANKS.water, "a sunny spot by the water", "sits with her feet in the water"],
  ])("%s", (_name, bank, place, text) => {
    expect(momentNamed(bank, text)?.place.name).toBe(place);
  });

  test("G1: at the vanity and every mirror of «Гламур», her other hand holds nothing (the probe drew the phone and the perfume)", () => {
    const busy = momentsOf(BOLD_COMPANIONS.glamour).filter(({ moment }) => moment.captures.some((c) => c === "mirror" || c === "mirror-hidden") && HELD_OBJECT_WORDS.test(moment.text));
    expect(busy.map(({ moment }) => moment.text)).toEqual([]);
    expect(momentsOf(BOLD_COMPANIONS.glamour).some(({ moment }) => /perfume/.test(moment.text))).toBe(false);
  });

  // Review L7 (G1 widened to every new bank): on a capture with her phone in one hand (a mirror, a selfie, from above, prone, over her shoulder, a look down her legs) one hand is
  // free: the moment holds no object and needs neither both hands nor both arms, in its text or its motion.
  test("one hand free wherever her phone is in the other: no held object, no two-handed action, in every new bank", () => {
    const HELD_THING = /\b(?:cups?|coffee|mugs?|glass(?:es)?|bottles?|keys|clutch|bags?|perfume|brush|hairbrush|towel|phone|grapes?|hangers?)\b/i;
    const BOTH = /\b(?:both|her)\s+(?:hands|arms)\b|\bfolded\s+arms\b|\barms\s+(?:folded|crossed|up|above|over|out)\b|\b(?:puts|pins|ties|twists|gathers)\s+her\s+hair\s+(?:up|back)\b|\bin\s+a\s+clip\b/i;
    const busy = NEW_BANKS.flatMap(({ name, bank }) =>
      momentsOf(bank)
        .filter(({ moment }) => moment.captures.some(isHandCapture))
        .filter(({ moment }) => HELD_THING.test(moment.text) || BOTH.test(moment.text) || BOTH.test(moment.motion))
        .map(({ moment }) => `${name}: ${moment.text} | ${moment.motion}`),
    );
    expect(busy).toEqual([]);
  });

  test("F2: her gaze stays her own, on her feet (the probe drew her looking at the camera)", () => {
    expect(momentNamed(BOLD_COMPANIONS.fitness, "lies prone, glancing at her feet")?.moment).toMatchObject({ gaze: "own", angle: "three-quarter", captures: ["over-shoulder"], tier: "implied" });
  });

  test("L1 drew, so plain underwear joins the satin on a legs frame; lace stays out", () => {
    for (const { name, bank } of NEW_BANKS) {
      for (const { moment } of momentsOf(bank).filter(({ moment }) => moment.legs !== undefined)) {
        for (const text of moment.outfits ?? []) expect({ name, text, lace: /\blace\b/.test(text) }).toEqual({ name, text, lace: false });
      }
    }
    expect(momentNamed(BOLD_COMPANIONS.fitness, "rests after a workout, legs crossed")?.moment.outfits).toContain("a sports bra and seamless briefs");
  });
});

describe("the legs moments («Ножки»): 4 to 7 a companion, each a pose of its own; none in the custom banks", () => {
  test.each(ORDINARY_BANK_CATEGORIES.map((c) => [c]))("%s", (category) => {
    const legs = momentsOf(BOLD_COMPANIONS[category]).filter(({ moment }) => moment.legs !== undefined);
    expect(legs.length >= 4 && legs.length <= 7).toBe(true);
    const families = legs.map(({ moment }) => poseFamilyOf(moment.text));
    expect(families.filter((f) => f === undefined)).toEqual([]);
    expect(new Set(families).size).toBe(families.length);
    for (const { moment } of legs) expect({ text: moment.text, captures: moment.captures.every((c) => c === "pov-legs" || c === "mirror-hidden") }).toEqual({ text: moment.text, captures: true });
  });

  // Review L8: a legs frame by the mirror after a shower read as her stepping out of it; she stands on the mat.
  test("«Дом»'s bathroom legs frame stands on the mat, her feet together", () => {
    expect(momentNamed(BOLD_COMPANIONS.home, "stands on the mat, feet together")?.moment).toMatchObject({ captures: ["mirror-hidden"], legs: { framing: "legs" } });
    expect(momentNamed(BOLD_COMPANIONS.home, "steps out of the shower")).toBeUndefined();
  });

  test("the custom banks hold no legs moment (legs-built-in-only)", () => {
    for (const bank of Object.values(CUSTOM_BOLD_BANKS)) expect(momentsOf(bank).filter(({ moment }) => moment.legs !== undefined || moment.captures.includes("pov-legs"))).toEqual([]);
  });
});

describe("the motions", () => {
  test.each<[string, CategoryBank, number]>([
    ["home", BOLD_COMPANIONS.home, 38],
    ["travel", BOLD_COMPANIONS.travel, 36],
    ["photoshoot", BOLD_COMPANIONS.photoshoot, 30],
    ["glamour", BOLD_COMPANIONS.glamour, 30],
    ["fitness", BOLD_COMPANIONS.fitness, 34],
    ["rooms", CUSTOM_BOLD_BANKS.rooms, 28],
    ["water", CUSTOM_BOLD_BANKS.water, 19],
  ])("%s holds %i motions, counted apart from the 271 of the seven", (_name, bank, count) => {
    expect(momentsOf(bank).length).toBe(count);
  });

  test("no two moments of a new bank say the same motion", () => {
    for (const { name, bank } of NEW_BANKS) {
      const motions = momentsOf(bank).map(({ moment }) => moment.motion);
      expect({ name, repeated: motions.filter((m, i) => motions.indexOf(m) !== i) }).toEqual({ name, repeated: [] });
    }
  });

  // The clip-time check as a «Как в сцене» clip meets it: on every capture the moment lists and every pose that capture can take (an unangled moment may land on a slot seen from
  // behind, whose face does not show), at the «Смелая» content line.
  test("every motion passes the clip-time check as `scene` on every frame its moment can be drawn on", () => {
    let frames = 0;
    for (const { name, bank } of NEW_BANKS) {
      for (const { moment } of momentsOf(bank)) {
        for (const capture of moment.captures) {
          for (const pose of posesFor(capture).filter((p) => moment.angle === undefined || moment.angle === p)) {
            const framing = moment.legs === undefined ? undefined : ("legs" as const);
            const frame = { capture, plannedCapture: capture as Capture, face: faceVisibleOf({ capture, pose, framing }), level: boldContentLevel(), bold: true, moment: { phone: moment.phone } };
            expect([name, moment.text, capture, pose, motionTextFindings(moment.motion, frame, "scene")]).toEqual([name, moment.text, capture, pose, []]);
            frames++;
          }
        }
      }
    }
    expect(frames).toBeGreaterThan(400);
  });
});
