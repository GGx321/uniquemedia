import type { CategoryRef, PoolShot, SceneCategory, ScenePlace, ScenePose } from "../../shared/engine";
import { isCustomCategory } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import type { BankCategory } from "../../shared/scenes/banks/types";
import { captureOfShot, isHandCapture, posesFor, shotOf, type Capture } from "../../shared/scenes/captures";
import { plainSentence } from "../../shared/scenes/plain";
import { momentAllowed, templateSentence, type TemplateSlot } from "../../shared/scenes/template";

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

/** The pose the run's toggles ask for the k-th scene: a hand-held capture faces the camera, the others may turn when the run says so. */
function wantedPose(k: number, capture: Capture, poses: { profile: boolean; back: boolean }): ScenePose {
  if (isHandCapture(capture) || k % 5 < 3) return k % 2 === 0 ? "front" : "three-quarter";
  if (poses.profile && k % 5 === 3) return "profile";
  if (poses.back && k % 5 === 4) return "back";
  return "three-quarter";
}

/**
 * The k-th scene of a built-in category: its capture off the deck (or the one a redraw keeps), the pose the run asks for (falling back to a facing one when the
 * bank has no moment for it), a (place, moment) pair that capture and pose allow, an outfit the moment wears. Deterministic in `k`. A redraw passes `avoid`,
 * `capture` and `keepPlace` (the place it is leaving) so the new scene is another place and another outfit when the bank has one.
 */
export function bankDraw(ref: SceneCategory, k: number, poses: { profile: boolean; back: boolean }, opts: { avoid?: Avoid; capture?: Capture; leaving?: string } = {}): BankDraw {
  const bank = BANKS[BANK_OF[ref]];
  const dealt = bank.captureDeck[k % bank.captureDeck.length] ?? "friend";
  // The capture a redraw keeps comes first; a stored scene whose capture this bank never deals (an old seed) is dealt from the deck instead.
  for (const capture of [...(opts.capture === undefined ? [] : [opts.capture]), dealt, ...bank.captureDeck]) {
    const draw = drawFor(bank, capture, k, poses, opts);
    if (draw !== null) return draw;
  }
  throw new Error(`the mock found no bank scene for ${ref}`);
}

function drawFor(bank: (typeof BANKS)[BankCategory], capture: Capture, k: number, poses: { profile: boolean; back: boolean }, opts: { avoid?: Avoid; leaving?: string }): BankDraw | null {
  const wanted = wantedPose(k, capture, poses);
  for (const pose of [wanted, "three-quarter", "front"] as const) {
    if (!posesFor(capture).includes(pose)) continue;
    const places = bank.places.flatMap((place) => {
      const moments = place.moments.filter((moment) => momentAllowed(moment, capture, pose));
      return moments.length === 0 ? [] : [{ place, moments }];
    });
    if (places.length === 0) continue;
    const elsewhere = places.filter(({ place }) => place.name !== opts.leaving);
    const fresh = elsewhere.filter(({ place }) => !(opts.avoid?.locations.has(place.name) ?? false));
    const pool = fresh.length > 0 ? fresh : elsewhere.length > 0 ? elsewhere : places;
    const chosen = pool[k % pool.length];
    if (chosen === undefined) continue;
    const moment = chosen.moments[Math.floor(k / pool.length) % chosen.moments.length];
    if (moment === undefined) continue;
    // A pinning moment wears only its outfits; a pin-only outfit goes only to a moment that pins it.
    const worn = moment.outfits !== undefined ? bank.outfits.filter((o) => moment.outfits?.includes(o.text)) : bank.outfits.filter((o) => o.pinOnly !== true);
    const fresher = worn.filter((o) => !(opts.avoid?.outfits.has(o.text) ?? false));
    const outfits = fresher.length > 0 ? fresher : worn;
    const outfit = outfits[k % Math.max(1, outfits.length)];
    if (outfit === undefined) continue;
    const time = chosen.place.times[k % chosen.place.times.length] ?? "midday";
    return { capture, pose, place: { location: chosen.place.name, timeOfDay: time, activity: moment.text, outfit: outfit.text } };
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
}

/** The template's slot of a planned scene (a built-in by its bank's name, a custom category by its id). */
export function slotOf(scene: Pick<LocalScene, "category" | "shot" | "capture" | "pose" | "place">): TemplateSlot | null {
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
  };
}

/** The plain sentence of a planned scene (5a.2, S5.6d): what the model's last attempt leaves a scene with, built by the very function the engine uses. Null for an own scene. */
export function plainTextOf(scene: Pick<LocalScene, "category" | "shot" | "capture" | "pose" | "place">): string | null {
  const slot = slotOf(scene);
  return slot === null || slot.location === undefined || slot.activity === undefined || slot.outfit === undefined ? null : plainSentence({ category: slot.category, location: slot.location, activity: slot.activity, outfit: slot.outfit, shot: slot.shot, capture: slot.capture });
}

/**
 * The engine's `setLocal`: every planned scene that is not removed, in scene order, rendered once on the key `${setId}:${sceneId}:${k}` (`k` is 0 for the set's own
 * writes, the write's number for a review write), each off the sentences before it (an equal sentence is redrawn). The answer for a scene is its sentence, or
 * null when the template cannot write it, which sends the scene to the model.
 */
export function localTexts(input: { sceneSetId: string; k: number; scenes: readonly LocalScene[]; snapshots: readonly { ref: string }[]; seen?: Iterable<string> }): (sceneId: number) => string | null {
  const rendered = new Map<number, string>();
  const seen = new Set<string>(input.seen);
  for (const scene of input.scenes) {
    if (scene.removed) continue;
    const slot = slotOf(scene);
    if (slot === null) continue;
    const text = templateSentence(slot, { key: `${input.sceneSetId}:${scene.sceneId}:${input.k}`, snapshots: input.snapshots, seen });
    if (text === null) continue;
    rendered.set(scene.sceneId, text);
    seen.add(text);
  }
  return (sceneId) => rendered.get(sceneId) ?? null;
}
