import { orderCategories, splitCount, type CategoryRef } from "../../shared/engine";
import { categoryRefOf, plannerCategoryOf } from "./categories";
import type { PlannerCategory, Shot } from "./types";
import { allowedActivities, hasCleanActivity, POOLS, type Place, type Pool } from "./pools";
import { drawFromPoses, drawPose, NO_EXTRA_POSES, type PoseAllowance } from "./poses";
import { Bag, makeRng, rngPick, subSeed, type Rng } from "./rngUtil";
import { isPhoneInHandShot, ScenePlanSchema, type PlanSlot, type Pose, type ScenePlan } from "./schema";

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
   *  contract's order (shared `orderCategories`): the five built-ins in the
   *  canonical product order (Home, Travel, Photoshoot, Glamour, Fitness),
   *  then custom categories (by id) in the order given. */
  categories: readonly PlannerCategory[];
  /** Pairs to avoid repeating (see ExcludedPair); defaults to none. */
  excludePairs?: readonly ExcludedPair[];
  /** Which poses beyond front/three-quarter this run allows (T5c, owner
   *  decision 2026-09-27); defaults to neither (every slot then draws only
   *  front/three-quarter). Front and three-quarter are always allowed and
   *  are never gated here; a selfie or mirror shot always draws one of them,
   *  whatever this says (poses.ts's drawPose). */
  poses?: PoseAllowance;
  /**
   * S4.5a, internal (a batch launch's compose): the exact number of scenes for each category instead of the even split. The counts add up to `count`, each
   * category once, every one of them among `categories`; a count of 0 is allowed. The slots keep the canonical category order whatever order this lists.
   */
  split?: readonly { ref: CategoryRef; count: number }[];
}

/** `split` checked against the request and put in the contract's category order. */
export function explicitSplit(split: readonly { ref: CategoryRef; count: number }[], categories: readonly CategoryRef[], count: number): { ref: CategoryRef; count: number }[] {
  const refs = split.map((entry) => entry.ref);
  if (new Set(refs).size !== refs.length) throw new RangeError("a split names each category once");
  const asked = new Set<CategoryRef>(categories);
  if (!refs.every((ref) => asked.has(ref))) throw new RangeError("a split names only categories the plan was asked for");
  if (!split.every((entry) => Number.isInteger(entry.count) && entry.count >= 0)) throw new RangeError("a split's counts are non-negative integers");
  if (split.reduce((sum, entry) => sum + entry.count, 0) !== count) throw new RangeError(`a split's counts must add up to ${count}`);
  const countOf = new Map(split.map((entry) => [entry.ref, entry.count] as const));
  return orderCategories(refs).map((ref) => ({ ref, count: countOf.get(ref) ?? 0 }));
}

function pairKey(location: string, outfit: string): string {
  return `${location}\u0000${outfit}`;
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
 *
 * Exported only for planner.test.ts's rng-isolation test (round 2 review,
 * MEDIUM): the plan-shape tests alone cannot tell `poseSeed` and
 * `categorySeed` apart if `poseSeed` were collapsed to just call
 * `categorySeed` — two separate `Rng` *instances* seeded identically still
 * don't interleave, so the plan would look unperturbed either way. This
 * export lets the test pin the actual seed derivation directly:
 * `poseSeed(seed, c) !== categorySeed(seed, c)`, for every category and a
 * spread of seeds.
 */
export function categorySeed(seed: number, category: PlannerCategory): number {
  return subSeed(seed, category);
}

/**
 * T5c: pose's own rng stream, per category — a different discriminator from
 * `categorySeed`'s (`"pose:<category>"`, not the bare category name), so
 * drawing poses never advances, and is never advanced by, the same
 * category's location/outfit/shot bags (planner.test.ts's isolation test
 * pins this: the same seed's location/outfit/shot draws are byte-identical
 * whether poses are drawn at all, and whatever the run's pose allowance is).
 * Exported for the same reason as `categorySeed` above.
 */
export function poseSeed(seed: number, category: PlannerCategory): number {
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
 * The shots and places of a category once no selfie or mirror sits where it has no clean activity (`hasCleanActivity`). Such a slot's place is drawn again from `fixRng` among
 * the places that have one (the mirror shot among the clean mirror places); a mirror with no clean mirror place becomes a selfie on a clean place; a pool with no clean place
 * turns the slot into a friend's snap, where her phone in use is fine. Nothing is drawn for a slot that needs no change, so a pool where every place is clean never touches `fixRng`.
 * Exported to pin its branches directly.
 */
export function settleHandShots(shots: readonly Shot[], places: readonly Place[], pool: Pool, fixRng: Rng): { shots: Shot[]; places: Place[] } {
  const clean = pool.locations.filter(hasCleanActivity);
  const cleanMirrors = clean.filter((place) => place.mirror === true);
  const outShots = [...shots];
  const outPlaces = [...places];
  for (let i = 0; i < outShots.length; i++) {
    const shot = outShots[i] as Shot;
    if (!isPhoneInHandShot(shot) || hasCleanActivity(outPlaces[i] as Place)) continue;
    if (shot === "mirror" && cleanMirrors.length > 0) outPlaces[i] = rngPick(fixRng, cleanMirrors);
    else if (clean.length > 0) {
      outShots[i] = "selfie";
      outPlaces[i] = rngPick(fixRng, clean);
    } else outShots[i] = "friend";
  }
  return { shots: outShots, places: outPlaces };
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
  fixRng: Rng,
  pool: Pool,
  category: PlannerCategory,
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
  const placedShots = placeMirrorShots(drawnShots, places);
  // CS.8a: a category whose description named its angles draws each slot's pose from them (the run's toggles are not asked), on the pose stream, and a back
  // or profile slot that drew a phone-in-hand shot takes another shot of the deck. Without `poses` this is the code path that always was: nothing is drawn here.
  const angled = pool.poses === undefined ? null : placedShots.map((shot) => drawFromPoses(poseRng, shot, pool.poses ?? [], pool.shotDeck));
  const angledShots = angled === null ? placedShots : angled.map((a) => a.shot);
  // S5.R1: a selfie or mirror is never placed where it has no clean activity (the writer is told her phone appears only when the activity uses it, and the reader refuses a phone in
  // a selfie sentence: a slot like that is asked again and, refused twice, fails the run). Its place is redrawn among the clean ones on its own stream, and a pool with none turns the
  // slot into a friend's snap. A built-in pool has a clean activity at every place, so nothing is drawn for it and its plans do not move.
  const { shots, places: settledPlaces } = settleHandShots(angledShots, places, pool, fixRng);

  const maxOutfitAttempts = pool.outfits.length - 1;
  return settledPlaces.map((place, i) => {
    const shot = shots[i] as Shot;
    let outfit = outfitBag.next();
    for (let attempt = 0; excluded.size > 0 && excluded.has(pairKey(place.name, outfit)) && attempt < maxOutfitAttempts; attempt++) {
      outfit = outfitBag.next();
    }
    const repeatedPair = excluded.size > 0 && excluded.has(pairKey(place.name, outfit));
    // pools.ts's schema guarantees at least one one-handed activity per
    // location, so allowedActivities is never empty even for a selfie/mirror shot.
    const slotIndex = startIndex + i;
    return {
      slotIndex,
      category,
      location: place.name,
      timeOfDay: rngPick(rng, place.times),
      activity: rngPick(rng, allowedActivities(place, shot)).text,
      outfit,
      shot,
      pose: angled === null ? drawPose(poseRng, shot, poses) : (angled[i] as { pose: Pose }).pose,
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
export function planWithPools(input: PlanInput, pools: Readonly<Record<string, Pool>>): ScenePlan {
  const { seed, count } = input;
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`count must be a non-negative integer, got ${count}`);
  // The order and the split are the contract's own (shared splitCount), the one rule the renderer's chips read too.
  const refs = input.categories.map(categoryRefOf);
  const split = input.split === undefined ? splitCount(count, refs) : explicitSplit(input.split, refs, count);
  if (count > 0 && split.length === 0) throw new RangeError("at least one category is required when count > 0");
  if (count === 0) return ScenePlanSchema.parse({ version: 1, seed, slots: [] });

  const excluded = new Set((input.excludePairs ?? []).map((p) => pairKey(p.location, p.outfit)));
  const poses = input.poses ?? NO_EXTRA_POSES;

  const slots: PlanSlot[] = [];
  let nextIndex = 1;
  for (const { ref, count: n } of split) {
    const category = plannerCategoryOf(ref);
    const pool = pools[category];
    if (pool === undefined) throw new RangeError(`no pool for category ${category}`);
    // A custom category's streams are keyed by its id (never a built-in's name), so every built-in's draws for a seed stay what they were.
    const rng = makeRng(categorySeed(seed, category));
    const poseRng = makeRng(poseSeed(seed, category));
    // The place redraws of S5.R1 have a stream of their own: a pool that needs none never reads it, and no other stream shifts.
    const fixRng = makeRng(subSeed(seed, `clean:${category}`));
    slots.push(...planCategory(rng, poseRng, fixRng, pool, category, n, nextIndex, excluded, poses));
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
