import { isCustomCategory, orderCategories, splitCount, type CategoryRef, type LegsShare, type SceneLevel } from "../../shared/engine";
import { categoryRefOf, plannerCategoryOf } from "./categories";
import { ORDINARY_BUILT_INS, type PlannerCategory, type Shot } from "./types";
import type { Level, Outfit } from "../../shared/scenes/banks/types";
import { captureOfShot, faceVisibleOf, shotOf, type Capture } from "../../shared/scenes/captures";
import { isWaterPlaceName } from "../../shared/scenes/custom";
import { apportionLegs, atSlotLevel, drawLevelOf, flirtyCountOf, legsCountOf, levelCountsOf, seedreamRoute, spreadLevels, tierSpreadOf, type LevelCounts } from "../../shared/scenes/level";
import { legwearFits } from "../../shared/scenes/template";
import { fittingMoments, generalOutfits, kindOfDeck, legwearOfSlot, outfitInfoOf, pinnedAt, pinnedOutfitsOf, poseForCapture, settleFit } from "./fit";
import { hasLegs, legsCapturesAt, legsMomentsAt, legsOutfitsOf, legsPlacesOf } from "./legs";
import { allowedActivities, hasCleanActivity, POOLS, usableOutfits, type Activity, type Place, type Pool } from "./pools";
import { customBoldPools, poolAt, withoutImplied } from "./poolAt";
import { drawFromPoses, drawPose, NO_EXTRA_POSES } from "./poses";
import { Bag, makeRng, rngPick, shuffle, subSeed, type Rng } from "./rngUtil";
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
  /**
   * «Подача» (S5.7b, I5.28): under "flirty", exactly round(0.6 × n) of each built-in category's n slots are flirty (which ones is drawn on `level:${category}`); absent or
   * "ordinary", none is. A custom category stays ordinary. "bold" (5a.3, S5.9a) draws the five ordinary built-ins exactly as "flirty" (`drawLevelOf`); only the «Смелая» banks (S5.9b2) draw more.
   */
  level?: SceneLevel;
  /**
   * «Ножки» (S5.8a, I5.29): the share of the run's built-in slots shot as legs and feet filling the frame, in percent. The legs slots are min(round-half-up(share × B), ⌊0.3 × count⌋),
   * B the built-in slots; they are shared over the built-in categories in proportion to their slots and drawn on `legs:${category}`. Absent or 0: no legs slot, and the plan is the one
   * it always was. A custom category draws none.
   */
  legsShare?: LegsShare;
  /**
   * S4.5a, internal (a batch launch's compose): the exact number of scenes for each category instead of the even split. The counts add up to `count`, each
   * category once, every one of them among `categories`; a count of 0 is allowed. The slots keep the canonical category order whatever order this lists.
   */
  split?: readonly { ref: CategoryRef; count: number }[];
  /**
   * 5a.4 (S5.BA3, plan s5a4 I5.74, M7): the origin input, default FALSE (fail-closed: an imported avatar, an unknown origin). True only for an avatar created in Studio: then an implied cover (the
   * sheet, the towel, the foam, the bare back) may be planned at «Смелая». The engine passes it through `planForAvatar`; golden builders that pin Studio-created behaviour pass `true`.
   */
  impliedNudity?: boolean | undefined;
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
      pose: angled === null ? drawPose(poseRng, shot, NO_EXTRA_POSES) : (angled[i] as { pose: Pose }).pose,
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
  /** `level:${category}`: which slots of the category are flirty. Never read under «Обычная». */
  levelRng: Rng;
  /** `angle:${category}`: the redraw of a slot that would be a category's excess away slot. Never read by a plan with no away moment to cap. */
  angleRng: Rng;
  /** `away:${category}`: whether a slot that could face away is one of the plan's wanted away slots. One draw per slot. */
  awayRng: Rng;
  /** `bold:${category}` (5a.3): which slots of a «Смелая» category are bold. Never read by a plan that is not «Смелая». */
  boldRng: Rng;
  /** `boldOutfit:${category}` (5a.3): a bold slot's outfit, from its pinned ones or its own bag. */
  boldOutfitRng: Rng;
  /** `boldLegwear:${category}` (5a.3): whether a bold slot wears stockings, and which. Two draws per bold slot, as `legRng` makes two per slot. */
  boldLegRng: Rng;
  /** `legs:${category}` (S5.8a): which slots are legs slots, then every draw of a legs slot (its place, moment, capture, outfit, time and legwear). Never read by a plan without legs. */
  legsRng: Rng;
  /**
   * The captures the category's ORDINARY plan deals, slot by slot (null for a legs slot): the plan under «Кокетливая» reads them to put its flirty slots on the frames that show her
   * face, and deals the very same captures, so «Кокетливая» changes the moments and never the captures (the deck rides on the category's own stream, and the moments it draws
   * past the first cycle move the real stream). Planned on fresh streams, once, only for a flirty plan.
   */
  ordinaryCaptures: () => readonly (Capture | null)[];
}

/** «Дом»'s timer frame turns away on this share of the rolls on `away:${category}`. */
const AWAY_ONE_IN_THREE = 1 / 3;

const isAwayAngle = (angle: Pose | undefined): boolean => angle === "profile" || angle === "back";

const momentKey = (location: string, activity: string): string => `${location}\u0000${activity}`;

/** A moment text as the run compares it: the text is all the photo prompt carries of a moment, so two categories' moments with the same text are one photo. */
const textKeyOf = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The least-used of the items by `usage`, with the ties it broke on `rng`. Among the tied ones each preference in turn narrows the choice to the items that meet it,
 * when any of them does (a preference is never ahead of the balance, and one nobody meets changes nothing).
 */
function leastUsed<T>(items: readonly T[], usage: (item: T) => number, preferences: readonly ((item: T) => boolean)[], rng: Rng): T {
  const fewest = Math.min(...items.map(usage));
  let candidates = items.filter((item) => usage(item) === fewest);
  for (const wanted of preferences) {
    const soft = candidates.filter(wanted);
    if (soft.length > 0) candidates = soft;
  }
  return rngPick(rng, candidates);
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
  level: Level,
  legsCount: number,
  claimed: ReadonlySet<string> = new Set(),
  tiers?: LevelCounts,
): PlanSlot[] {
  const deck = new Bag(pool.captureDeck, streams.rng);
  // Polish after C4 (round 2): the moment texts, normalised, that another category's slots already hold in this run. Only a «Смелая» category is given any; with none the plan is the one it always was.
  const keepFree = <T>(items: readonly T[], textOf: (item: T) => string): readonly T[] => {
    if (claimed.size === 0) return items;
    const free = items.filter((item) => !claimed.has(textKeyOf(textOf(item))));
    return free.length > 0 ? free : items;
  };
  const kind = kindOfDeck(pool.captureDeck);
  const info: readonly Outfit[] = outfitInfoOf(pool);
  const general = generalOutfits(pool);
  const levelOfOutfit = (text: string): Level | undefined => info.find((o) => o.text === text)?.level;
  // 5a.3: the general outfits a slot of each level draws from (never above its level, its own level preferred). A list is shuffled in a bag of its own on the stream the slot draws on;
  // the levels that read the same list share one bag, so a bank with no outfit level (the five) keeps its one bag and its plans do not move.
  const bagsOn = (rng: Rng, list: (level: Level) => readonly string[]): ((level: Level) => { bag: Bag<string>; size: number }) => {
    const bags = new Map<string, Bag<string>>();
    return (level) => {
      const items = list(level);
      const key = items.join("\u0000");
      let bag = bags.get(key);
      if (bag === undefined) {
        bag = new Bag(items, rng);
        bags.set(key, bag);
      }
      return { bag, size: items.length };
    };
  };
  const generalFor = (level: Level): readonly string[] => atSlotLevel(general, levelOfOutfit, level);
  const outfitBags = bagsOn(streams.rng, generalFor);
  const boldOutfitBags = bagsOn(streams.boldOutfitRng, generalFor);
  const placeUses = new Map<string, number>();
  const momentUses = new Map<string, number>();

  // «Ножки» (I5.29): which of the n slots are legs slots, on the category's `legs:` stream (never touched by a plan without legs). A legs slot is not dealt from the capture deck, so
  // the deck, the pose, the away and the legwear streams run over the other slots as if the legs slots were not there.
  const legsAt = new Set(legsCount === 0 ? [] : shuffle(streams.legsRng, Array.from({ length: n }, (_, i) => i)).slice(0, legsCount));
  const legsOutfitList = legsOutfitsOf(pool);
  const legsFor = (level: Level): readonly string[] => atSlotLevel(legsOutfitList, levelOfOutfit, level);
  const legsBags = bagsOn(streams.legsRng, legsFor);
  const boldLegsBags = bagsOn(streams.boldOutfitRng, legsFor);
  // The legs slots balance among themselves (S5.8a review): the places and moments the other slots used say nothing about which legs moment a legs slot has not shown yet, so a plan's
  // legs slots go round the legs moments instead of repeating one.
  const legsPlaceUses = new Map<string, number>();
  const legsMomentUses = new Map<string, number>();
  // S5.R4 (the whole-slice review): a «Смелая» run never pays twice for one scene. A slot whose place and moment already went with the outfit it drew takes another outfit it may
  // wear when there is one: among the moment's pins on the same single draw, or from the general bag by drawing on, as the history's excluded pairs do. Only a category drawn at
  // «Смелая» reads it (a «Смелая» bank under «Подача: Смелая», the only level it is planned at for a run): the five keep their draws exactly (their plans are frozen goldens), and so do
  // the ordinary plan a bold plan takes its captures from and the «Смелая» banks' plans at the lower levels the sweeps draw.
  const scenesOnce = level === "bold";
  const drawnScenes = new Set<string>();
  const sceneKey = (place: string, moment: string, outfit: string): string => `${place}\u0000${moment}\u0000${outfit}`;
  const unseenScenes = (place: string, moment: string, outfits: readonly string[]): readonly string[] => {
    if (!scenesOnce) return outfits;
    const unseen = outfits.filter((o) => !drawnScenes.has(sceneKey(place, moment, o)));
    return unseen.length > 0 ? unseen : outfits;
  };
  /** Whether the bag's draw is one to draw past: a pair the history excludes, or (a plan drawn at «Смелая») a scene the run already holds. */
  const drawPast = (place: string, moment: string, outfit: string): boolean =>
    (excluded.size > 0 && excluded.has(pairKey(place, outfit))) || (scenesOnce && drawnScenes.has(sceneKey(place, moment, outfit)));
  /** How many more bag draws a slot may make past one to avoid: the history's size − 1 as before; a plan drawn at «Смелая» draws until it has seen every outfit of the bag (any 2·size − 1 draws of a bag hold one whole shuffle). */
  const pastDraws = (size: number): number => (scenesOnce ? 2 * size - 2 : size - 1);
  // «Кокетливая» deals the very captures the ordinary plan deals (`ordinaryCaptures`), so the flirty slots are chosen by the frames before any moment is drawn.
  const dealt = level === "flirty" || level === "bold" ? streams.ordinaryCaptures() : null;
  const dealtAt = new Map<number, Capture>();
  dealt?.forEach((capture, i) => {
    if (capture !== null) dealtAt.set(i, capture);
  });

  // «Подача» (I5.28): exactly flirtyCountOf(n) of the n slots are flirty, drawn on the category's `level:` stream (never touched under «Обычная»). The flirty slots go to the frames
  // that show her face first (S5.8a, the S5.7R carry-over): a frame whose face is hidden (the phone over it, her legs) gets no flirty gaze, cue or moment, so it takes a flirty slot
  // only when the frames that show her face are not enough. Within each group the order is the stream's own shuffle.
  const flirtyAt = new Set<number>();
  const boldAt = new Set<number>();
  if (level === "flirty" || level === "bold") {
    const shows = (i: number): boolean => {
      const capture = dealtAt.get(i);
      return capture !== undefined && faceVisibleOf({ capture, pose: "front" }) === "yes";
    };
    // «Смелая» (5a.3, I5.36): the bold slots come first, drawn uniformly over the category on `bold:` (legs and face-hidden frames included); the flirty ones are then chosen from the rest as above.
    // 5a.4 (S5.BA3, r2.2 D1): a category planned as part of a request is given its share of the request's tiers (`tierSpreadOf`); without one it counts its own slots, which is what a request of
    // this category alone gets as well.
    const counts = level === "bold" ? (tiers ?? levelCountsOf(n)) : { bold: 0, flirty: flirtyCountOf(n, level), ordinary: 0 };
    if (level === "bold") for (const i of shuffle(streams.boldRng, Array.from({ length: n }, (_, k) => k)).slice(0, counts.bold)) boldAt.add(i);
    const order = shuffle(streams.levelRng, Array.from({ length: n }, (_, i) => i)).filter((i) => !boldAt.has(i));
    for (const i of [...order.filter(shows), ...order.filter((i) => !shows(i))].slice(0, counts.flirty)) flirtyAt.add(i);
  }

  // The angle comes from the scene (I5.26): at most ⌊n/5⌋ away (profile or back) slots in a built-in category.
  const awayCap = Math.floor(n / 5);
  let awayCount = 0;
  // The lower bound is the plan's own care, not the bank's luck (a category whose only non-hand capture is one slot in twelve could never reach 5 % by chance): the plan
  // WANTS ⌈n/10⌉ away slots (within the cap), and a slot whose capture can face away rolls on `away:${category}` whether it is one of them. The roll's odds rise as the
  // slots that could still be away run out, so the wanted ones land anywhere in the run and are met whenever the deck allows.
  const awayWanted = Math.min(Math.ceil(n / 10), awayCap);
  // The deck can face away at the boldest level the plan draws at.
  const awayLevel: Level = level === "bold" ? "bold" : "flirty";
  const canFaceAway = (capture: Capture): boolean => pool.locations.some((p) => fittingMoments(p, capture, "front", awayLevel).some((m) => isAwayAngle(m.angle)));
  const selfShot = kind === "self";
  const awayShareOfDeck = pool.captureDeck.filter(canFaceAway).length / pool.captureDeck.length;

  const slots: PlanSlot[] = [];
  for (let i = 0; i < n; i++) {
    const slotLevel: Level = boldAt.has(i) ? "bold" : flirtyAt.has(i) ? "flirty" : "ordinary";
    // A bold slot draws its outfit and its stockings on streams of its own (5a.3); every other slot on the category's, as it always did.
    const bold = slotLevel === "bold";
    const outfitRng = bold ? streams.boldOutfitRng : streams.rng;
    if (legsAt.has(i)) {
      // A legs slot: the least-used legs moment among the legs moments of the places that have one (a place with more of them is drawn more often, and a plan's legs slots go round them
      // before any repeats), its capture, then the outfit (the moment's pins first), the time and the legwear.
      const legsRng = streams.legsRng;
      const pairs = keepFree(
        legsPlacesOf(pool).flatMap((at) => legsMomentsAt(at).map((m) => ({ place: at, moment: m }))),
        (p) => p.moment.text,
      );
      const pair = leastUsed(pairs, (p) => legsMomentUses.get(momentKey(p.place.name, p.moment.text)) ?? 0, [(p) => !recent.has(momentKey(p.place.name, p.moment.text)), (p) => (legsPlaceUses.get(p.place.name) ?? 0) === Math.min(...pairs.map((q) => legsPlaceUses.get(q.place.name) ?? 0))], legsRng);
      const { place, moment } = pair;
      const capture = rngPick(legsRng, legsCapturesAt(place, moment));
      placeUses.set(place.name, (placeUses.get(place.name) ?? 0) + 1);
      momentUses.set(momentKey(place.name, moment.text), (momentUses.get(momentKey(place.name, moment.text)) ?? 0) + 1);
      legsPlaceUses.set(place.name, (legsPlaceUses.get(place.name) ?? 0) + 1);
      legsMomentUses.set(momentKey(place.name, moment.text), (legsMomentUses.get(momentKey(place.name, moment.text)) ?? 0) + 1);
      const pinnedAll = pinnedOutfitsOf(moment);
      let outfit: string;
      if (pinnedAll.length > 0) {
        const pinned = pinnedAt(pinnedAll, levelOfOutfit, slotLevel, moment.text);
        const unseen = pinned.filter((o) => !excluded.has(pairKey(place.name, o)));
        outfit = rngPick(bold ? streams.boldOutfitRng : legsRng, unseenScenes(place.name, moment.text, unseen.length > 0 ? unseen : pinned));
      } else {
        const { bag, size } = (bold ? boldLegsBags : legsBags)(slotLevel);
        outfit = bag.next();
        for (let attempt = 0; drawPast(place.name, moment.text, outfit) && attempt < pastDraws(size); attempt++) outfit = bag.next();
      }
      if (scenesOnce) drawnScenes.add(sceneKey(place.name, moment.text, outfit));
      const repeatedPair = excluded.size > 0 && excluded.has(pairKey(place.name, outfit));
      const wear = legwearOfSlot(pool.legwear, slotLevel, bold ? streams.boldLegRng : legsRng, moment, info.find((o) => o.text === outfit), outfit, "legs");
      const route = seedreamRoute(moment, info.find((o) => o.text === outfit), wear.stockings ? wear.route : undefined);
      const slotIndex = startIndex + i;
      slots.push({
        slotIndex,
        category,
        location: place.name,
        timeOfDay: rngPick(legsRng, place.times),
        activity: moment.text,
        outfit,
        shot: shotOf(capture),
        pose: moment.angle ?? "front",
        attemptIdBase: `slot-${slotIndex}`,
        repeatedPair,
        ...(capture === captureOfShot(shotOf(capture)) ? {} : { capture }),
        ...(wear.legwear === undefined ? {} : { legwear: wear.legwear }),
        framing: "legs" as const,
        ...(slotLevel === "ordinary" ? {} : { level: slotLevel }),
        ...(route === undefined ? {} : { route }),
      });
      continue;
    }
    // Under «Кокетливая» the capture is the ordinary plan's; the deck is still drawn, so every other draw of the stream goes on as it does in an ordinary plan.
    const burned = deck.next();
    const drawnCapture = dealtAt.get(i) ?? burned;
    const drawnPose = poseForCapture(drawnCapture, drawPose(streams.poseRng, shotOf(drawnCapture), NO_EXTRA_POSES));
    const settled = settleFit(pool, kind, drawnCapture, drawnPose, slotLevel);
    const { capture, pose } = settled;
    const stepped = capture !== drawnCapture || pose !== drawnPose;
    const tieRng = stepped ? streams.fixRng : streams.fitRng;
    // The slot's own level among equals (5a.3): a flirty slot goes where a flirty moment fits and takes one, a bold slot a bold one.
    const isOwnLevel = (m: Activity): boolean => m.level === slotLevel;
    // A flirty slot where her face shows never turns its back to the camera (a back view has no face for a flirty gaze or cue), unless the place has no other moment that fits.
    const fits = (at: Place): readonly Activity[] => {
      const all = fittingMoments(at, capture, pose, slotLevel);
      if (slotLevel === "ordinary") return all;
      const facing = all.filter((m) => m.angle !== "back");
      return facing.length > 0 ? facing : all;
    };
    const hasFreshMoment = (place: Place): boolean => fits(place).some((m) => !recent.has(momentKey(place.name, m.text)));
    // A flirty slot, among equals, goes where a flirty moment fits and takes one.
    const hasOwnLevelMoment = (place: Place): boolean => fits(place).some(isOwnLevel);
    const isAway = (m: Activity): boolean => isAwayAngle(m.angle);
    // A place whose moments of the kind are all held by another category's slots is a last resort (polish after C4, round 2).
    const isFree = (m: Activity): boolean => !claimed.has(textKeyOf(m.text));
    const placesWith = (wanted: (m: Activity) => boolean): readonly Place[] => {
      const all = settled.places.filter((p) => fits(p).some(wanted));
      if (claimed.size === 0) return all;
      const open = all.filter((p) => fits(p).some((m) => wanted(m) && isFree(m)));
      return open.length > 0 ? open : all;
    };
    const awayPlaces = placesWith(isAway);
    const awayRoll = streams.awayRng();
    const awayNeeded = awayWanted - awayCount;
    // «Дом» (a self-shot deck) has no lower bound: its one non-hand capture, the timer, turns away on one roll in three and every other timer frame faces the camera, so
    // the owner's rule stays a maximum and no timer moment is starved. The outside categories want ⌈n/10⌉ away slots.
    const wantsAway = selfShot
      ? awayCount < awayCap && awayPlaces.length > 0 && awayRoll < AWAY_ONE_IN_THREE
      : awayNeeded > 0 && awayPlaces.length > 0 && awayRoll < Math.min(1, awayNeeded / Math.max(awayShareOfDeck * (n - i), 1e-9));
    const placeUsage = (p: Place): number => placeUses.get(p.name) ?? 0;
    // A wanted away slot goes, among the least-used places, to one with an away moment; when none of them has one it goes to the least-used place that does.
    const hasAwayMoment = (p: Place): boolean => awayPlaces.includes(p);
    const placePreferences = [...(wantsAway ? [hasAwayMoment] : []), hasFreshMoment, ...(slotLevel !== "ordinary" ? [hasOwnLevelMoment] : [])];
    let place = leastUsed(claimed.size === 0 ? settled.places : placesWith(() => true), placeUsage, placePreferences, tieRng);
    if (wantsAway && !hasAwayMoment(place)) place = leastUsed(awayPlaces, placeUsage, [hasFreshMoment], tieRng);
    const momentPreferences = (at: Place): ((m: Activity) => boolean)[] => [(m) => !recent.has(momentKey(at.name, m.text)), ...(slotLevel !== "ordinary" ? [isOwnLevel] : [])];
    const momentsAt = (at: Place): readonly Activity[] => {
      const fitting = fits(at);
      if (wantsAway) return keepFree(fitting.filter(isAway), (m) => m.text);
      const facing = fitting.filter((m) => !isAway(m));
      return keepFree(selfShot && facing.length > 0 ? facing : fitting, (m) => m.text);
    };
    let moment = leastUsed(momentsAt(place), (m) => momentUses.get(momentKey(place.name, m.text)) ?? 0, momentPreferences(place), tieRng);
    if (isAwayAngle(moment.angle) && awayCount >= awayCap) {
      // The category already holds its ⌊n/5⌋ away slots: this one redraws among the non-away moments, at this place or (when it has none for the slot) another, on `angle:`.
      const nonAway = (m: Activity): boolean => !isAwayAngle(m.angle);
      const where = fits(place).some(nonAway) ? [place] : settled.places.filter((p) => fits(p).some(nonAway));
      if (where.length > 0) {
        place = leastUsed(where, (p) => placeUses.get(p.name) ?? 0, [], streams.angleRng);
        const at = place;
        moment = leastUsed(keepFree(fits(at).filter(nonAway), (m) => m.text), (m) => momentUses.get(momentKey(at.name, m.text)) ?? 0, momentPreferences(at), streams.angleRng);
      }
    }
    const finalPose: Pose = moment.angle ?? pose;
    if (isAwayAngle(finalPose)) awayCount++;
    placeUses.set(place.name, (placeUses.get(place.name) ?? 0) + 1);
    momentUses.set(momentKey(place.name, moment.text), (momentUses.get(momentKey(place.name, moment.text)) ?? 0) + 1);

    const pinnedAll = pinnedOutfitsOf(moment);
    let outfit: string;
    if (pinnedAll.length > 0) {
      const pinned = pinnedAt(pinnedAll, levelOfOutfit, slotLevel, moment.text);
      const fresh = pinned.filter((o) => !excluded.has(pairKey(place.name, o)));
      outfit = rngPick(outfitRng, unseenScenes(place.name, moment.text, fresh.length > 0 ? fresh : pinned));
    } else {
      const { bag, size } = (bold ? boldOutfitBags : outfitBags)(slotLevel);
      outfit = bag.next();
      for (let attempt = 0; drawPast(place.name, moment.text, outfit) && attempt < pastDraws(size); attempt++) outfit = bag.next();
    }
    if (scenesOnce) drawnScenes.add(sceneKey(place.name, moment.text, outfit));
    const repeatedPair = excluded.size > 0 && excluded.has(pairKey(place.name, outfit));

    // The legwear slot: always two draws, so the stream does not depend on who may wear it.
    const meta = info.find((o) => o.text === outfit);
    const wear = legwearOfSlot(pool.legwear, slotLevel, bold ? streams.boldLegRng : streams.legRng, moment, meta, outfit);
    const route = seedreamRoute(moment, meta, wear.stockings ? wear.route : undefined);

    const slotIndex = startIndex + i;
    slots.push({
      slotIndex,
      category,
      location: place.name,
      timeOfDay: rngPick(streams.rng, place.times),
      activity: moment.text,
      outfit,
      shot: shotOf(capture),
      pose: finalPose,
      attemptIdBase: `slot-${slotIndex}`,
      repeatedPair,
      // I5.27: a capture is written only when it says more than the stored shot does.
      ...(capture === captureOfShot(shotOf(capture)) ? {} : { capture }),
      ...(wear.legwear === undefined ? {} : { legwear: wear.legwear }),
      // I5.27: a level is written only when it differs from the default.
      ...(slotLevel === "ordinary" ? {} : { level: slotLevel }),
      // 5a.3 (I5.38): the Seedream route, exactly when the slot drew a Seedream item.
      ...(route === undefined ? {} : { route }),
    });
  }
  return slots;
}

/** The streams a built-in-style plan draws on, keyed by `key`: a built-in category's own name (so its draws are what they always were), or a custom category's branch (5a.4). */
function streamsOf(seed: number, key: string, replan: () => readonly (Capture | null)[]): BuiltInStreams {
  return {
    rng: makeRng(subSeed(seed, key)),
    poseRng: makeRng(subSeed(seed, `pose:${key}`)),
    fixRng: makeRng(subSeed(seed, `clean:${key}`)),
    fitRng: makeRng(subSeed(seed, `fit:${key}`)),
    legRng: makeRng(subSeed(seed, `legwear:${key}`)),
    boldRng: makeRng(subSeed(seed, `bold:${key}`)),
    boldOutfitRng: makeRng(subSeed(seed, `boldOutfit:${key}`)),
    boldLegRng: makeRng(subSeed(seed, `boldLegwear:${key}`)),
    levelRng: makeRng(subSeed(seed, `level:${key}`)),
    angleRng: makeRng(subSeed(seed, `angle:${key}`)),
    awayRng: makeRng(subSeed(seed, `away:${key}`)),
    legsRng: makeRng(subSeed(seed, `legs:${key}`)),
    ordinaryCaptures: replan,
  };
}

/** One pool's slots at a level, planned capture-first on streams keyed `key`; the ordinary plan the «Кокетливая» and «Смелая» slots take their captures from is planned on fresh streams. */
function planPool(opts: {
  seed: number;
  key: string;
  pool: Pool & { captureDeck: readonly Capture[] };
  category: PlannerCategory;
  n: number;
  startIndex: number;
  excluded: ReadonlySet<string>;
  recent: ReadonlySet<string>;
  level: Level;
  legs: number;
  claimed?: ReadonlySet<string>;
  tiers?: LevelCounts;
}): PlanSlot[] {
  const { seed, key, pool, category, n, startIndex, excluded, recent, level, legs } = opts;
  const streamsFor = (): BuiltInStreams =>
    streamsOf(seed, key, () => planBuiltIn(streamsFor(), pool, category, n, startIndex, excluded, recent, "ordinary", legs).map((slot) => (slot.framing === "legs" ? null : (slot.capture ?? captureOfShot(slot.shot)))));
  return planBuiltIn(streamsFor(), pool, category, n, startIndex, excluded, recent, level, legs, opts.claimed, opts.tiers);
}

/**
 * 5a.4 (S5.BA3, plan s5a4 §5.3, I5.71, I5.72, I5.78): a custom category's `n` slots at «Смелая». They are drawn from the two shared custom banks (the category's own «Ракурсы» and shot deck are
 * ignored, QB-4), and each carries a `world`, one of the category's stored pool places, which the bold writer sets the frame inside.
 * - The split. Of the n slots, w = ⌊(n × W + ⌊P/2⌋) / P⌋ draw «by the water» with a water world (W water places of P, found by their head noun), the rest «rooms» with any world; which positions are
 *   the water ones is drawn on `branch:${id}`.
 * - The tiers. The category's share of the request is split between the two branches the same way the request is split between categories (`spreadLevels`), ties on `tier-spread:${id}`.
 * - The world is drawn on `world:${id}`, a shuffle bag per kind of world, so the category's places go round before one repeats.
 * Each branch plans on streams of its own (`${id}:rooms`, `${id}:water`), so no built-in category's draws move.
 */
function planCustomBold(opts: {
  seed: number;
  category: PlannerCategory;
  stored: Pool;
  n: number;
  startIndex: number;
  excluded: ReadonlySet<string>;
  recent: ReadonlySet<string>;
  share: LevelCounts;
  impliedNudity: boolean;
}): PlanSlot[] {
  const { seed, category, stored, n, startIndex, excluded, recent, share } = opts;
  if (n === 0) return [];
  const banks = customBoldPools(opts.impliedNudity);
  const worlds = stored.locations.map((place) => place.name);
  const waterWorlds = worlds.filter(isWaterPlaceName);
  const wet = worlds.length === 0 ? 0 : Math.floor((n * waterWorlds.length + Math.floor(worlds.length / 2)) / worlds.length);
  const wetAt = new Set(shuffle(makeRng(subSeed(seed, `branch:${category}`)), Array.from({ length: n }, (_, i) => i)).slice(0, wet));
  const [roomsShare, waterShare] = spreadLevels(share, [n - wet, wet], () => shuffle(makeRng(subSeed(seed, `tier-spread:${category}`)), [0, 1])) as [LevelCounts, LevelCounts];
  const branch = (which: "rooms" | "water", count: number, tiers: LevelCounts): PlanSlot[] => {
    const pool = banks[which];
    if (count === 0 || pool.captureDeck === undefined) return [];
    return planPool({ seed, key: `${category}:${which}`, pool: { ...pool, captureDeck: pool.captureDeck }, category, n: count, startIndex, excluded, recent, level: "bold", legs: 0, tiers });
  };
  const rooms = branch("rooms", n - wet, roomsShare);
  const water = branch("water", wet, waterShare);
  const worldRng = makeRng(subSeed(seed, `world:${category}`));
  const anyWorld = new Bag(worlds, worldRng);
  const waterWorld = waterWorlds.length === 0 ? null : new Bag(waterWorlds, worldRng);
  let nextRoom = 0;
  let nextWater = 0;
  return Array.from({ length: n }, (_, i) => {
    const isWet = wetAt.has(i);
    const slot = (isWet ? water[nextWater++] : rooms[nextRoom++]) as PlanSlot;
    const slotIndex = startIndex + i;
    return { ...slot, slotIndex, attemptIdBase: `slot-${slotIndex}`, world: isWet && waterWorld !== null ? waterWorld.next() : anyWorld.next() };
  });
}

const isOrdinaryBuiltIn = (category: PlannerCategory): category is (typeof ORDINARY_BUILT_INS)[number] => ORDINARY_BUILT_INS.some((c) => c === category);

/**
 * `plan()`'s implementation, taking the pools as a parameter. 5a.4: at «Смелая» the five's companions come from the registry (`poolAt`), NOT from `pools`: the argument supplies the ordinary pools, the
 * nightwear and beach pools and the custom categories' own stored pools (the world source). Exported only
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
  // 5a.4 (S5.BA3, I5.71): «Смелая» is every category's. At that level the five are planned from their companions, a custom category from the shared custom banks, and nightwear and beach as
  // they always were; below it the five draw as the level says (`drawLevelOf`: «Обычная» or «Кокетливая») and a custom category plans as it always did.
  const atBold = input.level === "bold";
  const level = drawLevelOf(input.level);
  const impliedNudity = input.impliedNudity === true;
  const legsShare = input.legsShare ?? 0;
  /** The pool a built-in category plans from at this request's level and for this avatar's origin. */
  const poolOf = (category: PlannerCategory): Pool | undefined => {
    const stored = pools[category];
    if (!atBold || stored === undefined || isCustomCategory(category)) return stored;
    // The five at «Смелая» draw their companion; nightwear and beach their own pool. An imported avatar's pool holds no implied cover.
    return isOrdinaryBuiltIn(category) ? poolAt(category, "bold", impliedNudity) : impliedNudity ? stored : withoutImplied(stored);
  };

  // «Ножки» (I5.29): the legs slots of the run, shared over the built-in categories that can deal them in proportion to their slots. The categories whose remainders tie are served in
  // an order drawn on `legs` (the run's own stream, never a category's).
  const legsEligible = split.map(({ ref, count: n }) => {
    const pool = poolOf(plannerCategoryOf(ref));
    return pool !== undefined && hasLegs(pool) ? n : 0;
  });
  const legsParts =
    legsShare === 0
      ? split.map(() => 0)
      : apportionLegs(legsCountOf(legsShare, legsEligible.reduce((sum, n) => sum + n, 0), count), legsEligible, shuffle(makeRng(subSeed(seed, "legs")), split.map((_, i) => i)));

  // 5a.4 (S5.BA3, r2.2 D1): at «Смелая» the request's tiers are counted over the whole request and spread over its categories; the ties are broken on a `tier-spread` stream that a request of one
  // category never reads, so its plan is `levelCountsOf(n)` exactly.
  const shares = atBold ? tierSpreadOf(split, () => shuffle(makeRng(subSeed(seed, "tier-spread")), split.map((_, i) => i))) : null;

  // Polish after C4 (round 2): a «Смелая» category can yield the moment texts the categories planned before it hold in the run. Every category draws on streams of its own, so the order changes
  // no draw; the slots go back in the canonical order below.
  const firstIndexOf: number[] = [];
  split.reduce((next, { count: n }, entry) => ((firstIndexOf[entry] = next), next + n), 1);
  const slotsOf: PlanSlot[][] = split.map(() => []);
  for (const [entry, { ref, count: n }] of split.entries()) {
    const nextIndex = firstIndexOf[entry] as number;
    const category = plannerCategoryOf(ref);
    const pool = poolOf(category);
    if (pool === undefined) throw new RangeError(`no pool for category ${category}`);
    const share = shares?.[entry];
    // The texts the categories before this one already hold: at «Смелая» every category yields them.
    const claimed = new Set(atBold ? slotsOf.flatMap((held, other) => (other === entry ? [] : held.map((slot) => textKeyOf(slot.activity)))) : []);
    // A custom category's streams are keyed by its id (never a built-in's name), so every built-in's draws for a seed stay what they were.
    if (pool.captureDeck !== undefined) {
      // A built-in pool carries its deck of captures and is drawn capture-first (planBuiltIn); a custom pool keeps the planner it always had.
      const builtInPool = { ...pool, captureDeck: pool.captureDeck };
      // 5a.3 (S5.9c), 5a.4: under «Смелая» every built-in category draws the mix; below it every category draws as drawLevelOf says (the five as «Кокетливая»).
      const categoryLevel: Level = atBold ? "bold" : level;
      slotsOf[entry] = planPool({ seed, key: category, pool: builtInPool, category, n, startIndex: nextIndex, excluded, recent, level: categoryLevel, legs: legsParts[entry] ?? 0, claimed, ...(share === undefined ? {} : { tiers: share }) });
    } else if (atBold && share !== undefined) {
      // Two custom categories share the same banks, so they hold the same moment texts by design: none yields to another, and one category's pool never moves another's slots.
      slotsOf[entry] = planCustomBold({ seed, category, stored: pool, n, startIndex: nextIndex, excluded, recent, share, impliedNudity });
    } else {
      const rng = makeRng(categorySeed(seed, category));
      const poseRng = makeRng(poseSeed(seed, category));
      // The place redraws of S5.R1 have a stream of their own: a pool that needs none never reads it, and no other stream shifts.
      const fixRng = makeRng(subSeed(seed, `clean:${category}`));
      slotsOf[entry] = planCategory(rng, poseRng, fixRng, pool, category, n, nextIndex, excluded);
    }
  }
  const slots: PlanSlot[] = slotsOf.flat();
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

/**
 * 5a.4 (S5.BA3, plan s5a4 I5.74): the plan of one avatar. `impliedNudity` is a REQUIRED boolean here, so a caller that has not decided the avatar's origin does not compile; the planner's own
 * default (`plan`, `planWithPools`) is false.
 */
export function planForAvatar(input: PlanInput, pools: Readonly<Record<string, Pool>>, impliedNudity: boolean): ScenePlan {
  return planWithPools({ ...input, impliedNudity }, pools);
}
