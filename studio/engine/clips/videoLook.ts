import { CAPTURES, type Capture } from "../../shared/scenes/captures";
import { MOTION_STAGING } from "../../shared/scenes/words";
import { FACE_COVER } from "../scenes/phoneLook";

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.5, I5.51): the video look. Every line a clip prompt carries lives here and nowhere else (I5.1, one module per medium; the photo's
// lines are engine/scenes/phoneLook.ts). The prompt builder (prompt.ts) only places them.
//
// Where each line comes from (the probes that worked; a line marked «new» is unproven, and canary C3 judges it):
// - the camera lines are the probes' own (lifevid A, B2 and C; spike B's K01, K02, K09; Grok's G04) or echo the photo's capture line of the same capture
//   (phoneLook FIXED_CAPTURE_LINE): pov-legs is main's photo line (the C3′ winner) turned to video, without «phone» and without «at her eye level», the wording that
//   failed in C3′; mirror-hidden says the photo's FACE_COVER, imported, so the clip hides her face exactly as the photo did;
// - probe P-V (2026-10-13) ran the friend, above and mirror lines with the pose, motion, continuity, pacing, look and adult lines below, on three frames of «Смелая»: 3 of 3
//   completed, and the owner accepted the clips;
// - the prone anchor is the hips-2 take's sentence, word for word (the owner rejected a downward-dog clip);
// - the pacing and the look are the probes' SLOW and LOOK, verbatim.
//
// Never a negated look term beyond the probes' own («No text on screen»): a negation puts the term into the prompt (I5.10).

/** The provider a prompt is written for. The two dialects differ only on the timer line (Grok's probe G04 ran its own). */
export type ClipDialect = "kling" | "grok";

/** Who took the photo, or `unknown` for a photo whose run plan is missing or unreadable (plan §5.4). */
export type ClipCapture = Capture | "unknown";
export const CLIP_CAPTURES: readonly ClipCapture[] = [...CAPTURES, "unknown"];

/** I5.51: every clip prompt is at most this many words. The longest Kling ran was the hips-2 take at 114; the sweep pins the longest this builder writes. */
export const PROMPT_WORDS_MAX = 130;

// C3 (K4): the first selfie line let the phone drift back, leaving her holding an empty outstretched arm. The clip is taken BY the phone, which stays at one arm's length, and her
// arm leaves the frame at its edge, so no empty hand is ever shown.
const SELFIE_TWO_HANDS = "A selfie taken with the phone in her hands, at the same arm's length from her the whole time, never moving back; her arms reach toward the lens and leave the frame at its edges.";
const SELFIE_ONE_HAND = "A selfie taken with the phone in her hand, at the same arm's length from her the whole time, never moving back; her arm reaches toward the lens and leaves the frame at its edge.";
// C3 (K3): «gentle sway» read as jerky. The friend holds the phone steady.
const FRIEND = "Handheld by a friend who holds the phone steady at the same distance; the framing barely moves.";
const POV_LEGS_OPENING = "A first-person point-of-view video: the camera is exactly where her eyes are, looking straight down her own body,";
const NO_FACE_MIRROR_HAND = "no face, no mirror and no hand";

const KLING_CAMERA_LINES: Readonly<Record<ClipCapture, string>> = {
  // lifevid B2 and C, rewritten after C3 (K4).
  prone: SELFIE_TWO_HANDS,
  // The same line with one hand: P-V S2 ran the first wording on `above`; rewritten after C3 (K4).
  selfie: SELFIE_ONE_HAND,
  above: SELFIE_ONE_HAND,
  // New (r2: the capture had no line); echoes the photo's over-the-shoulder line.
  "over-shoulder": "A selfie over her own shoulder as she lies on her stomach: the phone stays in her hand above her shoulder the whole time and the framing never changes.",
  // Main's photo line (phoneLook, the C3′ winner) turned to video.
  "pov-legs": `${POV_LEGS_OPENING} and it stays still; her legs are close to the lens and her feet are at the far end, with ${NO_FACE_MIRROR_HAND}.`,
  // lifevid A; spike B K03, K07, K08; P-V S3.
  mirror: "A mirror selfie: the phone stays in her raised hand the whole time and sways only a little.",
  // lifevid A with the photo's face cover, verbatim.
  "mirror-hidden": `A mirror selfie: she holds her phone right in front of her face, ${FACE_COVER}, the whole time; it sways only a little.`,
  // Spike B K01 («The phone is propped on a shelf and does not move at all.»).
  timer: "The phone is propped up and does not move at all; the framing never changes.",
  // Spike B K02's base; «same distance» is new (C3 rule 7). P-V S1 ran it on a candid frame.
  friend: FRIEND,
  // New (r2); echoes the photo's low-feet line.
  "low-feet": "Handheld by a friend crouching low near her feet who holds the phone steady at the same distance; the framing barely moves.",
  // Spike B K09's base: a candid is a friend's photo.
  candid: FRIEND,
  // New: a photo with no plan says nothing about who held the phone.
  unknown: "The framing stays almost still, with a little natural sway.",
};

/** Grok's dialect: its own probe's timer line (spike B G04); every other line is Kling's. */
const GROK_CAMERA_LINES: Readonly<Partial<Record<ClipCapture, string>>> = {
  timer: "The phone stays completely still the whole time; the framing never changes.",
};

/**
 * The shorter camera line a prompt takes when the full one would cross the word cap (plan §5.5: the camera line is shortened, never an anchor). Only pov-legs needs one:
 * its line is the longest (45 words), and a legs frame with legwear carries the legs line and the legwear line too. It keeps the photo line's view and its «no face, no
 * mirror and no hand»; the legs line that every pov-legs frame carries says where her legs are.
 */
const SHORT_CAMERA_LINES: Readonly<Partial<Record<ClipCapture, string>>> = {
  "pov-legs": `${POV_LEGS_OPENING} and stays still, with ${NO_FACE_MIRROR_HAND}.`,
};

/** The first sentence of every clip prompt: how the phone moves, from who took the photo. */
export function cameraLineOf(capture: ClipCapture, dialect: ClipDialect): string {
  return (dialect === "grok" ? GROK_CAMERA_LINES[capture] : undefined) ?? KLING_CAMERA_LINES[capture];
}

/** The shortened camera line for a prompt over the cap, or null when the capture has none (its prompt always fits). */
export function shortCameraLineOf(capture: ClipCapture, _dialect: ClipDialect): string | null {
  return SHORT_CAMERA_LINES[capture] ?? null;
}

/**
 * The pose sentence (§5.5 item 2): what she is doing in the photo, from the plan slot's activity. A bank moment's text is a finite verb phrase («lies on her stomach»);
 * an old pool activity that opens with an «-ing» word reads after «is».
 */
export function poseSentenceOf(activity: string, form: "finite" | "ing"): string {
  return form === "finite" ? `The adult woman ${activity}.` : `The adult woman is ${activity}.`;
}

/** The motion sentence (§5.5 item 3): the motion verbatim after «Over the whole clip», so «she …» and «her …» both read. */
export function motionSentenceOf(motion: string): string {
  return `Over the whole clip ${motion}.`;
}

/** The prone anchor (the hips-2 take, word for word): on a prone or over-the-shoulder capture, or an activity that lies on her stomach. */
export const PRONE_ANCHOR = "She stays lying on her stomach the whole time; she never gets up on her hands or knees.";

/** The legs line (new): a «Ножки» frame keeps her legs filling the frame. «frame» is the code's own word; the staging list reads motions and activities only. */
export const LEGS_LINE = "Her legs fill most of the frame the whole time; the camera never turns up to her face.";

/**
 * The legs line by the mirror (round 2): the camera line already holds the phone in front of her face, so this one says what fills the frame and nothing of her face, as
 * the photo's own legs phrase there does (engine/scenes/assembler.ts BOLD_MIRROR_LEGS_POSE_PHRASE, S5.R4 round 3).
 */
const MIRROR_LEGS_LINE = "Her legs fill most of the frame the whole time.";

/** The legs line of a «Ножки» frame on this capture. */
export function legsLineOf(capture: ClipCapture): string {
  return capture === "mirror-hidden" ? MIRROR_LEGS_LINE : LEGS_LINE;
}

/** The continuity line (new; spike B K05's paper card, K09's lost bag). */
export const CONTINUITY_LINE = "Nothing new appears, and nothing she holds or wears changes.";

/** The continuity line of a motion that moves what she wears or a cover (critic M5): it never contradicts the motion. */
export const COMES_OFF_LINE = "Nothing new appears, and nothing she wears comes off.";

/**
 * What she wears that a motion moves (r2.2 and the controller's round 2): a garment or a cover (strap, sheet, blanket, duvet, waistband, hem, laces, zip, coat), an accessory
 * (earring, sunglasses), or a sleeve she puts on («she slides one arm in slowly»: a coat or a jacket going on, matched as that phrase, never by «arm», which a stretch says
 * too). A held object (a cup, a glass, a mug, her keys, her phone, a fork, a weight) is not one: «nothing she holds … changes» holds it, and «shifts her weight» is her body.
 * The window «glass» she leans on is not a drink and not worn. The sweep over all 7 banks pins exactly which motions take it.
 */
export const WORN_OR_HELD = /\b(?:straps?|sheets?|blankets?|duvets?|waistbands?|hems?|laces|zip(?:s|ped|ping|per|pers)?|coats?|earrings?|sunglasses|slides one arm in)\b/i;

/**
 * A bag she holds (round 2): its strap or its zip moves a held object, so the base line keeps it (K09 lost its bag), whether the motion or the moment names the bag. «bag»,
 * «handbag» and «backpack» are nouns; «clutch», «purse» and «tote» are verbs too («clutches the sheet», «purses her lips», «her fingers clutch the duvet»), so they count
 * only as nouns: right after an article or a possessive, or after one or two words that describe a bag («a small clutch», «her small black clutch», «a canvas tote»).
 */
const BAG_ADJECTIVE = "(?:small|little|tiny|big|black|white|red|gold|silver|beige|brown|leather|canvas|straw|woven|beaded|quilted|evening)";
const HELD_BAG = new RegExp(
  `\\b(?:bags?|handbags?|backpacks?)\\b|\\b(?:a|an|the|her|his|their|my|your|its)\\s+(?:${BAG_ADJECTIVE}\\s+){0,2}(?:clutch(?:es)?|purses?|totes?)\\b`,
  "i",
);

/**
 * The continuity line for a motion: «comes off» when it moves what she wears, the base line otherwise, and always the base line for a bag she holds. `activity` is the
 * slot's moment as the photo carries it (null when it does not): «adjusts the strap of her bag» makes «she tugs the strap a little» a bag's strap.
 */
export function continuityLineOf(motion: string, activity: string | null): string {
  if (HELD_BAG.test(motion) || (activity !== null && HELD_BAG.test(activity))) return CONTINUITY_LINE;
  return WORN_OR_HELD.test(motion) ? COMES_OFF_LINE : CONTINUITY_LINE;
}

/** The legwear line (spike B2's sock fix): only from the slot's own legwear, never from the motion's words. A bold legs slot names its stockings here and nowhere else. */
export function legwearLineOf(legwear: string): string {
  return `Her ${legwear} stay on her feet the whole time.`;
}

/** The pacing, verbatim from the probes. */
export const SLOW_LINE = "Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures.";

/** The look, verbatim from the probes. */
export const LOOK_LINE = "Vertical phone video, slight noise, everything in focus. No text on screen.";

/** I5.13: every clip prompt ends with it. */
export const ADULT_LINE = "She is an adult woman.";

/** I5.51: camera and edit words of a video, beyond the bank's own staging list. Read on a motion and an activity only, never on these lines (the legs line says «frame»). */
const VIDEO_STAGING = /\b(?:dolly|crane|drone|gimbal|orbit\w*|push-?ins?|cinematic\w*|film\w*|colou?r grading|lens flares?|transitions?)\b/i;

/** Whether a motion or an activity stages the camera or the edit: the bank's MOTION_STAGING, or a video word. */
export function hasVideoStagingWord(text: string): boolean {
  return MOTION_STAGING.test(text) || VIDEO_STAGING.test(text);
}

/** The words of a prompt, counted on whitespace (the cap's measure). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}
