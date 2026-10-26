import { isCustomCategory, type SceneLevel, type SceneRoute } from "../../shared/engine";
import { ORDINARY_BANK_CATEGORIES } from "../../shared/scenes/banks/types";
import { BOLD_POOLS, CUSTOM_BOLD_POOLS, POOLS, type Pool } from "./pools";
import { CATEGORIES, type Category } from "./types";

// 5a.4 (S5.BA3, plan s5a4 §5.1.2, I5.71, I5.73, I5.74): which pool a slot is planned or redrawn from. «Смелая» is every category's, and a frame is «Смелая» exactly when it carries the Seedream
// route, so the same category name names two pools: the five at «Смелая» their companion's, a custom category at «Смелая» the two shared custom pools (the world is the category's own stored
// pool, which the planner reads separately). This module and `bankPlaceOf` (shared/scenes/bankLookup.ts) are the only places that index `POOLS`, `BOLD_POOLS` or `CUSTOM_BOLD_POOLS` by category.

/** The pools already stripped of their implied covers, so a pool is stripped once and the same object comes back. */
const STRIPPED = new WeakMap<Pool, Pool>();

const hasImplied = (pool: Pool): boolean => (pool.outfitInfo ?? []).some((o) => o.tier === "implied") || pool.locations.some((l) => l.activities.some((a) => a.tier === "implied"));

/**
 * The pool an IMPORTED avatar (or one of unknown origin) draws from (I5.74): the pool without its implied covers, the sheet, the towel, the foam and the bare back, and without the moments
 * that wear them. A pool with none comes back as it is. Every place keeps its other moments (companion-size and `bold-levels` hold for the bank with and without them).
 */
export function withoutImplied(pool: Pool): Pool {
  if (!hasImplied(pool)) return pool;
  const known = STRIPPED.get(pool);
  if (known !== undefined) return known;
  const kept = (pool.outfitInfo ?? []).filter((o) => o.tier !== "implied");
  const stripped: Pool = {
    ...pool,
    locations: pool.locations.map((place) => ({ ...place, activities: place.activities.filter((a) => a.tier !== "implied") })),
    outfits: pool.outfitInfo === undefined ? pool.outfits : kept.map((o) => o.text),
    ...(pool.outfitInfo === undefined ? {} : { outfitInfo: kept }),
  };
  STRIPPED.set(pool, stripped);
  return stripped;
}

const isOrdinaryBankCategory = (category: string): category is (typeof ORDINARY_BANK_CATEGORIES)[number] => ORDINARY_BANK_CATEGORIES.some((c) => c === category);

/**
 * The pool a NEW slot of a built-in category is planned from at `level`: the five at «Смелая» their companion's, every other (category, level) today's pool. At «Смелая» an avatar that was not
 * created in Studio (`impliedNudity` false: the default) gets the pool without the implied covers; the lower levels draw no implied cover, so their pools are untouched.
 */
export function poolAt(category: Category, level: SceneLevel | undefined, impliedNudity: boolean): Pool {
  const pool = level === "bold" && isOrdinaryBankCategory(category) ? BOLD_POOLS[category] : POOLS[category];
  return level === "bold" && !impliedNudity ? withoutImplied(pool) : pool;
}

/** The two shared «Смелая» pools of the custom categories, for the avatar's origin. */
export function customBoldPools(impliedNudity: boolean): { rooms: Pool; water: Pool } {
  return impliedNudity ? CUSTOM_BOLD_POOLS : { rooms: withoutImplied(CUSTOM_BOLD_POOLS.rooms), water: withoutImplied(CUSTOM_BOLD_POOLS.water) };
}

/**
 * The pool a STORED slot belongs to: the five with the route their companion's; a custom category with the route the shared pool that has its place; any other built-in slot today's pool
 * (an old «Смелая» set of the five, drawn as «Кокетливая» with no route, redraws in the ordinary pool). Undefined for a custom slot without the route and for an own scene, whose pool is the
 * category's own stored one. An imported avatar's pool holds no implied covers.
 */
export function poolOfSlot(slot: { category: string; route: SceneRoute | undefined; location?: string | undefined }, impliedNudity: boolean): Pool | undefined {
  const pool = poolOfStored(slot);
  return pool === undefined || impliedNudity ? pool : withoutImplied(pool);
}

function poolOfStored(slot: { category: string; route: SceneRoute | undefined; location?: string | undefined }): Pool | undefined {
  const builtIn = CATEGORIES.find((c) => c === slot.category);
  if (builtIn !== undefined) return slot.route === "seedream" && isOrdinaryBankCategory(builtIn) ? BOLD_POOLS[builtIn] : POOLS[builtIn];
  if (isCustomCategory(slot.category) && slot.route === "seedream") return Object.values(CUSTOM_BOLD_POOLS).find((pool) => pool.locations.some((l) => l.name === slot.location));
  return undefined;
}
