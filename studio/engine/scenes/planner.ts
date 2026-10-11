import { orderCategories, splitCount, type CategoryRef } from "../../shared/engine";
import { categoryRefOf, plannerCategoryOf } from "./categories";
import type { PlannerCategory, Shot } from "./types";
import type { Outfit } from "../../shared/scenes/banks/types";
import { captureOfShot, shotOf, type Capture } from "../../shared/scenes/captures";
import { legwearFits } from "../../shared/scenes/template";
import { fittingMoments, generalOutfits, kindOfDeck, outfitInfoOf, pinnedOutfitsOf, poseForCapture, settleFit } from "./fit";
import { allowedActivities, hasCleanActivity, POOLS, usableOutfits, type Place, type Pool } from "./pools";
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
  /** 5a.2: the moment the scene was (the history line's `activity`). Absent on a line written before it; such a line steers the outfit only. */
  activity?: string | undefined;
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
  // The owner's denim rule (S5.6b): a custom pool stored before it may hold denim shorts or skirts; they are never drawn.
  const outfits = usableOutfits(pool.outfits);
  const outfitBag = new Bag(outfits, rng);
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

  const maxOutfitAttempts = outfits.length - 1;
  return settledPlaces.map((place, i) => {
    const shot = shots[i] as Shot;
    let outfit = outfitBag.next();
    for (let attempt = 0; excluded.size > 0 && excluded.has(pairKey(place.name, outfit)) && attempt < maxOutfitAttempts; attempt++) {
      outfit = outfitBag.next();
    }
    const repeatedPair = excluded.size > 0 && excluded.has(pairKey(place.name, outfit));
    // settleHandShots has already moved every selfie/mirror shot onto a place
    // with a clean (one-handed, phone-free) activity, or turned it into a
    // friend shot, so allowedActivities is never empty here.
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

/** The streams a built-in category draws on, each step on its own (plan r1.5 §5.2). */
interface BuiltInStreams {
  /** The category's own stream (`categorySeed`): the deck's captures, the general outfits, the pinned picks and the time of day. */
  rng: Rng;
  poseRng: Rng;
  /** `fit:${category}`: the ties of the balance step (the least-used place and moment). */
  fitRng: Rng;
  /** `legwear:${category}`: whether a slot that may wear legwear does, and which. */
  legRng: Rng;
  /** `clean:${category}`: the fallback chain only; a built-in plan never reads it. */
  fixRng: Rng;
}

const momentKey = (location: string, activity: string): string => `${location}\u0000${activity}`;

/** The least-used of the items by `usage`, with the ties it broke on `rng`, among those `preferred` if any of the tied ones is. */
function leastUsed<T>(items: readonly T[], usage: (item: T) => number, preferred: (item: T) => boolean, rng: Rng): T {
  const fewest = Math.min(...items.map(usage));
  const tied = items.filter((item) => usage(item) === fewest);
  const soft = tied.filter(preferred);
  return rngPick(rng, soft.length > 0 ? soft : tied);
}

/**
 * Plans one built-in category's `n` slots (plan r1.5 §5.2). Per slot: the capture, from the category's deck (exact Bag cycles, I5.32); the pose; a place that has
 * a fitting moment, the least-used of them; the least-used fitting moment at that place; the outfit, the moment's pinned outfits first (after the owner's denim rule),
 * else the general bag, which leaves out the pin-only outfits and every outfit some moment pins; the legwear. The balance step is deterministic and is not the
 * fallback: with the banks' coverage rule every slot finds a place and a moment here, and `clean:` is never read. Recent (place, moment) pairs only break ties.
 */
function planBuiltIn(
  streams: BuiltInStreams,
  pool: Pool & { captureDeck: readonly Capture[] },
  category: PlannerCategory,
  n: number,
  startIndex: number,
  excluded: ReadonlySet<string>,
  recent: ReadonlySet<string>,
  poses: PoseAllowance,
): PlanSlot[] {
  const deck = new Bag(pool.captureDeck, streams.rng);
  const kind = kindOfDeck(pool.captureDeck);
  const info: readonly Outfit[] = outfitInfoOf(pool);
  const general = generalOutfits(pool);
  const outfitBag = new Bag(general, streams.rng);
  const placeUses = new Map<string, number>();
  const momentUses = new Map<string, number>();

  const slots: PlanSlot[] = [];
  for (let i = 0; i < n; i++) {
    const drawnCapture = deck.next();
    const drawnPose = poseForCapture(drawnCapture, drawPose(streams.poseRng, shotOf(drawnCapture), poses));
    const settled = settleFit(pool, kind, drawnCapture, drawnPose);
    const { capture, pose } = settled;
    const stepped = capture !== drawnCapture || pose !== drawnPose;
    const tieRng = stepped ? streams.fixRng : streams.fitRng;
    const hasFreshMoment = (place: Place): boolean => fittingMoments(place, capture, pose).some((m) => !recent.has(momentKey(place.name, m.text)));
    const place = leastUsed(settled.places, (p) => placeUses.get(p.name) ?? 0, hasFreshMoment, tieRng);
    const moment = leastUsed(fittingMoments(place, capture, pose), (m) => momentUses.get(momentKey(place.name, m.text)) ?? 0, (m) => !recent.has(momentKey(place.name, m.text)), tieRng);
    placeUses.set(place.name, (placeUses.get(place.name) ?? 0) + 1);
    momentUses.set(momentKey(place.name, moment.text), (momentUses.get(momentKey(place.name, moment.text)) ?? 0) + 1);

    const pinned = pinnedOutfitsOf(moment);
    let outfit: string;
    if (pinned.length > 0) {
      const fresh = pinned.filter((o) => !excluded.has(pairKey(place.name, o)));
      outfit = rngPick(streams.rng, fresh.length > 0 ? fresh : pinned);
    } else {
      outfit = outfitBag.next();
      for (let attempt = 0; excluded.size > 0 && excluded.has(pairKey(place.name, outfit)) && attempt < general.length - 1; attempt++) outfit = outfitBag.next();
    }
    const repeatedPair = excluded.size > 0 && excluded.has(pairKey(place.name, outfit));

    // The legwear slot: always two draws, so the stream does not depend on who may wear it.
    const roll = streams.legRng();
    const item = pool.legwear === undefined ? undefined : rngPick(streams.legRng, pool.legwear.items);
    const meta = info.find((o) => o.text === outfit);
    const legwear = pool.legwear !== undefined && meta !== undefined && legwearFits(moment, meta) && roll < pool.legwear.share ? item : undefined;

    const slotIndex = startIndex + i;
    slots.push({
      slotIndex,
      category,
      location: place.name,
      timeOfDay: rngPick(streams.rng, place.times),
      activity: moment.text,
      outfit,
      shot: shotOf(capture),
      pose,
      attemptIdBase: `slot-${slotIndex}`,
      repeatedPair,
      // I5.27: a capture is written only when it says more than the stored shot does.
      ...(capture === captureOfShot(shotOf(capture)) ? {} : { capture }),
      ...(legwear === undefined ? {} : { legwear }),
    });
  }
  return slots;
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
  // 5a.2: the moments the avatar used recently, by (place, moment); a history line written before it names none.
  const recent = new Set((input.excludePairs ?? []).flatMap((p) => (p.activity === undefined ? [] : [momentKey(p.location, p.activity)])));
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
    // A built-in pool carries its deck of captures and is drawn capture-first (planBuiltIn); a custom pool keeps the planner it always had.
    if (pool.captureDeck !== undefined) {
      const streams: BuiltInStreams = { rng, poseRng, fixRng, fitRng: makeRng(subSeed(seed, `fit:${category}`)), legRng: makeRng(subSeed(seed, `legwear:${category}`)) };
      slots.push(...planBuiltIn(streams, { ...pool, captureDeck: pool.captureDeck }, category, n, nextIndex, excluded, recent, poses));
    } else slots.push(...planCategory(rng, poseRng, fixRng, pool, category, n, nextIndex, excluded, poses));
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
