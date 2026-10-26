import { isCustomCategory, type SceneRoute } from "../engine";
import { BANKS } from "./banks";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "./banks/companions";
import { BANK_CATEGORIES, ORDINARY_BANK_CATEGORIES, type BankCategory, type BankPlace, type CategoryBank, type Moment, type OrdinaryBankCategory } from "./banks/types";

// 5a.4 (S5.BA3, plan s5a4 I5.73, §5.1.3, H1): the ONE lookup from a slot to bank data. «Смелая» is every category's (I5.71), and a frame is «Смелая» exactly when it carries the Seedream
// route (`isBoldFrame`), so the same category name now names two banks: the five plus the route read their companion, a custom category plus the route reads the two shared custom banks,
// and everything else reads the bank it always read. The template, the plain sentence, the room draw, the look, the hair tags, the clip's moment, the review redraw and the mock all
// come through here; none of them indexes `BANKS` or `POOLS` by category on its own. A slot stored before 5a.4 has no route on the five or a custom category, so it reads as before.

/** What the lookup reads of a slot. `route` is a REQUIRED key (M3): a caller that has no route to hand says `route: undefined`, and a caller that forgets it does not compile. */
export interface BankLookupSlot {
  category: string;
  route: SceneRoute | undefined;
  location?: string | undefined;
  activity?: string | undefined;
}

/** The bank a slot's place is in, the place, and (when the slot's activity is one of the place's moments by text) the moment. */
export interface BankHit {
  bank: CategoryBank;
  place: BankPlace;
  moment: Moment | undefined;
}

const bankCategoryOf = (category: string): BankCategory | undefined => BANK_CATEGORIES.find((c) => c === category);
const ordinaryBankOf = (category: BankCategory): category is OrdinaryBankCategory => ORDINARY_BANK_CATEGORIES.some((c) => c === category);

/**
 * The slot's bank place and moment: the five plus the route → the companion; a custom category plus the route → «rooms» or «by the water», by the place's name; any other slot of the
 * seven → its own bank. Undefined for an unrouted custom slot, an own scene, an unknown category, and a place the bank does not have (a renamed one). A routed slot never falls back to the
 * ordinary bank.
 */
export function bankPlaceOf(slot: BankLookupSlot): BankHit | undefined {
  if (slot.location === undefined) return undefined;
  const bank = bankOfSlot(slot);
  const place = bank?.places.find((p) => p.name === slot.location);
  if (bank === undefined || place === undefined) return undefined;
  return { bank, place, moment: place.moments.find((m) => m.text === slot.activity) };
}

/** The bank a slot is drawn from (see `bankPlaceOf`); a routed custom slot needs its place's name to tell the two custom banks apart. */
function bankOfSlot(slot: BankLookupSlot): CategoryBank | undefined {
  const category = bankCategoryOf(slot.category);
  if (category !== undefined) return slot.route === "seedream" && ordinaryBankOf(category) ? BOLD_COMPANIONS[category] : BANKS[category];
  if (isCustomCategory(slot.category) && slot.route === "seedream") return Object.values(CUSTOM_BOLD_BANKS).find((bank) => bank.places.some((p) => p.name === slot.location));
  return undefined;
}
