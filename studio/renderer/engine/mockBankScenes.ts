import type { CategoryRef, PoolShot, SceneCategory, ScenePlace, ScenePose } from "../../shared/engine";
import { isCustomCategory } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import type { BankCategory, Level } from "../../shared/scenes/banks/types";
import { captureOfShot, posesFor, shotOf, type Capture } from "../../shared/scenes/captures";
import { plainSentence } from "../../shared/scenes/plain";
import { GazeCueTally, momentAllowed, templateSentence, type TemplateSlot } from "../../shared/scenes/template";

// 5a.2 (S5.6e, plan s5a2 §5.7): the mock's side of the code template. A built-in scene is a PAIR of its category's bank (a place by name, a moment of that place,
// an outfit the bank allows) dealt a capture from the category's deck, so the shared template can write it, exactly as it writes the engine's. The mock keeps its
// own deterministic dealing (the engine's planner is not the mock's business; the parity suite compares counts, never picks), but every phrase is the bank's.

/** The planner's (and the banks') names for the contract's short built-in refs. */
export const BANK_OF: Readonly<Record<SceneCategory, BankCategory>> = { home: "home", travel: "travel", shoot: "photoshoot", glam: "glamour", fit: "fitness" };

/** What the mock draws for one built-in scene. */
export interface BankDraw {
  capture: Capture;
  pose: ScenePose;
  place: ScenePlace;
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
 * The k-th scene of a built-in category: its capture off the deck (or the one a redraw keeps), a (place, moment) pair that capture, level and the facing pose allow, an
 * outfit the moment wears. The pose is the moment's own `angle`, else facing the camera (the angle comes from the scene, S5.7b). A flirty scene prefers a flirty moment, as the
 * engine's planner does. Deterministic in `k`. A redraw passes `avoid`, `capture` and `leaving` (the place it is leaving) so the new scene is another place and another outfit
 * when the bank has one.
 */
export function bankDraw(ref: SceneCategory, k: number, opts: { avoid?: Avoid; capture?: Capture; leaving?: string; level?: Level; away?: AwayMode } = {}): BankDraw {
  const bank = BANKS[BANK_OF[ref]];
  const dealt = bank.captureDeck[k % bank.captureDeck.length] ?? "friend";
  // The capture a redraw keeps comes first; a stored scene whose capture this bank never deals (an old seed) is dealt from the deck instead.
  for (const capture of [...(opts.capture === undefined ? [] : [opts.capture]), dealt, ...bank.captureDeck]) {
    const draw = drawFor(bank, capture, k, opts);
    if (draw !== null) return draw;
  }
  throw new Error(`the mock found no bank scene for ${ref}`);
}

function drawFor(bank: (typeof BANKS)[BankCategory], capture: Capture, k: number, opts: { avoid?: Avoid; leaving?: string; level?: Level; away?: AwayMode }): BankDraw | null {
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
    const flirtyMoments = level === "flirty" ? chosen.moments.filter((moment) => moment.level === "flirty") : [];
    const choices = flirtyMoments.length > 0 ? flirtyMoments : chosen.moments;
    const moment = choices[Math.floor(k / pool.length) % choices.length];
    if (moment === undefined) continue;
    // A pinning moment wears only its outfits; a pin-only outfit goes only to a moment that pins it.
    const worn = moment.outfits !== undefined ? bank.outfits.filter((o) => moment.outfits?.includes(o.text)) : bank.outfits.filter((o) => o.pinOnly !== true);
    const fresher = worn.filter((o) => !(opts.avoid?.outfits.has(o.text) ?? false));
    const outfits = fresher.length > 0 ? fresher : worn;
    const outfit = outfits[k % Math.max(1, outfits.length)];
    if (outfit === undefined) continue;
    const time = chosen.place.times[k % chosen.place.times.length] ?? "midday";
    return { capture, pose: moment.angle ?? pose, place: { location: chosen.place.name, timeOfDay: time, activity: moment.text, outfit: outfit.text } };
  }
  return null;
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
  /** «Подача» of the scene (S5.7b); absent = ordinary. */
  level?: "flirty" | undefined;
}

/** The template's slot of a planned scene (a built-in by its bank's name, a custom category by its id). */
export function slotOf(scene: Pick<LocalScene, "category" | "shot" | "capture" | "pose" | "place" | "level">): TemplateSlot | null {
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
    ...(scene.level === "flirty" ? { level: "flirty" as const } : {}),
  };
}

/** The plain sentence of a planned scene (5a.2, S5.6d): what the model's last attempt leaves a scene with, built by the very function the engine uses. Null for an own scene. */
export function plainTextOf(scene: Pick<LocalScene, "category" | "shot" | "capture" | "pose" | "place" | "level">): string | null {
  const slot = slotOf(scene);
  return slot === null || slot.location === undefined || slot.activity === undefined || slot.outfit === undefined ? null : plainSentence({ category: slot.category, location: slot.location, activity: slot.activity, outfit: slot.outfit, shot: slot.shot, capture: slot.capture, pose: slot.pose, level: slot.level });
}

/**
 * The engine's `setLocal`: every planned scene that is not removed, in scene order, rendered once on the key `${setId}:${sceneId}:${k}` (`k` is 0 for the set's own
 * writes, the write's number for a review write), each off the sentences before it (an equal sentence is redrawn). The answer for a scene is its sentence, or
 * null when the template cannot write it, which sends the scene to the model.
 */
export function localTexts(input: { sceneSetId: string; k: number; scenes: readonly LocalScene[]; snapshots: readonly { ref: string }[]; seen?: Iterable<string> }): (sceneId: number) => string | null {
  const rendered = new Map<number, string>();
  const seen = new Set<string>(input.seen);
  // S5.6R: a gaze or an expression at most twice in any 20 sentences in a row, kept over the same scenes in the same order as the engine's `localSentences`.
  const tally = new GazeCueTally();
  for (const scene of input.scenes) {
    if (scene.removed) continue;
    const slot = slotOf(scene);
    if (slot === null) continue;
    const text = templateSentence(slot, { key: `${input.sceneSetId}:${scene.sceneId}:${input.k}`, snapshots: input.snapshots, seen, tally, ...(input.k > 0 ? { distinct: true } : {}) });
    if (text === null) continue;
    rendered.set(scene.sceneId, text);
    seen.add(text);
  }
  return (sceneId) => rendered.get(sceneId) ?? null;
}
