import { CATEGORIES, type Category, type Shot } from "./types";
import { POOLS, type Place, type Pool } from "./pools";
import { drawPose, NO_EXTRA_POSES, type PoseAllowance } from "./poses";
import { Bag, makeRng, rngPick, type Rng } from "./rngUtil";
import { ScenePlanSchema, type PlanSlot, type ScenePlan } from "./schema";

// The seeded scene planner (T5a, item 2). Each category draws from its own
// rng sub-stream (see categorySeed below), so the same (seed, count,
// categories, excludePairs) always produces the same plan, a different seed
// produces a different one, and — critically — editing one category's pool
// can only ever change that category's own slots for a given seed; it can
// never perturb another category's draws (whole-slice review, "RNG fragility").

/** A (location, outfit) pair the avatar has recently used, in the shape of
 *  studio/engine/library/schemas.ts's HistoryEntry minus `at` — this module
 *  never imports the library (engine code here stays node:*-and-zod-only, and
 *  T5a is not wired to the library yet), but T6 can pass
 *  `Library.recentPairs(avatarId, n)`'s result here unchanged once it does. */
export interface ExcludedPair {
  location: string;
  outfit: string;
}

export interface PlanInput {
  /** The planner's own rng seed. Same seed, same inputs -> same plan. */
  seed: number;
  /** Total photo count for the run (product default: 20). */
  count: number;
  /** Which categories to draw from; de-duplicated and always emitted in the
   *  canonical product order (Home, Travel, Photoshoot, Glamour, Fitness)
   *  regardless of the order given here. */
  categories: readonly Category[];
  /** Pairs to avoid repeating (see ExcludedPair); defaults to none. */
  excludePairs?: readonly ExcludedPair[];
  /** Which poses beyond front/three-quarter this run allows (T5c, owner
   *  decision 2026-09-27); defaults to neither (every slot then draws only
   *  front/three-quarter). Front and three-quarter are always allowed and
   *  are never gated here; a selfie or mirror shot always draws one of them,
   *  whatever this says (poses.ts's drawPose). */
  poses?: PoseAllowance;
}

function pairKey(location: string, outfit: string): string {
  return `${location}\u0000${outfit}`;
}

/** `categories`, de-duplicated and reordered to the canonical CATEGORIES order. */
function orderedCategories(requested: readonly Category[]): Category[] {
  const wanted = new Set(requested);
  return CATEGORIES.filter((c) => wanted.has(c));
}

/**
 * Spreads `count` across `categories` as evenly as possible: every category
 * gets `floor(count / categories.length)`, and the categories earliest in the
 * (already-canonical) list get one extra each until the remainder is used up.
 */
function distribute(count: number, categories: readonly Category[]): Map<Category, number> {
  const base = Math.floor(count / categories.length);
  const remainder = count % categories.length;
  const perCategory = new Map<Category, number>();
  categories.forEach((category, i) => perCategory.set(category, base + (i < remainder ? 1 : 0)));
  return perCategory;
}

/** FNV-1a over a string, 32-bit unsigned. Used only to mix a category name
 *  into the plan's seed below — not a general-purpose hash. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic, independent rng seed from `seed` and a discriminator
 * string, run through a 32-bit avalanche mix (the murmur3/splitmix
 * finalizer) so nearby or related inputs do not produce nearby outputs. No
 * Math.random, no Date — pure function of (seed, discriminator), every time.
 * `categorySeed` and `poseSeed` below each call this with their own
 * discriminator, so their rng streams never collide or interleave.
 */
function subSeed(seed: number, discriminator: string): number {
  let h = (seed ^ fnv1a(discriminator)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A deterministic, independent rng seed per category (unchanged since T5a:
 * `subSeed(seed, category)`, so every existing plan's location/outfit/shot
 * draws for a given seed stay exactly what they were before pose existed).
 *
 * This is what gives each category its own rng stream (see the module
 * comment): `planCategory` for "travel" never advances "home"'s stream, so a
 * pool edit to one category can only change how many draws that category's
 * own bags need, never shift what any other category draws for the same seed.
 */
function categorySeed(seed: number, category: Category): number {
  return subSeed(seed, category);
}

/**
 * T5c: pose's own rng stream, per category — a different discriminator from
 * `categorySeed`'s (`"pose:<category>"`, not the bare category name), so
 * drawing poses never advances, and is never advanced by, the same
 * category's location/outfit/shot bags (planner.test.ts's isolation test
 * pins this: the same seed's location/outfit/shot draws are byte-identical
 * whether poses are drawn at all, and whatever the run's pose allowance is).
 */
function poseSeed(seed: number, category: Category): number {
  return subSeed(seed, `pose:${category}`);
}

/**
 * A mirror shot may only sit on a mirror location (spike "Planner rules").
 * Each misplaced mirror shot swaps with the first later slot that both sits
 * on a mirror location and does not already hold a mirror shot; with no such
 * slot left, it becomes a selfie instead. Pure and deterministic (no rng): it
 * only ever rearranges the shots it is given. Exported so the swap and
 * fallback branches can be pinned directly, without going through a full plan.
 */
export function placeMirrorShots(shots: Shot[], places: readonly { mirror?: true }[]): Shot[] {
  const out = [...shots];
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== "mirror" || places[i]?.mirror) continue;
    const j = out.findIndex((shot, k) => places[k]?.mirror && shot !== "mirror");
    if (j >= 0) [out[i], out[j]] = [out[j] as Shot, out[i] as Shot];
    else out[i] = "selfie";
  }
  return out;
}

/**
 * Plans one category's `n` slots, starting at global index `startIndex`, on
 * its own rng stream (`rng`, already seeded for this category alone — see
 * `categorySeed`). Draw order: locations and shots are each drawn from their
 * own bag (so a repeat only happens once every option has been used once),
 * mirror shots are then fixed up against the drawn locations, and only then
 * is each slot's outfit (its own bag), activity, time of day and pose picked
 * — the two-handed activity filter and the pose draw both need the slot's
 * *final* shot, after the mirror fixup. The pose draw (poses.ts's drawPose)
 * runs on its own rng stream (`poseRng`, seeded by `poseSeed`, never `rng`),
 * so it can never perturb this category's own location/outfit/shot draws.
 * `repeatedPair` is set only when `excludePairs` named this exact (location,
 * outfit) and every alternative outfit for that location was also excluded,
 * so the slot had to keep a pair the caller asked it to avoid.
 */
function planCategory(
  rng: Rng,
  poseRng: Rng,
  pool: Pool,
  category: Category,
  n: number,
  startIndex: number,
  excluded: ReadonlySet<string>,
  poses: PoseAllowance,
): PlanSlot[] {
  if (n === 0) return [];
  const locationBag = new Bag(pool.locations, rng);
  const outfitBag = new Bag(pool.outfits, rng);
  const shotBag = new Bag(pool.shotDeck, rng);

  const places: Place[] = Array.from({ length: n }, () => locationBag.next());
  const drawnShots: Shot[] = Array.from({ length: n }, () => shotBag.next());
  const shots = placeMirrorShots(drawnShots, places);

  const maxOutfitAttempts = pool.outfits.length - 1;
  return places.map((place, i) => {
    const shot = shots[i] as Shot;
    let outfit = outfitBag.next();
    for (let attempt = 0; excluded.size > 0 && excluded.has(pairKey(place.name, outfit)) && attempt < maxOutfitAttempts; attempt++) {
      outfit = outfitBag.next();
    }
    const repeatedPair = excluded.size > 0 && excluded.has(pairKey(place.name, outfit));
    // pools.ts's schema guarantees at least one one-handed activity per
    // location, so this is never empty even for a selfie/mirror shot.
    const phoneInHand = shot === "selfie" || shot === "mirror";
    const activities = place.activities.filter((a) => !(phoneInHand && a.twoHanded));
    const slotIndex = startIndex + i;
    return {
      slotIndex,
      category,
      location: place.name,
      timeOfDay: rngPick(rng, place.times),
      activity: rngPick(rng, activities).text,
      outfit,
      shot,
      pose: drawPose(poseRng, shot, poses),
      attemptIdBase: `slot-${slotIndex}`,
      repeatedPair,
    };
  });
}

/**
 * `plan()`'s implementation, taking the pools as a parameter. Exported only
 * for the isolation test that proves editing one category's pool cannot
 * perturb another category's slots (planner.test.ts) — production code
 * always calls `plan()`, which uses the real, validated `POOLS`.
 */
export function planWithPools(input: PlanInput, pools: Record<Category, Pool>): ScenePlan {
  const { seed, count } = input;
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`count must be a non-negative integer, got ${count}`);
  const categories = orderedCategories(input.categories);
  if (count > 0 && categories.length === 0) throw new RangeError("at least one category is required when count > 0");
  if (count === 0) return ScenePlanSchema.parse({ version: 1, seed, slots: [] });

  const perCategory = distribute(count, categories);
  const excluded = new Set((input.excludePairs ?? []).map((p) => pairKey(p.location, p.outfit)));
  const poses = input.poses ?? NO_EXTRA_POSES;

  const slots: PlanSlot[] = [];
  let nextIndex = 1;
  for (const category of categories) {
    const n = perCategory.get(category) ?? 0;
    const rng = makeRng(categorySeed(seed, category));
    const poseRng = makeRng(poseSeed(seed, category));
    slots.push(...planCategory(rng, poseRng, pools[category], category, n, nextIndex, excluded, poses));
    nextIndex += n;
  }
  return ScenePlanSchema.parse({ version: 1, seed, slots });
}

/**
 * Builds a deterministic, seeded plan for a photo run (T5a, item 2). Slots
 * are returned in the exact order T6's queue will send them: grouped by
 * category in the canonical product order, ascending `slotIndex` within and
 * across groups (invariant 6). Each slot carries a pre-allocated
 * `attemptIdBase`, unique within the plan and stable across re-plans with the
 * same seed (invariant 5). `excludePairs` steers the outfit draw away from
 * pairs the avatar has recently used, but never blocks planning: once every
 * outfit for a location is excluded, the slot keeps whatever the bag drew and
 * says so via `repeatedPair`. Each category draws from its own rng
 * sub-stream, so editing one category's pool never changes another
 * category's plans for the same seed.
 */
export function plan(input: PlanInput): ScenePlan {
  return planWithPools(input, POOLS);
}
