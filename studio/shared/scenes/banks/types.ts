import type { HairLength as HairLengthEnum, PoolShot, PoolTime, ScenePose } from "../../engine";

/** The avatar's hair length (shared/engine/avatar.ts `HairLength`, a zod enum without a type of its own). */
export type HairLength = (typeof HairLengthEnum)["options"][number];

// 5a.2 (S5.6a): the shapes of the scene banks (plan s5a2 §5.1). Pure data types; the zod schemas that validate the data at load are in schema.ts.
//
// The owner's style references (2026-10-11) will change the bank CONTENT; these shapes carry hooks for what they need, none of which is drawn yet:
// - capture kinds beyond the five stored shots (`CaptureKind`, `Moment.captures`, captures.ts);
// - a per-frame face visibility (`CaptureSpec.faceVisible`; the template's slot carries `faceVisible`);
// - a light bank for home content (`LightMood`, `BankPlace.lights`);
// - legwear as its own outfit slot (`CategoryBank.legwear`, behind a probe);
// - postures (`Moment.posture`).

/** The five built-in categories, by the engine's own names (engine/scenes/types.ts CATEGORIES; pinned equal in engine/scenes/banks.sweep.test.ts). */
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

/**
 * How a photo can be taken: the five stored shots and the new kinds the owner's references ask for (2026-10-11). The new kinds are hooks: no capture
 * line exists for them yet, so no slot draws them (captures.ts).
 */
export const CAPTURE_KINDS = ["friend", "selfie", "mirror", "candid", "photographer", "mirror-face-hidden", "selfie-above", "pov-legs", "propped", "by-object"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** The body's posture in a moment (a hook for the references: kneeling, lying with her legs up, sitting on the floor, leaning on a wall). */
export const POSTURES = ["standing", "walking", "sitting", "kneeling", "lying", "leaning"] as const;
export type Posture = (typeof POSTURES)[number];

/** What she is doing, caught mid-moment: a finite present-tense verb phrase without its subject, «waits for the kettle». */
export interface Moment {
  text: string;
  twoHanded: boolean;
  /** Her phone is in use; such a moment carries `gaze: "own"` and never lands on a hand-held shot. */
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
  /** «Ножки» (5a.2c): a legs moment names its footwear (probe P-5a2: no bare feet). */
  legs?: { framing?: "legs"; shots: readonly PoolShot[] };
  /** The only captures this moment fits. Absent: every stored shot, by the usual hand and pose rules. */
  captures?: readonly CaptureKind[];
  posture?: Posture;
}

/** A place of a built-in category: its name (what a slot stores), its locative phrase, its times and 2-3 ordinary details. */
export interface BankPlace {
  name: string;
  /** The place as a locative phrase, «in her small kitchen»: the template's first clause. */
  at: string;
  times: readonly PoolTime[];
  /** A mirror shot may land here. */
  mirror?: true;
  /** A room of her home or hotel: the room phrase carries its details, so the template adds none. */
  room?: true;
  /** 2-3 ordinary things in the place, never paper or a screen. */
  details: readonly string[];
  moments: readonly Moment[];
  /** The light moods this place fits (ids of `LIGHTS`). A hook for the references' home light; not drawn yet. */
  lights?: readonly string[];
}

/** Legwear, its own outfit slot (the references). Drawn only once its probe passes; stockings and lingerie stay in 5a.3. */
export interface Legwear {
  text: string;
  status: "probe" | "passed";
}

export interface CategoryBank {
  places: readonly BankPlace[];
  /** Today's outfit lists, untouched (K-10). */
  outfits: readonly string[];
  /** Who takes the photos, as the planner deals them. */
  shotDeck: readonly PoolShot[];
  legwear?: readonly Legwear[];
}

/** A gaze kind decides where a gaze may go (the coherence table, template.ts). */
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
}

/** A hairstyle, as it reads after «Today her hair is …». */
export interface Hairstyle {
  text: string;
  lengths: readonly HairLength[];
  tied: boolean;
  /** A cap: outdoor moments only, at most 1 in 8 of a run. */
  cap?: true;
}

/** A light mood (a hook for the references' home light: a dim evening lamp, fairy lights, grainy low light). */
export interface LightMood {
  id: string;
  text: string;
  setting: "indoor" | "outdoor";
}

/** What a capture kind is: the stored shot it would ride on, whether a hand holds the phone, and whether her face shows. */
export interface CaptureSpec {
  shot: PoolShot;
  handHeld: boolean;
  faceVisible: boolean;
  /** `drawn`: a stored shot with its capture line. `hook`: no capture line yet, never drawn. `refused`: a probe refused it. */
  status: "drawn" | "hook" | "refused";
}
