import type { CategoryRef, PoolShot, SceneCategory, ScenePlace, ScenePose } from "../../shared/engine";
import { isCustomCategory } from "../../shared/engine";
import { builtInBankOf } from "../../shared/scenes/bankLookup";
import { CUSTOM_BOLD_BANKS, type CustomBoldBranch } from "../../shared/scenes/banks/companions";
import type { BankCategory, CategoryBank, Level } from "../../shared/scenes/banks/types";
import { captureOfShot, posesFor, shotOf, type Capture } from "../../shared/scenes/captures";
import { atSlotLevel } from "../../shared/scenes/level";
import { plainSentence } from "../../shared/scenes/plain";
import { GazeCueTally, momentAllowed, templateSentence, type TemplateSlot } from "../../shared/scenes/template";

// 5a.2 (S5.6e, plan s5a2 §5.7): the mock's side of the code template. A built-in scene is a PAIR of its category's bank (a place by name, a moment of that place,
// an outfit the bank allows) dealt a capture from the category's deck, so the shared template can write it, exactly as it writes the engine's. The mock keeps its
// own deterministic dealing (the engine's planner is not the mock's business; the parity suite compares counts, never picks), but every phrase is the bank's.

/** The planner's (and the banks') names for the contract's short built-in refs. */
export const BANK_OF: Readonly<Record<SceneCategory, BankCategory>> = { home: "home", travel: "travel", shoot: "photoshoot", glam: "glamour", fit: "fitness", nightwear: "nightwear", beach: "beach" };

/** What the mock draws for one built-in scene. */
export interface BankDraw {
  capture: Capture;
  pose: ScenePose;
  place: ScenePlace;
  /** «Ножки» (S5.8a): a legs scene. */
  framing?: "legs";
  /** 5a.3 (S5.9c): the scene is drawn on Seedream, exactly when its moment or its outfit is (the engine's planner adds the bold legwear, which the mock does not deal). */
  route?: "seedream";
}

/** What a redraw steers away from: the places and outfits the set already shows. */
export interface Avoid {
  locations: ReadonlySet<string>;
  outfits: ReadonlySet<string>;
}

/** How a draw treats the moments that face away (profile or back): a plan never takes one, prefers one for a wanted away scene, or (a redraw of a scene that already faces away) may keep one. */
export type AwayMode = "never" | "prefer" | "may";

const facesAway = (angle: ScenePose | undefined): boolean => angle === "profile" || angle === "back";

/**
 * 5a.4 (S5.BA7, plan s5a4 I5.73, I5.74): which bank a scene is drawn from, and for whom. `route` is the scene's marker: the five on the route draw their companion (`builtInBankOf`, the one
 * lookup the engine's `bankPlaceOf` reads too); without it the bank they always drew. `impliedNudity` is the avatar's origin (`impliedNudityOf`): false, the fail-closed default, draws no
 * implied cover (the sheet, the towel, the foam, the bare back), as the engine's `withoutImplied` pool does.
 */
export interface DrawFor {
  route?: "seedream" | undefined;
  impliedNudity?: boolean | undefined;
}

/** What a draw steers by: the scene's level, the places and outfits to avoid, the capture a redraw keeps, the place it leaves and how it treats a moment that faces away. */
export interface DrawOpts extends DrawFor {
  avoid?: Avoid;
  capture?: Capture;
  leaving?: string;
  level?: Level;
  away?: AwayMode;
}

/** The banks already stripped of their implied covers, so a bank is stripped once and the same object comes back. */
const STRIPPED = new WeakMap<CategoryBank, CategoryBank>();

/**
 * The bank an imported avatar (or one of unknown origin) draws from: without its implied covers and the moments that wear them (the engine's `withoutImplied`, engine/scenes/poolAt.ts). A
 * moment left with no outfit to wear leaves too. A bank with none comes back as it is, so the ordinary banks and beach are untouched.
 */
export function withoutImpliedCovers(bank: CategoryBank): CategoryBank {
  const implied = bank.outfits.some((o) => o.tier === "implied") || bank.places.some((p) => p.moments.some((m) => m.tier === "implied"));
  if (!implied) return bank;
  const known = STRIPPED.get(bank);
  if (known !== undefined) return known;
  const outfits = bank.outfits.filter((o) => o.tier !== "implied");
  const kept = new Set(outfits.map((o) => o.text));
  const stripped: CategoryBank = {
    ...bank,
    outfits,
    places: bank.places.map((place) => ({ ...place, moments: place.moments.filter((m) => m.tier !== "implied" && (m.outfits === undefined || m.outfits.some((text) => kept.has(text)))) })),
  };
  STRIPPED.set(bank, stripped);
  return stripped;
}

const forOrigin = (bank: CategoryBank, impliedNudity: boolean | undefined): CategoryBank => (impliedNudity === true ? bank : withoutImpliedCovers(bank));

/** The bank a built-in scene is drawn from, for the avatar's origin. */
function builtInBank(ref: SceneCategory, opts: DrawFor): CategoryBank {
  return forOrigin(builtInBankOf(BANK_OF[ref], opts.route), opts.impliedNudity);
}

/** The shared custom «Смелая» bank of a branch, for the avatar's origin. */
export function customBoldBank(branch: CustomBoldBranch, impliedNudity: boolean | undefined): CategoryBank {
  return forOrigin(branch === "rooms" ? CUSTOM_BOLD_BANKS.rooms : CUSTOM_BOLD_BANKS.water, impliedNudity);
}

/**
 * The k-th scene of a built-in category: its capture off the deck (or the one a redraw keeps), a (place, moment) pair that capture, level and the facing pose allow, an
 * outfit the moment wears. The pose is the moment's own `angle`, else facing the camera (the angle comes from the scene, S5.7b). A flirty scene prefers a flirty moment, as the
 * engine's planner does. Deterministic in `k`. A redraw passes `avoid`, `capture` and `leaving` (the place it is leaving) so the new scene is another place and another outfit
 * when the bank has one. 5a.4: the five on the route (`opts.route`) are drawn from their companion.
 */
export function bankDraw(ref: SceneCategory, k: number, opts: DrawOpts = {}): BankDraw {
  return drawIn(builtInBank(ref, opts), k, opts, ref);
}

/** 5a.4 (S5.BA7, plan s5a4 §5.3): the k-th scene of a custom category at «Смелая», from the shared bank of its branch («rooms» or «by the water»). The world is the caller's. */
export function customBoldDraw(branch: CustomBoldBranch, k: number, opts: DrawOpts = {}): BankDraw {
  return drawIn(customBoldBank(branch, opts.impliedNudity), k, opts, `the custom «${branch}» bank`);
}

function drawIn(bank: CategoryBank, k: number, opts: DrawOpts, what: string): BankDraw {
  const dealt = bank.captureDeck[k % bank.captureDeck.length] ?? "friend";
  // The capture a redraw keeps comes first; a stored scene whose capture this bank never deals (an old seed) is dealt from the deck instead.
  for (const capture of [...(opts.capture === undefined ? [] : [opts.capture]), dealt, ...bank.captureDeck]) {
    const draw = drawFor(bank, capture, k, opts);
    if (draw !== null) return draw;
  }
  throw new Error(`the mock found no bank scene for ${what}`);
}

function drawFor(bank: CategoryBank, capture: Capture, k: number, opts: { avoid?: Avoid; leaving?: string; level?: Level; away?: AwayMode }): BankDraw | null {
  const level = opts.level ?? "ordinary";
  const away = opts.away ?? "never";
  const facing: ScenePose = k % 2 === 0 ? "front" : "three-quarter";
  for (const pose of [facing, "three-quarter", "front"] as const) {
    if (!posesFor(capture).includes(pose)) continue;
    let places = bank.places.flatMap((place) => {
      const moments = place.moments.filter((moment) => momentAllowed(moment, capture, moment.angle ?? pose, level) && (away !== "never" || !facesAway(moment.angle)));
      return moments.length === 0 ? [] : [{ place, moments }];
    });
    // A wanted away scene goes where a moment faces away, when the capture has one.
    if (away === "prefer") {
      const facingAway = places.flatMap(({ place, moments }) => {
        const turned = moments.filter((moment) => facesAway(moment.angle));
        return turned.length === 0 ? [] : [{ place, moments: turned }];
      });
      if (facingAway.length > 0) places = facingAway;
    }
    if (places.length === 0) continue;
    const elsewhere = places.filter(({ place }) => place.name !== opts.leaving);
    const fresh = elsewhere.filter(({ place }) => !(opts.avoid?.locations.has(place.name) ?? false));
    const pool = fresh.length > 0 ? fresh : elsewhere.length > 0 ? elsewhere : places;
    const chosen = pool[k % pool.length];
    if (chosen === undefined) continue;
    // The scene's own level among equals (5a.3): a flirty scene takes a flirty moment, a bold one a bold moment, when the place has one.
    const ownMoments = level === "ordinary" ? [] : chosen.moments.filter((moment) => moment.level === level);
    const choices = ownMoments.length > 0 ? ownMoments : chosen.moments;
    // 5a.4 (S5.BA7): a bold scene also turns with each round of the deck, so a capture dealt at the same place on every round (the «above» frame on her bed) still reaches each of the place's
    // bold moments, the implied covers among them, as the engine's seeded draw does. The lower levels deal as they always did.
    const turn = level === "bold" ? Math.floor(k / bank.captureDeck.length) : 0;
    const moment = choices[(Math.floor(k / pool.length) + turn) % choices.length];
    if (moment === undefined) continue;
    // A pinning moment wears only its outfits; a pin-only outfit goes only to a moment that pins it.
    // Never an outfit above the scene's level, its own level preferred (a bank with no outfit level keeps its list whole).
    const available = moment.outfits !== undefined ? bank.outfits.filter((o) => moment.outfits?.includes(o.text)) : bank.outfits.filter((o) => o.pinOnly !== true);
    const worn = atSlotLevel(available, (o) => o.level, level);
    const fresher = worn.filter((o) => !(opts.avoid?.outfits.has(o.text) ?? false));
    const outfits = fresher.length > 0 ? fresher : worn;
    const outfit = outfits[k % Math.max(1, outfits.length)];
    if (outfit === undefined) continue;
    const time = chosen.place.times[k % chosen.place.times.length] ?? "midday";
    const route = moment.route === "seedream" || outfit.route === "seedream" ? ("seedream" as const) : undefined;
    return { capture, pose: moment.angle ?? pose, place: { location: chosen.place.name, timeOfDay: time, activity: moment.text, outfit: outfit.text }, ...(route === undefined ? {} : { route }) };
  }
  return null;
}

/**
 * «Ножки» (S5.8a): the k-th legs scene of a built-in category. A legs scene is a legs moment of a place that has one, its capture comes with the moment (a pov-legs, a low-feet
 * or a mirror frame with her feet to the glass), and it wears an outfit that shows her legs (the moment's pinned ones first). A redraw passes `avoid`, `leaving` and `activity`
 * (the scene's own moment) so the new scene is another place or moment when the bank has one. Deterministic in `k`.
 */
export function legsDraw(ref: SceneCategory, k: number, opts: DrawFor & { avoid?: Avoid; leaving?: string; activity?: string; level?: Level } = {}): BankDraw {
  const bank = builtInBank(ref, opts);
  const rows = bank.places.flatMap((place) => {
    const moments = place.moments.filter((moment) => moment.legs !== undefined && moment.captures.some((capture) => (shotOf(capture) !== "mirror" || place.mirror === true) && momentAllowed(moment, capture, moment.angle ?? "front", "ordinary", "legs")));
    return moments.length === 0 ? [] : [{ place, moments }];
  });
  if (rows.length === 0) throw new Error(`the mock found no legs scene for ${ref}`);
  const elsewhere = rows.filter(({ place }) => place.name !== opts.leaving);
  const fresh = elsewhere.filter(({ place }) => !(opts.avoid?.locations.has(place.name) ?? false));
  const pool = fresh.length > 0 ? fresh : elsewhere.length > 0 ? elsewhere : rows;
  const chosen = pool[k % pool.length] ?? rows[0];
  if (chosen === undefined) throw new Error(`the mock found no legs scene for ${ref}`);
  const others = chosen.moments.filter((moment) => moment.text !== opts.activity);
  const moments = others.length > 0 ? others : chosen.moments;
  const moment = moments[Math.floor(k / pool.length) % moments.length];
  if (moment === undefined) throw new Error(`the mock found no legs moment for ${ref}`);
  const captures = moment.captures.filter((capture) => shotOf(capture) !== "mirror" || chosen.place.mirror === true);
  const capture = captures[k % captures.length] ?? "pov-legs";
  const available = moment.outfits !== undefined ? bank.outfits.filter((o) => moment.outfits?.includes(o.text)) : bank.outfits.filter((o) => o.showsLegs === true && o.pinOnly !== true);
  const worn = atSlotLevel(available, (o) => o.level, opts.level ?? "ordinary");
  const fresher = worn.filter((o) => !(opts.avoid?.outfits.has(o.text) ?? false));
  const outfits = fresher.length > 0 ? fresher : worn;
  const outfit = outfits[k % Math.max(1, outfits.length)];
  if (outfit === undefined) throw new Error(`the mock found no outfit for a legs scene of ${ref}`);
  const time = chosen.place.times[k % chosen.place.times.length] ?? "midday";
  const route = moment.route === "seedream" || outfit.route === "seedream" ? ("seedream" as const) : undefined;
  return { capture, pose: moment.angle ?? "front", framing: "legs", place: { location: chosen.place.name, timeOfDay: time, activity: moment.text, outfit: outfit.text }, ...(route === undefined ? {} : { route }) };
}

/** What the template needs of a scene to write it. */
export interface LocalScene {
  sceneId: number;
  category: CategoryRef | "own";
  shot: PoolShot;
  capture?: Capture | undefined;
  pose: ScenePose;
  place: ScenePlace | null;
  removed: boolean;
  /** «Подача» of the scene (S5.7b); absent = ordinary. 5a.3: a «Смелая» category's scene may be bold. */
  level?: "flirty" | "bold" | undefined;
  /** «Ножки» (S5.8a); absent = an ordinary framing. */
  framing?: "legs" | undefined;
  /** 5a.4 (S5.BA7, I5.73): the Seedream route, the marker of a «Смелая» frame of any category: the template reads a routed scene of the five in its companion, a routed custom scene in the shared banks. */
  route?: "seedream" | undefined;
}

/** What the template and the plain sentence read of a scene. */
type Sentenced = Pick<LocalScene, "category" | "shot" | "capture" | "pose" | "place" | "level" | "framing" | "route">;

/**
 * The template's slot of a planned scene (a built-in by its bank's name, a custom category by its id). 5a.4 (S5.BA7; BA3 review: `slotOf` dropped it): with its route, so a routed scene of the
 * five is written from its companion and a routed custom scene is the writer's, as the engine's slot is.
 */
export function slotOf(scene: Sentenced): TemplateSlot | null {
  if (scene.place === null || scene.category === "own") return null;
  const category = isCustomCategory(scene.category) ? scene.category : BANK_OF[scene.category];
  return {
    category,
    location: scene.place.location,
    activity: scene.place.activity,
    outfit: scene.place.outfit,
    shot: scene.shot,
    pose: scene.pose,
    ...(scene.capture !== undefined && shotOf(scene.capture) === shotOf(captureOfShot(scene.shot)) ? { capture: scene.capture } : {}),
    ...(scene.level === undefined ? {} : { level: scene.level }),
    ...(scene.framing === "legs" ? { framing: "legs" as const } : {}),
    ...(scene.route === undefined ? {} : { route: scene.route }),
  };
}

/**
 * The plain sentence of a planned scene (5a.2, S5.6d): what the model's last attempt leaves a scene with, built by the very function the engine uses. Null for an own scene. 5a.4: a «Смелая»
 * frame ends with its coverage by the avatar's origin (`impliedNudity`), as the engine's plain sentence does.
 */
export function plainTextOf(scene: Sentenced, impliedNudity: boolean): string | null {
  const slot = slotOf(scene);
  return slot === null || slot.location === undefined || slot.activity === undefined || slot.outfit === undefined
    ? null
    : plainSentence({ category: slot.category, location: slot.location, activity: slot.activity, outfit: slot.outfit, shot: slot.shot, capture: slot.capture, pose: slot.pose, level: slot.level, route: slot.route }, impliedNudity);
}

/**
 * The engine's `setLocal`: every planned scene that is not removed, in scene order, rendered once on the key `${setId}:${sceneId}:${k}` (`k` is 0 for the set's own
 * writes, the write's number for a review write), each off the sentences before it (an equal sentence is redrawn). The answer for a scene is its sentence, or
 * null when the template cannot write it, which sends the scene to the model.
 */
export function localTexts(input: { sceneSetId: string; k: number; scenes: readonly LocalScene[]; snapshots: readonly { ref: string }[]; seen?: Iterable<string>; impliedNudity: boolean }): (sceneId: number) => string | null {
  const rendered = new Map<number, string>();
  const seen = new Set<string>(input.seen);
  // S5.6R: a gaze or an expression at most twice in any 20 sentences in a row, kept over the same scenes in the same order as the engine's `localSentences`.
  const tally = new GazeCueTally();
  for (const scene of input.scenes) {
    if (scene.removed) continue;
    const slot = slotOf(scene);
    if (slot === null) continue;
    // 5a.4 (S5.BA7, I5.74): the render's origin, as the engine's `localSentences` is given it: a «Смелая» frame ends with its kept coverage, or its open one for a Studio-created avatar.
    const text = templateSentence(slot, { key: `${input.sceneSetId}:${scene.sceneId}:${input.k}`, snapshots: input.snapshots, seen, tally, impliedNudity: input.impliedNudity, ...(input.k > 0 ? { distinct: true } : {}) });
    if (text === null) continue;
    rendered.set(scene.sceneId, text);
    seen.add(text);
  }
  return (sceneId) => rendered.get(sceneId) ?? null;
}

/**
 * 5a.4 (S5.BA7, plan s5a4 §5.3.3, S5.BA4d): the preposition the mock's writer opens a custom «Смелая» sentence with, by the shared banks' place: for each «rooms» place the first one the
 * engine's bold reader takes for it (engine/scenes/writer.ts `PLACE_PREPOSITIONS`; the mock cannot import it, so mockSceneSets.boldAny.test.ts holds the two equal); for a «by the water» place,
 * which the reader takes with any preposition, the one that reads as English. A place that opens with its own preposition («in the water») opens the sentence as it is.
 */
export const MOCK_PLACE_OPENERS: Readonly<Record<string, string>> = Object.freeze({
  "her room": "in",
  "her bathroom": "in",
  "her window": "by",
  "her balcony": "on",
  "her sofa": "on",
  "a lounger by the water": "on",
  "a sunny spot by the water": "in",
  "a railing over the water": "at",
});

/** A place opened as the sentence's first clause: «In her room», «On a lounger by the water», «In the water». */
export function openedPlace(location: string): string {
  const own = /^(?:in|on|at|by|inside|beside|near|under|over|through|into|onto|outside)\b/i.test(location);
  const opened = own ? location : `${MOCK_PLACE_OPENERS[location] ?? "in"} ${location}`;
  return `${opened.charAt(0).toUpperCase()}${opened.slice(1)}`;
}
