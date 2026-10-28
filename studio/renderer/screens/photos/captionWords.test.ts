import { describe, expect, test } from "bun:test";
import type { CategoryRef, LegsShare } from "../../../shared/engine";
import { BED_POOL, category, PARIS_POOL } from "./categoryScreenKit";
import { BANKS } from "../../../shared/scenes/banks";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "../../../shared/scenes/banks/companions";
import type { CategoryBank } from "../../../shared/scenes/banks/types";
import { captionWordsOf, clothingText, drawsLingerie, impliedText, placesText, SHIPPED_CAPTION_BANKS } from "./captionWords";

// 5a.4 (S5.BA8a, plan s5a4 §5.9 «Caption rules», r2.3 L3, r2.4 N1): the card's and the autopilot's caption words follow the chosen categories, from one per-category table. The clothing words
// and the cover items are READ from the bank data (a bank edit visibly changes the caption); BA2's table test pins the data, these rows pin what the caption makes of it.

const PARIS = category(1, "Кофейни Парижа", PARIS_POOL);
const [firstPlace] = PARIS_POOL.locations;
if (firstPlace === undefined) throw new Error("the fixture pool has no place");
const POOL_BY_THE_WATER = category(2, "У бассейна", { ...PARIS_POOL, locations: [...PARIS_POOL.locations.slice(0, 5), { ...firstPlace, name: "hotel pool" }] });
const BED = category(3, "Постель", BED_POOL);

const wordsOf = (categories: readonly CategoryRef[], legs: LegsShare = 0, customs = [PARIS, POOL_BY_THE_WATER, BED]) => captionWordsOf(categories, { legs, customs });

describe("the clothing, the places and the cover items of one category (§5.9 table)", () => {
  test.each<[string, CategoryRef, LegsShare, ReturnType<typeof wordsOf>]>([
    ["«Дом»", "home", 0, { clothing: ["underwear", "satin"], places: ["home"], implied: ["sheet", "towel", "foam"] }],
    ["«Виды»", "travel", 0, { clothing: ["underwear", "satin", "swim"], places: ["room", "balcony", "water"], implied: ["sheet", "towel"] }],
    ["«Улица»", "shoot", 0, { clothing: ["underwear"], places: ["home", "room"], implied: ["towel"] }],
    ["«Улица» with «Ножки»: its legs frames wear satin", "shoot", 15, { clothing: ["underwear", "satin"], places: ["home", "room"], implied: ["towel"] }],
    ["«Гламур»", "glam", 0, { clothing: ["underwear", "satin"], places: ["home", "room"], implied: ["sheet", "towel"] }],
    ["«Фитнес»", "fit", 0, { clothing: ["underwear"], places: ["home"], implied: ["towel"] }],
    ["«Фитнес» with «Ножки»", "fit", 30, { clothing: ["underwear", "satin"], places: ["home"], implied: ["towel"] }],
    ["«Ночнушки и бельё»", "nightwear", 0, { clothing: ["underwear", "satin"], places: ["home"], implied: ["sheet"] }],
    ["«Пляж и бассейн»: swimwear at the water, no place words, no cover item", "beach", 0, { clothing: ["swim"], places: [], implied: [] }],
  ])("%s", (_name, ref, legs, words) => {
    expect(wordsOf([ref], legs)).toMatchObject(words);
  });

  test("a custom category: underwear, in a room or at home, with the sheet and the towel", () => {
    expect(wordsOf([PARIS.categoryId])).toMatchObject({ clothing: ["underwear"], places: ["home", "room"], implied: ["sheet", "towel"] });
  });

  test("a custom category with a water place adds the swimwear and «у воды» (the planner's isWaterPlaceName)", () => {
    expect(wordsOf([POOL_BY_THE_WATER.categoryId])).toMatchObject({ clothing: ["underwear", "swim"], places: ["home", "room", "water"], implied: ["sheet", "towel"] });
  });

  test("«Ножки» changes nothing for a custom category: it draws no legs frames", () => {
    expect(wordsOf([PARIS.categoryId], 30).clothing).toEqual(["underwear"]);
  });

  test("a custom category the library does not hold says nothing: the run would not ask for it", () => {
    expect(wordsOf(["cat-gone-for-good"])).toEqual({ clothing: [], places: [], implied: [] });
  });

  test("no category says nothing", () => {
    expect(wordsOf([])).toEqual({ clothing: [], places: [], implied: [] });
  });
});

describe("the words of several categories are the union, in a fixed order", () => {
  test("«Улица» + «Дом»: белье, атлас; дома, в номере; the three covers in the clause's order", () => {
    expect(wordsOf(["shoot", "home"])).toEqual({ clothing: ["underwear", "satin"], places: ["home", "room"], implied: ["sheet", "towel", "foam"] });
  });

  test("the order does not follow the order the categories were picked in", () => {
    expect(wordsOf(["beach", "travel", "home"])).toEqual(wordsOf(["home", "travel", "beach"]));
  });

  test("«Пляж и бассейн» beside «Дом» adds only the swimwear: its places stay out (it has none to name)", () => {
    expect(wordsOf(["home", "beach"])).toEqual({ clothing: ["underwear", "satin", "swim"], places: ["home"], implied: ["sheet", "towel", "foam"] });
  });

  test("«Улица» + «Ножки» says «атлас» because of «Улица» alone: «Дом» beside it already does", () => {
    expect(wordsOf(["shoot", "fit"], 15).clothing).toEqual(["underwear", "satin"]);
    expect(wordsOf(["shoot", "fit"], 0).clothing).toEqual(["underwear"]);
  });

  test("a custom category beside the five: only a built-in category draws legs frames, so «Ножки» reaches the built-ins' satin only", () => {
    expect(wordsOf(["fit", BED.categoryId], 15).clothing).toEqual(["underwear", "satin"]);
    expect(wordsOf(["fit", BED.categoryId], 0).clothing).toEqual(["underwear"]);
  });
});

describe("the words as Russian lists", () => {
  test.each<[string, Parameters<typeof clothingText>[0], string]>([
    ["one", ["underwear"], "в белье"],
    ["two", ["underwear", "satin"], "в белье или атласе"],
    ["three", ["underwear", "satin", "swim"], "в белье, атласе или купальнике у воды"],
    ["swimwear alone", ["swim"], "в купальнике у воды"],
    ["underwear and swimwear", ["underwear", "swim"], "в белье или купальнике у воды"],
  ])("clothing, %s", (_name, words, text) => {
    expect(clothingText(words)).toBe(text);
  });

  test.each<[Parameters<typeof placesText>[0], string]>([
    [["home"], "дома"],
    [["home", "room"], "дома, в номере"],
    [["room", "balcony", "water"], "в номере, на балконе, у воды"],
    [["home", "room", "balcony", "water"], "дома, в номере, на балконе, у воды"],
  ])("places %j", (words, text) => {
    expect(placesText(words)).toBe(text);
  });

  test("no place word is no text: the caption leaves «Места — …» out", () => {
    expect(placesText([])).toBe(null);
  });

  // r2.4 N1: the four forms the owner's clause takes, joined in a fixed order.
  test.each<[Parameters<typeof impliedText>[0], string]>([
    [["towel"], "только полотенце"],
    [["sheet"], "только простыня"],
    [["sheet", "towel"], "только простыня или полотенце"],
    [["sheet", "towel", "foam"], "только простыня, полотенце или пена"],
  ])("the cover clause for %j", (items, text) => {
    expect(impliedText(items)).toBe(text);
  });

  test("no cover item is no clause", () => {
    expect(impliedText([])).toBe(null);
  });
});

// r2.3 L1, r2.4 N2: an imported avatar's line («без простыни, полотенца и пены; в промпте бельё плотное») says something only when a chosen category can draw lingerie or an implied cover.
describe("drawsLingerie: whether a chosen category has lingerie or a cover to say anything about", () => {
  test.each<[string, readonly CategoryRef[], boolean]>([
    ["«Пляж и бассейн» alone", ["beach"], false],
    ["no category", [], false],
    ["«Дом»", ["home"], true],
    ["«Ночнушки и бельё»", ["nightwear"], true],
    ["«Фитнес»", ["fit"], true],
    ["a custom category the library holds", [PARIS.categoryId], true],
    ["a custom category the library does not hold (not loaded, or deleted)", ["cat-gone-for-good"], false],
    ["«Пляж и бассейн» beside «Улица»", ["beach", "shoot"], true],
    ["«Пляж и бассейн» beside a custom category", ["beach", PARIS.categoryId], true],
    ["«Пляж и бассейн» beside a custom category that is gone", ["beach", "cat-gone-for-good"], false],
  ])("%s", (_name, categories, expected) => {
    expect(drawsLingerie(categories, [PARIS, POOL_BY_THE_WATER, BED])).toBe(expected);
  });
});

// r2.3 M2 (plan s5a4 §8 BA8): the cover items are computed from the bank data, so a bank fixture without implied covers gives none, and a card of it names no cover and says nothing about an imported avatar.
describe("the cover items follow the bank given (not a table of the caption's own)", () => {
  const withoutImplied = (bank: CategoryBank): CategoryBank => ({
    ...bank,
    outfits: bank.outfits.filter((outfit) => outfit.tier !== "implied"),
    places: bank.places.map((place) => ({ ...place, moments: place.moments.filter((moment) => moment.tier !== "implied") })),
  });
  const bare = { ...SHIPPED_CAPTION_BANKS, builtIn: { ...SHIPPED_CAPTION_BANKS.builtIn, home: withoutImplied(BOLD_COMPANIONS.home) } };

  test("the shipped banks are the five companions, nightwear and beach, and the custom rooms and water banks", () => {
    expect(SHIPPED_CAPTION_BANKS.builtIn.home).toBe(BOLD_COMPANIONS.home);
    expect(SHIPPED_CAPTION_BANKS.builtIn.nightwear).toBe(BANKS.nightwear);
    expect(SHIPPED_CAPTION_BANKS.builtIn.beach).toBe(BANKS.beach);
    expect(SHIPPED_CAPTION_BANKS.rooms).toBe(CUSTOM_BOLD_BANKS.rooms);
    expect(SHIPPED_CAPTION_BANKS.water).toBe(CUSTOM_BOLD_BANKS.water);
  });

  test("a «Дом» bank without implied covers names none, and still dresses her in underwear", () => {
    expect(captionWordsOf(["home"], { legs: 0, customs: [], banks: bare })).toMatchObject({ implied: [], clothing: ["underwear", "satin"] });
  });

  test("the other categories keep the shipped banks' covers", () => {
    expect(captionWordsOf(["home", "fit"], { legs: 0, customs: [], banks: bare }).implied).toEqual(["towel"]);
  });

  test("the imported-avatar line has lingerie to speak of while a bank still dresses her in underwear", () => {
    expect(drawsLingerie(["home"], [], bare)).toBe(true);
  });

  test("a bank with neither underwear nor covers gives the imported line nothing to say", () => {
    const swimOnly: CategoryBank = { ...BANKS.beach };
    expect(drawsLingerie(["home"], [], { ...SHIPPED_CAPTION_BANKS, builtIn: { ...SHIPPED_CAPTION_BANKS.builtIn, home: swimOnly } })).toBe(false);
  });
});
