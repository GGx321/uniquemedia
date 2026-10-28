import { isCustomCategory, type CategoryRef, type CategorySummary, type LegsShare, type SceneCategory } from "../../../shared/engine";
import { BANKS } from "../../../shared/scenes/banks";
import { lingerieWordsIn } from "../../../shared/scenes/banks/boldRules";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS, impliedItemsOf } from "../../../shared/scenes/banks/companions";
import type { CategoryBank } from "../../../shared/scenes/banks/types";
import { isWaterPlaceName } from "../../../shared/scenes/custom";

// 5a.4 (S5.BA8a, plan s5a4 §5.9 «Caption rules», r2.3 L3, r2.4 N1): the words the «Смелая» caption says of the chosen categories, from one per-category table. What she wears and which
// covers a frame may draw are READ from the «Смелая» banks (a bank edit visibly changes the caption; BA2's table test pins the data); the places are the table's own words, with «у воды» read
// from the bank's water places.

/** What she wears, in the caption's fixed order. */
export type ClothingWord = "underwear" | "satin" | "swim";
/** Where, in the caption's fixed order. */
export type PlaceWord = "home" | "room" | "balcony" | "water";
/** The covers a frame of a Studio-created avatar may draw, in the clause's fixed order. */
export type ImpliedWord = "sheet" | "towel" | "foam";

export interface CaptionWords {
  readonly clothing: readonly ClothingWord[];
  readonly places: readonly PlaceWord[];
  readonly implied: readonly ImpliedWord[];
}

const CLOTHING_ORDER: readonly ClothingWord[] = ["underwear", "satin", "swim"];
const PLACE_ORDER: readonly PlaceWord[] = ["home", "room", "balcony", "water"];
const IMPLIED_ORDER: readonly ImpliedWord[] = ["sheet", "towel", "foam"];

/** The bank each built-in category draws at «Смелая»: the five from their companion, the two «Смелая» categories from their own. */
const BANK_OF: Readonly<Record<SceneCategory, CategoryBank>> = {
  home: BOLD_COMPANIONS.home,
  travel: BOLD_COMPANIONS.travel,
  shoot: BOLD_COMPANIONS.photoshoot,
  glam: BOLD_COMPANIONS.glamour,
  fit: BOLD_COMPANIONS.fitness,
  nightwear: BANKS.nightwear,
  beach: BANKS.beach,
};

/**
 * The places each built-in category names, with the water read from its bank instead (below). «Пляж и бассейн» names none: its places are the water, which the clothing says («купальник
 * у воды»), so beside other categories it adds no place and alone it leaves «Места — …» out (r2.3 L2).
 */
const PLACES_OF: Readonly<Record<SceneCategory, readonly PlaceWord[]>> = {
  home: ["home"],
  travel: ["room", "balcony"],
  shoot: ["home", "room"],
  glam: ["home", "room"],
  fit: ["home"],
  nightwear: ["home"],
  beach: [],
};

/** A custom category's frames are in a room or at home, and at the water when one of its places is a water place. */
const CUSTOM_PLACES: readonly PlaceWord[] = ["home", "room"];

const isSatin = (text: string): boolean => /\bsatin\b/i.test(text);

/** What a bank says of itself, read from its data: the underwear and the satin of its general draw, the satin of its legs frames, and its water places. */
function wordsOfBank(bank: CategoryBank): { underwear: boolean; satin: boolean; satinOnLegs: boolean; water: boolean } {
  const general = bank.outfits.filter((outfit) => outfit.pinOnly !== true).map((outfit) => outfit.text);
  const moments = bank.places.flatMap((place) => place.moments);
  return {
    underwear: general.some((text) => lingerieWordsIn(text).length > 0),
    satin: general.some(isSatin),
    satinOnLegs: moments.some((moment) => moment.legs !== undefined && (moment.outfits ?? []).some(isSatin)),
    water: bank.places.some((place) => place.water === true),
  };
}

/** The words of the chosen `categories` at «Смелая»: the union over them, in the caption's fixed orders. `legs` is the run's «Ножки» share: it adds the satin that only legs frames wear. */
export function captionWordsOf(categories: readonly CategoryRef[], context: { legs: LegsShare; customs: readonly CategorySummary[] }): CaptionWords {
  const clothing = new Set<ClothingWord>();
  const places = new Set<PlaceWord>();
  const implied = new Set<ImpliedWord>();
  const take = (bank: CategoryBank, legs: boolean): void => {
    const words = wordsOfBank(bank);
    if (words.underwear) clothing.add("underwear");
    if (words.satin || (legs && words.satinOnLegs)) clothing.add("satin");
    if (words.water) clothing.add("swim");
    for (const item of impliedItemsOf(bank)) implied.add(item);
  };
  for (const ref of categories) {
    if (!isCustomCategory(ref)) {
      const bank = BANK_OF[ref];
      take(bank, context.legs !== 0);
      for (const place of PLACES_OF[ref]) places.add(place);
      if (ref !== "beach" && wordsOfBank(bank).water) places.add("water");
      continue;
    }
    const custom = context.customs.find((c) => c.categoryId === ref);
    if (custom === undefined) continue;
    take(CUSTOM_BOLD_BANKS.rooms, false);
    for (const place of CUSTOM_PLACES) places.add(place);
    if (custom.pool.locations.some((place) => isWaterPlaceName(place.name))) {
      take(CUSTOM_BOLD_BANKS.water, false);
      places.add("water");
    }
  }
  return {
    clothing: CLOTHING_ORDER.filter((word) => clothing.has(word)),
    places: PLACE_ORDER.filter((word) => places.has(word)),
    implied: IMPLIED_ORDER.filter((word) => implied.has(word)),
  };
}

/** «или» before the last of a list: «a», «a или b», «a, b или c». */
function listOf(items: readonly string[]): string {
  const last = items.at(-1);
  if (last === undefined) return "";
  return items.length === 1 ? last : `${items.slice(0, -1).join(", ")} или ${last}`;
}

const CLOTHING_TEXT: Readonly<Record<ClothingWord, string>> = { underwear: "белье", satin: "атласе", swim: "купальнике у воды" };
const PLACE_TEXT: Readonly<Record<PlaceWord, string>> = { home: "дома", room: "в номере", balcony: "на балконе", water: "у воды" };
const IMPLIED_TEXT: Readonly<Record<ImpliedWord, string>> = { sheet: "простыня", towel: "полотенце", foam: "пена" };

/** «в белье, атласе или купальнике у воды» (§5.9 rows 1, 19, 19a). */
export function clothingText(words: readonly ClothingWord[]): string {
  return `в ${listOf(words.map((word) => CLOTHING_TEXT[word]))}`;
}

/** «дома, в номере, на балконе, у воды»; null with no place to name (the caption leaves «Места — …» out). Joined by commas, as the plan's rows print them. */
export function placesText(words: readonly PlaceWord[]): string | null {
  return words.length === 0 ? null : words.map((word) => PLACE_TEXT[word]).join(", ");
}

/** r2.4 N1: «только полотенце» / «только простыня» / «только простыня или полотенце» / «только простыня, полотенце или пена»; null with no cover item. */
export function impliedText(items: readonly ImpliedWord[]): string | null {
  return items.length === 0 ? null : `только ${listOf(items.map((item) => IMPLIED_TEXT[item]))}`;
}

/**
 * Whether any of the chosen `categories` draws lingerie or an implied cover, from the bank data: what an imported avatar's line («без простыни, полотенца и пены; в промпте бельё плотное»)
 * has something to say about. A custom category always has its «rooms» bank, so it does; «Пляж и бассейн» alone does not (r2.3 L1, r2.4 N2).
 */
export function drawsLingerie(categories: readonly CategoryRef[]): boolean {
  return categories.some((ref) => {
    if (isCustomCategory(ref)) return true;
    const bank = BANK_OF[ref];
    return wordsOfBank(bank).underwear || impliedItemsOf(bank).length > 0;
  });
}
