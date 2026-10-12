import { describe, expect, test } from "bun:test";
import { boldWordsIn, lingerieWordsIn, stockingWordsIn, swimwearWordsIn, withoutBoldExemptLook } from "./boldRules";
import { BANKS, validateBanks } from "./index";
import { BANK_RULE, boldBankProblems, boldOnlyHereProblems, categoryBankProblems } from "./schema";
import type { BankPlace, CategoryBank, Moment, Outfit } from "./types";

// 5a.3 (S5.9b2, plan s5a3 §6.4): the two «Смелая» banks validate against a schema of their own, chosen by category; the five built-ins keep theirs, which refuses every
// «Смелая»-only field. A valid «Смелая» fixture passes; then one row per «Смелая» rule breaks exactly that rule and must be refused with it (each a negative control).
// The «Смелая» vocabulary (lingerie, swimwear, stockings, satin, the babydoll) lives in banks/boldRules.ts and appears in no other bank.

const LINGERIE_COVER = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";

const MOMENTS: readonly Moment[] = [
  { text: "stands by the window", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
  { text: "leans on the doorframe", motion: "she shifts her shoulder slowly", captures: ["mirror", "timer"], twoHanded: false, level: "flirty" },
  { text: "stands with one hand on her hip", motion: "she turns her hips a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "bold", route: "seedream" },
  {
    text: "pulls her jeans up over her panties",
    motion: "she tugs the waistband up slowly",
    captures: ["mirror-hidden"],
    twoHanded: false,
    angle: "three-quarter",
    mirrorBack: true,
    level: "bold",
    route: "seedream",
    outfits: ["a crop top and jeans"],
    coverage: "Her panties fully cover her bottom, and her crop top covers her chest.",
  },
];

const ROOM: BankPlace = {
  name: "her small bedroom",
  at: "in her small bedroom",
  times: ["evening", "night"],
  room: true,
  lamp: true,
  mirror: true,
  details: ["a bedside lamp", "a plain wall behind her"],
  moments: MOMENTS,
};

const OUTFITS: readonly Outfit[] = [
  { text: "cotton pajama shorts and a tee", showsLegs: true },
  { text: "a long cotton nightshirt", showsLegs: true },
  { text: "a satin cami and satin shorts", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her cami and shorts are opaque satin." },
  { text: "a black lace bra and panties", showsLegs: true, level: "bold", route: "seedream", coverage: LINGERIE_COVER },
  { text: "a white lace bra and panties", showsLegs: true, level: "bold", route: "seedream", coverage: LINGERIE_COVER },
  { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined and opaque over her chest and fully covers her hips." },
  { text: "a sheer babydoll over a lace set", showsLegs: true, level: "bold", route: "seedream", coverage: "Under her sheer babydoll, her lace bra and panties are lined and opaque and fully cover her." },
  { text: "a crop top and jeans", pinOnly: true, level: "bold", route: "seedream" },
];

const BOLD: CategoryBank = {
  bold: true,
  places: [ROOM],
  outfits: OUTFITS,
  legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream" } },
  captureDeck: ["mirror-hidden", "mirror", "timer"],
};

const plain: Moment = { text: "sits on the rug", motion: "she leans back a little", captures: ["timer"], twoHanded: false };
const withMoment = (moment: Moment): CategoryBank => ({ ...BOLD, places: [{ ...ROOM, moments: [...MOMENTS, moment] }] });
const withOutfits = (outfits: readonly Outfit[]): CategoryBank => ({ ...BOLD, outfits });
const replacing = (text: string, outfit: Outfit): CategoryBank => withOutfits(OUTFITS.map((o) => (o.text === text ? outfit : o)));

/** The legs moment of a fixture row: a look down her own legs, pinning four outfits across the levels. */
const LEGS: Moment = {
  text: "lies with her legs crossed",
  motion: "she crosses and uncrosses her ankles slowly",
  captures: ["pov-legs"],
  twoHanded: false,
  legs: { framing: "legs" },
  outfits: ["cotton pajama shorts and a tee", "a long cotton nightshirt", "a satin cami and satin shorts", "a satin midi nightdress"],
};
const MIDI: Outfit = { text: "a satin midi nightdress", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her nightdress is opaque satin." };
const withLegs = (legs: Moment): CategoryBank => ({ ...withMoment(legs), outfits: [...OUTFITS, MIDI] });

/** A swimwear outfit and a water moment that pins it (the positive control of the water rule). */
const BIKINI: Outfit = { text: "a black bikini", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her." };
const WADES: Moment = { text: "stands waist-deep, looking back", motion: "she turns her head a little further", captures: ["timer"], twoHanded: false, angle: "three-quarter", gaze: "own", water: true, level: "flirty", outfits: ["a black bikini"] };
const withWater = (moment: Moment, outfits: readonly Outfit[] = [...OUTFITS, BIKINI]): CategoryBank => ({ ...withMoment(moment), outfits });

/** The rule ids a bank breaks (each problem is `[rule] text`). */
const rulesOf = (problems: readonly string[]): string[] => [...new Set(problems.map((p) => /^\[([a-z-]+)\]/.exec(p)?.[1] ?? p))];

describe("the «Смелая» vocabulary (banks/boldRules.ts)", () => {
  test("names lingerie, swimwear, stockings, satin and the babydoll, by whole word", () => {
    expect(boldWordsIn("a black lace bra and panties")).toEqual(["bra", "panties"]);
    expect(boldWordsIn("a white string bikini")).toEqual(["bikini"]);
    expect(boldWordsIn("sheer black stockings")).toEqual(["stockings"]);
    expect(boldWordsIn("a satin cami and satin shorts")).toEqual(["satin", "satin"]);
    expect(boldWordsIn("a sheer babydoll over a lace set")).toEqual(["babydoll"]);
    expect(boldWordsIn("a one-piece swimsuit")).toEqual(["swimsuit"]);
    expect(boldWordsIn("a lace bodysuit")).toEqual(["bodysuit"]);
  });

  test("leaves the everyday words alone: a bracelet, a zebra, a briefcase, a bralette-free tee, sheer tights", () => {
    expect(boldWordsIn("a briefcase and a bracelet, a zebra print scarf, sheer black tights, thigh-high socks")).toEqual([]);
  });

  test("tells lingerie, swimwear and stockings apart", () => {
    expect(lingerieWordsIn("a black bra and briefs")).toEqual(["bra", "briefs"]);
    expect(lingerieWordsIn("a black bikini")).toEqual([]);
    expect(swimwearWordsIn("a bikini and a sarong")).toEqual(["bikini"]);
    expect(swimwearWordsIn("a satin cami")).toEqual([]);
    expect(stockingWordsIn("white lace-top stockings")).toEqual(["stockings"]);
  });

  test("the satin nightwear phrases are taken out for the soft look list, and only they: «satin» alone stays", () => {
    expect(withoutBoldExemptLook("a satin slip nightdress")).not.toMatch(/satin/);
    expect(withoutBoldExemptLook("a satin midi nightdress")).not.toMatch(/satin/);
    expect(withoutBoldExemptLook("a satin cami and satin shorts")).not.toMatch(/satin/);
    expect(withoutBoldExemptLook("a short tied satin robe")).not.toMatch(/satin/);
    expect(withoutBoldExemptLook("satin pajamas")).toMatch(/satin/);
    expect(withoutBoldExemptLook("a satin dress")).toMatch(/satin/);
  });
});

describe("a «Смелая» bank", () => {
  test("the fixture is valid (the rows below each break one rule of it)", () => {
    expect(boldBankProblems(BOLD)).toEqual([]);
  });

  test("a legs moment over the levels and a water moment in swimwear are valid too (the positive controls of bold-legs and water)", () => {
    expect(boldBankProblems(withLegs(LEGS))).toEqual([]);
    expect(boldBankProblems(withWater(WADES))).toEqual([]);
  });

  test("holds the babydoll garment name, which the youth rule refuses everywhere else (answer (b))", () => {
    expect(rulesOf(categoryBankProblems({ ...BANKS.home, outfits: [...BANKS.home.outfits, { text: "a sheer babydoll over a lace set" }] }, "home"))).toContain(BANK_RULE.youth);
    expect(boldBankProblems(BOLD)).toEqual([]);
  });

  const ROWS: Array<[string, CategoryBank, string]> = [
    // bold-route
    ["a lingerie outfit with no route", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", coverage: "Her bodysuit is lined and opaque over her chest and fully covers her hips." }), BANK_RULE.boldRoute],
    ["a satin outfit with no route", replacing("a satin cami and satin shorts", { text: "a satin cami and satin shorts", showsLegs: true, level: "flirty", coverage: "Her cami and shorts are opaque satin." }), BANK_RULE.boldRoute],
    ["a bold outfit with no «Смелая» word and no route", withOutfits([...OUTFITS, { text: "an open white shirt", showsLegs: true, level: "bold", coverage: "Her shirt covers her chest." }]), BANK_RULE.boldRoute],
    ["a route on an ordinary cotton outfit", replacing("a long cotton nightshirt", { text: "a long cotton nightshirt", showsLegs: true, route: "seedream", coverage: "Her nightshirt covers her." }), BANK_RULE.boldRoute],
    ["a bold moment with no route", withMoment({ ...plain, level: "bold" }), BANK_RULE.boldRoute],
    ["a moment that names a «Смелая» garment with no route", withMoment({ ...plain, text: "sits on the rug in her panties", level: "bold" }), BANK_RULE.boldRoute],
    // bold-coverage
    ["a Seedream outfit with no coverage", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream" }), BANK_RULE.boldCoverage],
    ["a pin-only Seedream outfit pinned by a moment with no coverage", withMoment({ ...plain, text: "sits on the rug", level: "bold", route: "seedream", outfits: ["a crop top and jeans"] }), BANK_RULE.boldCoverage],
    ["a coverage sentence over 200 characters", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: `Her bodysuit is lined and opaque over her chest and fully covers her hips${", and it stays opaque".repeat(8)}.` }), BANK_RULE.boldCoverage],
    ["a coverage of two sentences", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined. It fully covers her hips." }), BANK_RULE.boldCoverage],
    ["a coverage with no closing period", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined and opaque" }), BANK_RULE.boldCoverage],
    ["a negated coverage (it names what must not show)", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is not see-through." }), BANK_RULE.boldCoverage],
    ["a coverage «without» a garment", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "She wears it without anything under it." }), BANK_RULE.boldCoverage],
    ["a coverage on an item that is not drawn on Seedream", replacing("a long cotton nightshirt", { text: "a long cotton nightshirt", showsLegs: true, coverage: "Her nightshirt covers her." }), BANK_RULE.boldCoverage],
    ["a coverage that is not plain ASCII", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined — and opaque." }), BANK_RULE.boldCoverage],
    // bold-levels
    ["fewer than four bold outfits", withOutfits(OUTFITS.filter((o) => o.text !== "a lace bodysuit" && o.text !== "a sheer babydoll over a lace set")), BANK_RULE.boldLevels],
    ["no ordinary outfit, so an ordinary slot has nothing to wear", withOutfits(OUTFITS.filter((o) => o.level !== undefined)), BANK_RULE.boldLevels],
    // bold-legs
    ["a legs moment that pins three outfits", withLegs({ ...LEGS, outfits: LEGS.outfits?.slice(0, 3) ?? [] }), BANK_RULE.boldLegs],
    ["a legs moment that pins no ordinary outfit (an ordinary legs slot has nothing to wear)", withLegs({ ...LEGS, outfits: ["a satin cami and satin shorts", "a satin midi nightdress", "a black lace bra and panties", "a white lace bra and panties"] }), BANK_RULE.boldLegs],
    ["a legs moment that pins lingerie (P-5a3 #6: refused; a bold legs slot is satin and stockings)", withLegs({ ...LEGS, outfits: [...(LEGS.outfits ?? []), "a black lace bra and panties"] }), BANK_RULE.boldLegs],
    ["a low-feet moment (no friend crouches at her feet in a «Смелая» bank)", withLegs({ ...LEGS, captures: ["pov-legs", "low-feet"] }), BANK_RULE.boldLegs],
    // water
    ["a water moment that pins no outfit", withWater({ ...WADES, outfits: undefined }), BANK_RULE.water],
    ["a water moment that pins an outfit that is not swimwear", withWater({ ...WADES, outfits: ["a black bikini", "a long cotton nightshirt"] }), BANK_RULE.water],
    ["a moment in the water without the water tag", withWater({ ...WADES, water: undefined }), BANK_RULE.water],
    ["a moment of feet in the water without the water tag", withMoment({ ...plain, text: "sits with her feet in the water" }), BANK_RULE.water],
    // legwear
    ["stockings among the ordinary legwear", { ...BOLD, legwear: { items: ["thigh-high socks", "sheer black stockings"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream" } } }, BANK_RULE.legwear],
    ["socks among the bold legwear (it holds the stockings)", { ...BOLD, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["white knee-high socks"], share: 0.5, route: "seedream" } } }, BANK_RULE.legwear],
    ["bold legwear on no slot", { ...BOLD, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0, route: "seedream" } } }, BANK_RULE.legwear],
    ["bold legwear with no item", { ...BOLD, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: [], share: 0.5, route: "seedream" } } }, BANK_RULE.legwear],
    ["stockings in an outfit (they are the bold legwear's only)", withOutfits([...OUTFITS, { text: "a slip and black stockings", showsLegs: true, level: "bold", route: "seedream", coverage: "Her slip is opaque." }]), BANK_RULE.legwear],
    // the shape
    ["a bank that is not marked «Смелая»", { ...BOLD, bold: undefined }, BANK_RULE.shape],
    ["a route other than Seedream", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "grok" as "seedream", coverage: "Her bodysuit is opaque." }), BANK_RULE.shape],
    ["a level past bold", withMoment({ ...plain, level: "explicit" as "bold", route: "seedream" }), BANK_RULE.shape],
    // the common rules hold here too
    ["a youth word in an outfit", withOutfits([...OUTFITS, { text: "a schoolgirl set", level: "bold", route: "seedream", coverage: "It covers her." }]), BANK_RULE.youth],
    ["«baby» next to the exempt garment", withOutfits([...OUTFITS, { text: "a baby blue babydoll", level: "bold", route: "seedream", coverage: "Her babydoll is opaque." }]), BANK_RULE.youth],
    ["denim shorts", withOutfits([...OUTFITS, { text: "a bra and denim shorts", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bra fully covers her breasts." }]), BANK_RULE.denim],
    ["a moment over the pool text bound", withMoment({ ...plain, text: "sits on the rug by the bed for a long while" }), BANK_RULE.text],
    ["a deck capture no ordinary moment takes", { ...BOLD, captureDeck: [...BOLD.captureDeck, "prone"] }, BANK_RULE.deckCoverage],
  ];

  test.each(ROWS)("refuses %s", (_name, bank, rule) => {
    expect(rulesOf(boldBankProblems(bank))).toContain(rule);
  });

  test("a malformed value is refused, never thrown", () => {
    expect(boldBankProblems(null).length).toBeGreaterThan(0);
    expect(boldBankProblems({ ...BOLD, places: "none" }).length).toBeGreaterThan(0);
  });
});

describe("the five built-ins keep their own schema, which refuses every «Смелая»-only field (negative controls)", () => {
  const home = BANKS.home;
  const firstPlace = home.places[0] as BankPlace;
  const withHomeMoment = (patch: Partial<Moment>): CategoryBank => ({ ...home, places: [{ ...firstPlace, moments: firstPlace.moments.map((m, i) => (i === 0 ? { ...m, ...patch } : m)) }, ...home.places.slice(1)] });
  const withHomeOutfit = (patch: Partial<Outfit>): CategoryBank => ({ ...home, outfits: home.outfits.map((o, i) => (i === 0 ? { ...o, ...patch } : o)) });

  test("the five pass their schema as they are", () => {
    for (const [category, bank] of Object.entries(BANKS)) if (bank.bold !== true) expect(categoryBankProblems(bank, category as "home"), category).toEqual([]);
  });

  test.each<[string, CategoryBank]>([
    ["a bold moment", withHomeMoment({ level: "bold" })],
    ["a moment's route", withHomeMoment({ route: "seedream" })],
    ["a moment's coverage", withHomeMoment({ coverage: "It covers her." })],
    ["a water moment", withHomeMoment({ water: true })],
    ["an outfit's level", withHomeOutfit({ level: "flirty" })],
    ["an outfit's route", withHomeOutfit({ route: "seedream" })],
    ["an outfit's coverage", withHomeOutfit({ coverage: "It covers her." })],
    ["the «Смелая» mark", { ...home, bold: true }],
    ["bold legwear", { ...home, legwear: { items: ["thigh-high socks"], share: 0.4, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream" } } }],
  ])("refuses %s", (_name, bank) => {
    expect(rulesOf(categoryBankProblems(bank, "home"))).toContain(BANK_RULE.shape);
  });
});

describe("bold-only-here: the «Смелая» vocabulary appears in no ordinary bank", () => {
  const home = BANKS.home;
  const firstPlace = home.places[0] as BankPlace;

  test("the five name none of it", () => {
    for (const [category, bank] of Object.entries(BANKS)) if (bank.bold !== true) expect(boldOnlyHereProblems(bank), category).toEqual([]);
  });

  test.each<[string, CategoryBank]>([
    ["a satin outfit", { ...home, outfits: [...home.outfits, { text: "a satin cami and satin shorts" }] }],
    ["a bikini in a moment", { ...home, places: [{ ...firstPlace, moments: [...firstPlace.moments, { text: "packs her bikini", motion: "she folds it slowly", captures: ["timer"], twoHanded: false }] }, ...home.places.slice(1)] }],
    ["stockings in a motion", { ...home, places: [{ ...firstPlace, moments: [...firstPlace.moments, { text: "sits on the rug", motion: "she smooths her stockings slowly", captures: ["timer"], twoHanded: false }] }, ...home.places.slice(1)] }],
    ["panties in a detail", { ...home, places: [{ ...firstPlace, details: ["a pair of panties on the chair", "a bedside lamp"] }, ...home.places.slice(1)] }],
    ["a babydoll among the legwear", { ...home, legwear: { items: ["a babydoll", "thigh-high socks"], share: 0.4 } }],
  ])("refuses %s in an ordinary bank", (_name, bank) => {
    expect(rulesOf(boldOnlyHereProblems(bank))).toEqual([BANK_RULE.boldOnlyHere]);
  });

  test("validateBanks holds the five to it", () => {
    expect(() => validateBanks({ banks: { ...BANKS, home: { ...home, outfits: [...home.outfits, { text: "a black bikini" }] } } })).toThrow(/home: \[bold-only-here\]/);
  });
});
