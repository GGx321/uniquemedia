import { CAPTURES, type Capture, type PoolShot, type ScenePose } from "../engine";

// 5a.2 r1.2 (I5.32, plan s5a2 §5.1, §5.4): who takes the photo, as a first-class `capture` on the slot. The owner's references (2026-10-11): at home
// she shoots herself (in the mirror, often with the phone over her face; at arm's length from above; lying on her stomach; on a timer); outside she
// mostly asks someone. The stored `shot` keeps its 5 values (`shot = shotOf(capture)`), so stored plans and sets stay readable; a slot stored before
// captures reads its capture from its shot (`captureOfShot`). `over-shoulder` is the owner's addition (2026-10-11): a photo she takes over her own
// shoulder, looking back along her body as she lies on her stomach (her hair in the foreground, her hips, her feet raised; her face may show). Its
// capture line comes with the others in engine/scenes/phoneLook.ts (S5.6b).

export { CAPTURES, type Capture };

/** «Ножки»'s own captures (5a.2c): drawn only on legs slots. */
export const LEGS_CAPTURES: readonly Capture[] = ["pov-legs", "low-feet"];

const SHOT_OF: Readonly<Record<Capture, PoolShot>> = {
  "mirror-hidden": "mirror",
  mirror: "mirror",
  above: "selfie",
  prone: "selfie",
  "over-shoulder": "selfie",
  selfie: "selfie",
  "pov-legs": "selfie",
  timer: "friend",
  friend: "friend",
  "low-feet": "friend",
  candid: "candid",
};

/** The stored shot a capture rides on. */
export function shotOf(capture: Capture): PoolShot {
  return SHOT_OF[capture];
}

/** An old slot's capture, read from its stored shot: a photographer is someone she asked, a friend. */
export function captureOfShot(shot: PoolShot): Capture {
  return shot === "photographer" ? "friend" : shot;
}

/** One hand holds the phone: no two-handed or phone moment, no `hands` gaze, and the face toward the phone. */
export function isHandCapture(capture: Capture): boolean {
  const shot = shotOf(capture);
  return shot === "selfie" || shot === "mirror";
}

const FACING: readonly ScenePose[] = ["front", "three-quarter"];
const ANY_POSE: readonly ScenePose[] = ["front", "three-quarter", "profile", "back"];

const LOOKING_BACK: readonly ScenePose[] = ["three-quarter"];

/** The poses a capture can take: a hand-held capture faces the phone; the over-the-shoulder POV looks back along her body, so it is turned, three-quarter only. */
export function posesFor(capture: Capture): readonly ScenePose[] {
  if (capture === "over-shoulder") return LOOKING_BACK;
  return isHandCapture(capture) ? FACING : ANY_POSE;
}

export type FaceVisibility = "yes" | "no" | "maybe";

/** What `faceVisibleOf` reads of a slot: its capture (or, for an old slot, its stored shot), its pose and its framing. */
export interface FaceSlot {
  capture?: Capture | undefined;
  shot?: PoolShot | undefined;
  pose: ScenePose;
  framing?: "legs" | undefined;
}

/**
 * Whether her face shows (I5.32), the one source for the planner, the template, the gate and the UI. No: the phone covers it (`mirror-hidden`), she
 * looks down at her legs (`pov-legs`), or she is seen from behind. Maybe: a frame low at her feet, or any legs frame. Yes: everything else. On no and
 * maybe the identity check is marked only, never retried (S5.6f); the template gives a no-face frame no gaze and no cue.
 */
export function faceVisibleOf(slot: FaceSlot): FaceVisibility {
  const capture = slot.capture ?? captureOfShot(slot.shot ?? "friend");
  if (capture === "mirror-hidden" || capture === "pov-legs" || slot.pose === "back") return "no";
  if (capture === "low-feet" || slot.framing === "legs") return "maybe";
  return "yes";
}
