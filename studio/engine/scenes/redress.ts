import { isCustomCategory } from "../../shared/engine";
import { bankPlaceOf, builtInBankOf } from "../../shared/scenes/bankLookup";
import { BANK_CATEGORIES, type CategoryBank } from "../../shared/scenes/banks/types";
import { CUSTOM_BOLD_BANKS } from "../../shared/scenes/banks/companions";
import { captureOfShot } from "../../shared/scenes/captures";
import { isWaterPlaceName } from "../../shared/scenes/custom";
import { atSlotLevel } from "../../shared/scenes/level";
import { fittingMoments, fittingPlaces, generalOutfits, outfitInfoOf, pinnedOutfitsOf } from "./fit";
import { poolOfSlot } from "./poolAt";
import { makeRng, rngPick, subSeed } from "./rngUtil";
import type { PlanSlot } from "./schema";

// 2026-11-04 (the owner's answers after S5.BAR, «1 А» and «2 А»): what a run does with a STORED slot that today's rules would not draw. Two kinds:
// - an implied cover (the sheet, the towel, bath foam, a bare back) for an imported avatar, or one of unknown origin, even when the slot was stored before the origin rule (5a.3's
//   nightwear sheet, an older «Смелая» plan or set): with no sentence yet it is re-dressed (`redressSlot`); its stored sentence is skipped for free (runJob.ts);
// - a «rooms» slot on her balcony in a custom world at the water (`outdoorAtTheWater`): lingerie over the water, which the owner wants in swimwear; it is skipped for free.

/** The banks a stored slot's outfit may be found in when its place is gone: its built-in bank, or both shared custom banks for a routed custom slot. */
function banksOf(slot: Pick<PlanSlot, "category" | "route">): CategoryBank[] {
  const builtIn = BANK_CATEGORIES.find((c) => c === slot.category);
  if (builtIn !== undefined) return [builtInBankOf(builtIn, slot.route)];
  return isCustomCategory(slot.category) && slot.route === "seedream" ? [CUSTOM_BOLD_BANKS.rooms, CUSTOM_BOLD_BANKS.water] : [];
}

/**
 * Whether a stored slot is drawn under an implied cover, by its bank's data: its moment is an implied one, or its outfit is an implied cover of its bank (a moment reworded since, as
 * 5a.3's «lies holding the sheet to her chest» was, still wears «only the white bedsheet»). An unrouted custom slot and an own scene have no bank, and are no implied one.
 */
export function isImpliedSlot(slot: Pick<PlanSlot, "category" | "route" | "location" | "activity" | "outfit">): boolean {
  const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
  if (hit?.moment?.tier === "implied") return true;
  return banksOf(slot).some((bank) => bank.outfits.some((outfit) => outfit.text === slot.outfit && outfit.tier === "implied"));
}

/**
 * An implied slot re-dressed for an imported avatar, drawn on its own stream (`redress:${slotIndex}`): the same capture, pose (or the new moment's own angle), time, level, route and world,
 * in the slot's pool without its implied covers (`poolOfSlot` for an imported avatar). The place is the slot's own when it has a moment that fits the capture, the pose and the level once
 * the implied ones are gone; else a place of the same pool that has one (`fittingPlaces`: a mirror capture only on a mirror place). The moment is one of those (its own level among equals,
 * as a redraw takes), and the outfit one that moment may wear at the level (its pins, else the pool's general outfits). The same slot and seed give the same frame, so a resume draws it
 * again. A slot that is no implied one comes back as it is; null when there is no such frame (a place the pool no longer has, a legs framing, no fitting moment or outfit).
 */
export function redressSlot(slot: PlanSlot, seed: number): PlanSlot | null {
  if (!isImpliedSlot(slot)) return slot;
  if (slot.framing === "legs") return null;
  const pool = poolOfSlot(slot, false);
  const own = pool?.locations.find((l) => l.name === slot.location);
  if (pool === undefined || own === undefined) return null;
  const capture = slot.capture ?? captureOfShot(slot.shot);
  const level = slot.level ?? "ordinary";
  const rng = makeRng(subSeed(seed, `redress:${slot.slotIndex}`));
  const others = fittingPlaces(pool, capture, slot.pose, level);
  const place = fittingMoments(own, capture, slot.pose, level).length > 0 ? own : others.length > 0 ? rngPick(rng, others) : undefined;
  if (place === undefined) return null;
  const fitting = fittingMoments(place, capture, slot.pose, level);
  const ownLevel = fitting.filter((m) => (m.level ?? "ordinary") === level);
  const moment = rngPick(rng, ownLevel.length > 0 ? ownLevel : fitting);
  const info = outfitInfoOf(pool);
  const levelOf = (text: string) => info.find((o) => o.text === text)?.level;
  const pinned = pinnedOutfitsOf(moment);
  const wearable = atSlotLevel(pinned.length > 0 ? pinned : generalOutfits(pool), levelOf, level);
  if (wearable.length === 0) return null;
  const { legwear: _legwear, ...rest } = slot;
  return { ...rest, location: place.name, activity: moment.text, outfit: rngPick(rng, wearable), pose: moment.angle ?? slot.pose };
}

/**
 * Whether a stored sentence was written for this slot's moment: it says «she {moment}» word for word, in any case, as the template, the bold writer (its `moment-split` rule) and the plain
 * sentence write it. A run that re-dressed a slot and journaled its sentence reads it back on a resume by this; a sentence written for the implied moment never says the re-dressed one.
 */
export function saysMomentOf(sentence: string, slot: Pick<PlanSlot, "activity">): boolean {
  const moment = slot.activity.trim().replace(/[\s.,;:!]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])she ${moment}(?![\\p{L}\\p{N}])`, "iu").test(sentence);
}

/**
 * Whether a stored slot is a «rooms» frame (lingerie) at an outdoor place of hers, her balcony, in a custom world at the water: a slot stored before the owner's answer, which the
 * planner no longer draws (it draws «rooms» indoors only in such a world). Read by the slot's own world, the only world a run has (I5.78).
 */
export function outdoorAtTheWater(slot: Pick<PlanSlot, "category" | "route" | "location" | "world">): boolean {
  if (!isCustomCategory(slot.category) || slot.route !== "seedream" || slot.world === undefined) return false;
  const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location });
  return hit?.bank === CUSTOM_BOLD_BANKS.rooms && hit.place.room !== true && isWaterPlaceName(slot.world);
}
