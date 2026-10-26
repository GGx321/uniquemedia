import { describe, expect, test } from "bun:test";
import { boldContentLevel } from "../../contentLine";
import { faceVisibleOf, posesFor, type Capture } from "../../captures";
import { motionTextFindings } from "../../motionText";
import { HELD_OBJECT_WORDS } from "../../words";
import { poseFamilyOf } from "../boldDesign.testkit";
import { openClassOf, tierOfGarment } from "../boldRules";
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
