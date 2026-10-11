import type { HairLength as HairLengthEnum, PoolTime, ScenePose } from "../../engine";
import type { Capture } from "../captures";

/** The avatar's hair length (shared/engine/avatar.ts `HairLength`, a zod enum without a type of its own). */
export type HairLength = (typeof HairLengthEnum)["options"][number];

// 5a.2 (S5.6a, plan s5a2 r1.2 §5.1): the shapes of the scene banks. Pure data types; the zod schemas that validate the data at load are in schema.ts.
//
// The core principle (the owner, 2026-10-11): a real girl documenting her own life. Every moment is first a PHOTO moment that ordinary photo runs draw,
// listing the captures it fits (who takes the photo); its `motion` is how the same moment animates later (5b reads it; nothing in 5a.2 does), and an
// optional `startPose` is the start still of a reveal motion (data only). Every bank text is at most POOL_TEXT_MAX (35) characters: a long wording
// (the prone selfie's) lives in its capture line and its pinned outfits, never in a moment.

/** The five built-in categories, by the engine's own names (engine/scenes/types.ts CATEGORIES; pinned equal in engine/scenes/banks.sweep.test.ts).
 *  Labels are computed from the id at render (I5.33): `photoshoot` is «Улица», `travel` is «Виды». */
export const BANK_CATEGORIES = ["home", "travel", "photoshoot", "glamour", "fitness"] as const;
export type BankCategory = (typeof BANK_CATEGORIES)[number];

/** A slot's level («Подача»). 5a.3 adds "bold". Absent means ordinary. */
export type Level = "ordinary" | "flirty";

/** The angle a moment implies. Absent: front or three-quarter. A filter from 5a.2a on (I5.23), the pose source from 5a.2b on. */
export type Angle = Exclude<ScenePose, "front">;

/** How a moment holds her gaze: `own` carries it in the moment itself, `viewer` looks at the viewer, `focus` keeps her eyes on what her hands do. */
export type MomentGaze = "own" | "viewer" | "focus";

/** Hair a moment needs: `tied` may take a tied style (at most 1 in 4 of a run, probe P-5a2), `loose` never does, `own` names her hair itself (no hair line). */
export type MomentHair = "tied" | "loose" | "own";

/** What she is doing, caught mid-moment: a finite present-tense verb phrase without its subject, «waits for the kettle». */
export interface Moment {
  text: string;
  /** I5.35: the clip's one micro-motion, «she slowly lifts and lowers her hips». Data only in 5a.2. */
  motion: string;
  /** A reveal motion's start still (the video slice uses it with this moment's photo as the last frame). Data only. */
  startPose?: string;
  /** The captures this moment fits (who takes the photo). */
  captures: readonly Capture[];
  twoHanded: boolean;
  /** Her phone is in use; such a moment carries `gaze: "own"` and never lands on a hand-held capture. */
  phone?: true;
  /** May happen in the rare messy room (a room's moments only). */
  messyOk?: true;
  /** «Кокетливая» only (5a.2b); never drawn on an ordinary slot. */
  level?: "flirty";
  angle?: Angle;
  gaze?: MomentGaze;
  hair?: MomentHair;
  /** Outdoors in daylight: the only moments a cap may go to. */
  outdoor?: true;
  /** Posing by an object (a lamppost, a shop window): a moment, not a capture kind (r1.2). */
  object?: true;
  /** The only outfits this moment is drawn with, where the wording decides a refusal (the prone selfie: grey lounge shorts drew, cotton shorts did not). */
  outfits?: readonly string[];
  /** «Ножки» (5a.2c): a legs moment, drawn only on a legs slot. */
  legs?: { framing?: "legs" };
  /** Her feet or legs are up (raised behind her, on a railing): no legwear slot (plan r1.4; Grok refused legs up in tights). */
  feetUp?: true;
}

/** A place of a built-in category: its name (what a slot stores), its locative phrase, its times and 2-3 ordinary details. */
export interface BankPlace {
  name: string;
  /** The place as a locative phrase, «in her small kitchen»: the template's first clause. Not sent to the writer, so not bound. */
  at: string;
  times: readonly PoolTime[];
  /** A mirror capture may land here. */
  mirror?: true;
  /** A room of her home or hotel: the room phrase carries its details, so the template adds none. */
  room?: true;
  /** «Дом»'s lamp mood at evening and night (I5.34; the artefact variant is engine/scenes/phoneLook.ts's, S5.6b). */
  lamp?: true;
  /** 2-3 ordinary things in the place, never paper or a screen. */
  details: readonly string[];
  moments: readonly Moment[];
}

export interface Outfit {
  text: string;
  /** The outfit shows her legs: the only outfits legwear goes with. */
  showsLegs?: true;
}

/** Legwear, its own outfit slot (I5.29, K-17): drawn on about `share` of the slots whose outfit shows her legs. Stockings stay in 5a.3. */
export interface LegwearSlot {
  items: readonly string[];
  share: number;
}

export interface CategoryBank {
  places: readonly BankPlace[];
  outfits: readonly Outfit[];
  legwear?: LegwearSlot;
  /** Who takes the photos, as the planner deals them (exact Bag cycles, I5.32). */
  captureDeck: readonly Capture[];
}

/** A gaze kind decides where a gaze may go (the coherence table, render.ts). */
export type GazeKind = "viewer" | "away" | "down" | "hands" | "mirror";

export interface Gaze {
  text: string;
  kind: GazeKind;
  /** Names her phone: a mirror gaze only («her eyes on her phone in the mirror»). */
  phone?: true;
  level?: "flirty";
}

export interface Cue {
  text: string;
  level?: "flirty";
  /** The only captures this cue goes with («a finger near her lips» on «Дом»'s close selfies). Absent: every capture. */
  captures?: readonly Capture[];
}

/** A hairstyle, as it reads after «Today her hair is …». */
export interface Hairstyle {
  text: string;
  lengths: readonly HairLength[];
  tied: boolean;
  /** A cap: outdoor moments only, at most 1 in 8 of a run. */
  cap?: true;
}
