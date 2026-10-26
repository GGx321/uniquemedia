import { CAPTURES, LEGS_CAPTURES, type Capture } from "../../shared/scenes/captures";
import { GARMENT, takesOff } from "../../shared/scenes/motionText";
import { FACE_COVER, captureLineOf } from "../scenes/phoneLook";

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.5, I5.51): the video look. Every line a clip prompt carries lives here and nowhere else (I5.1, one module per medium; the photo's
// lines are engine/scenes/phoneLook.ts). The prompt builder (prompt.ts) only places them.
//
// Where each line comes from (the probes that worked). A line marked «new» had no probe of its own. Canary C3 (2026-10-14, five clips K1–K5) judged the lines its clips
// ran; its results and the owner's verdicts are in docs/studio/2026-10-10-stage-5-plan.md §30.8. After it the selfie and friend lines were rewritten (the C3 polish) and
// re-checked the same day (paid re-check R1–R3; owner: better). The pov-legs camera line has never run on a real first-person photo in a paid clip: C3 K1's first frame
// was an old pre-C3′ pov-legs photo, really a selfie from above (S5.WP1 gives such a photo the unknown line):
// - the camera lines are the probes' own (lifevid A, B2 and C; spike B's K01, K02, K09; Grok's G04) or echo the photo's capture line of the same capture
//   (phoneLook FIXED_CAPTURE_LINE): pov-legs is main's photo line (the C3′ winner) turned to video, without «phone» and without «at her eye level», the wording that
//   failed in C3′; mirror-hidden says the photo's FACE_COVER, imported, so the clip hides her face exactly as the photo did;
// - probe P-V (2026-10-13) ran the friend, above and mirror lines with the pose, motion, continuity, pacing, look and adult lines below, on three frames of «Смелая»: 3 of 3
//   completed, and the owner accepted the clips (the friend and selfie lines have since been rewritten by the C3 polish and were re-checked 2026-10-14 (paid re-check R1–R3; owner: better));
//   its pose sentence restated the slot's activity, and FU-CLIP (canary C5c, 2026-10-26) replaced it with the pose anchor, which says nothing the plan alone says;
// - the prone anchor is the hips-2 take's sentence, word for word (the owner rejected a downward-dog clip);
// - the pacing is the probes' SLOW, verbatim; the look is the probes' LOOK plus «One continuous shot, no cuts.» (C3 polish, 2026-10-14).
//
// Never a negated look term beyond the probes' own («No text on screen»): a negation puts the term into the prompt (I5.10). «no cuts» is a deliberate exception (C3 K1: a clip
// jumped mid-way): it negates an edit event, not a look term.

/** The provider a prompt is written for. The two dialects differ only on the timer line (Grok's probe G04 ran its own). */
export type ClipDialect = "kling" | "grok";

/** Who took the photo, or `unknown` for a photo whose run plan is missing or unreadable (plan §5.4) or whose prompt does not prove its pov-legs slot (`provenCaptureOf`). */
export type ClipCapture = Capture | "unknown";
export const CLIP_CAPTURES: readonly ClipCapture[] = [...CAPTURES, "unknown"];

/** I5.51: every clip prompt is at most this many words. The longest Kling ran was the hips-2 take at 114; the sweep pins the longest this builder writes. */
export const PROMPT_WORDS_MAX = 130;

// New (C3 polish, 2026-10-14), re-checked 2026-10-14 (paid re-check R1–R3; owner: better). C3 (K4): the first selfie line let the view drift back and left her holding an empty arm. One line serves every
// selfie capture: the view stays at one distance, the framing never changes, and one arm leaves the frame at its edge, so no empty hand is shown. No «phone» (a phone-in-hand
// capture would invite a phone in view) and no «reach» (spike B: a reach toward the lens pulls the camera back). Her photo has one arm out and a free hand, so no «hands».
const SELFIE = "A selfie at arm's length: the view stays at that same distance from her and the framing never changes; one arm leaves the frame at its edge the whole time.";
// New (C3 polish, 2026-10-14), re-checked 2026-10-14 (paid re-check R1–R3; owner: better). C3 (K3): «gentle sway» read as jerky. The friend holds steady; the line names no phone.
const FRIEND = "Handheld steadily by a friend at the same distance the whole time; the framing barely moves.";
const POV_LEGS_OPENING = "A first-person point-of-view video: the camera is exactly where her eyes are, looking straight down her own body,";
const NO_FACE_MIRROR_HAND = "no face, no mirror and no hand";

const KLING_CAMERA_LINES: Readonly<Record<ClipCapture, string>> = {
  // New (C3 polish): lifevid B2 and C's wording is gone, one line for every selfie.
  prone: SELFIE,
  selfie: SELFIE,
  above: SELFIE,
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
  // New (C3 polish); spike B K02's idea, P-V S1 ran an older wording on a candid frame.
  friend: FRIEND,
  // New (C3 polish); echoes the photo's low-feet line. Not in the paid re-check itself: same wording as FRIEND, re-checked through it.
  "low-feet": "Handheld steadily by a friend crouching low near her feet, at the same distance the whole time; the framing barely moves.",
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

/**
 * S5.WP1 (plan s5b2 I5.69): every pov-legs capture line a run has written into a photo's prompt since the C3′ fix, today's first: today's is phoneLook's own (one source),
 * the older ones are kept here verbatim, each with its commit, so a photo drawn with them still proves its first-person view. A change to phoneLook's pov-legs line must add
 * the line it replaces to this list (videoLook.test.ts pins the list). The line before the fix («looking down along her own legs … held at her eye level») is not on it: it
 * drew a selfie from above (C3 K1's first frame), and a clip that told Kling it was a POV shot cut to a real one mid-way.
 */
export const SHIPPED_POV_CAPTURE_LINES: readonly string[] = [
  // e6865355 (2026-10-12): today's line.
  captureLineOf("pov-legs", ""),
  // 6c94d102 (2026-10-12): the C3′ fix itself, main's line until e6865355 named her legs instead.
  "A first-person point-of-view photo: the camera is exactly where her eyes are, looking straight down her own body; her thighs and knees are close to the lens in the foreground and her feet are at the far end, only her own legs are in the picture, with no face, no mirror and no hand.",
];

/** Whether a photo's prompt carries a shipped POV capture line, verbatim: the only proof a pov-legs photo was drawn as a first-person view. */
export function holdsPovCaptureLine(photoPrompt: string): boolean {
  return SHIPPED_POV_CAPTURE_LINES.some((line) => photoPrompt.includes(line));
}

/**
 * The capture a clip reads of a planned photo (I5.69): a camera line only from what the photo's own prompt proves. A slot planned as pov-legs whose photo's prompt holds
 * no shipped POV line is `unknown`, whose camera line claims nothing; every other capture is the slot's.
 */
export function provenCaptureOf(capture: Capture, photoPrompt: string): ClipCapture {
  return capture === "pov-legs" && !holdsPovCaptureLine(photoPrompt) ? "unknown" : capture;
}

/** The first sentence of every clip prompt: how the phone moves, from who took the photo. */
export function cameraLineOf(capture: ClipCapture, dialect: ClipDialect): string {
  return (dialect === "grok" ? GROK_CAMERA_LINES[capture] : undefined) ?? KLING_CAMERA_LINES[capture];
}

/** The shortened camera line for a prompt over the cap, or null when the capture has none (its prompt always fits). */
export function shortCameraLineOf(capture: ClipCapture, _dialect: ClipDialect): string | null {
  return SHORT_CAMERA_LINES[capture] ?? null;
}

/**
 * The pose anchor (FU-CLIP, new; it replaces §5.5 item 2's pose sentence): it holds her to the photo without saying what the photo shows. The pose sentence restated
 * the plan slot's activity, and the image model does not always draw it: in canary C5c (2026-10-26) clip 2's plan said «lies curled under the blanket», the photo
 * showed her sitting on top of it, and Kling drew the blanket in from nowhere; clip 3's «tucks one leg under her» made her rearrange her legs. One wording serves both
 * dialects: no probe ran a dialect of its own for this line. «The adult woman» opens it, as it opened the pose sentence every probe ran.
 */
export const POSE_ANCHOR = "The adult woman keeps her pose from the photo.";

/**
 * The pose anchor of a motion that moves her across the frame (FU-CLIP round 2, MEDIUM-4): «keeps her pose» would fight a walk or a step, so she only starts in it.
 * The bank's moving motions: «she keeps walking slowly», «she walks on slowly…», «she takes a small step closer», «she laughs and steps back a little», «she wades into
 * the water slowly».
 */
export const MOVING_POSE_ANCHOR = "The adult woman starts in her pose from the photo.";

/** A motion that moves her across the frame: a walk, a step, a wade. */
const MOVES_HER = /\b(?:walk(?:s|ing)?|steps?|stepping|wades?|wading)\b/i;

/** The pose anchor for this motion: she starts in the photo's pose when the motion moves her across the frame, and keeps it otherwise. */
export function poseAnchorOf(motion: string): string {
  return MOVES_HER.test(motion) ? MOVING_POSE_ANCHOR : POSE_ANCHOR;
}

/** The motion sentence (§5.5 item 3): the motion verbatim after «Over the whole clip», so «she …» and «her …» both read. */
export function motionSentenceOf(motion: string): string {
  return `Over the whole clip ${motion}.`;
}

/** The prone anchor (the hips-2 take, word for word). */
export const PRONE_ANCHOR = "She stays lying on her stomach the whole time; she never gets up on her hands or knees.";

/** An activity that lies her on her stomach («lies on her stomach, hips behind», «lying prone»); never «a hand on her stomach» (fitness), which lies her nowhere. */
const LIES_ON_HER_STOMACH = /\b(?:lies|lying)\s+(?:on her stomach|prone)\b/i;
/** A motion of her hips or her bottom, or an arch of her back; never «rolls onto her back», which is no hips motion. */
const HIPS_MOTION = /\b(?:hips?|bum|butt|bottom|arch(?:es|ing)?)\b/i;

/**
 * The prone anchor: on a prone or over-the-shoulder capture, which lies her on her stomach by construction (the photo's own capture line says so,
 * engine/scenes/phoneLook.ts, and the over-shoulder camera line above says it too); and on a frame whose activity lies her on her stomach when the motion moves her
 * hips. FU-CLIP round 2 (MEDIUM-1): the second rule reads the plan, on purpose: a hips motion with no anchor gives the hips-2 take the owner rejected (up on her
 * hands and knees). Any other activity that lies on her stomach («legs bent up» with «she kicks her feet slowly») is held by the pose anchor alone.
 */
export function proneAnchorOf(capture: ClipCapture, activity: string | null, motion: string): string | null {
  if (capture === "prone" || capture === "over-shoulder") return PRONE_ANCHOR;
  return activity !== null && LIES_ON_HER_STOMACH.test(activity) && HIPS_MOTION.test(motion) ? PRONE_ANCHOR : null;
}

/** The legs line (new): a «Ножки» frame keeps her legs filling the frame. «frame» is the code's own word; the staging list reads motions and activities only. */
export const LEGS_LINE = "Her legs fill most of the frame the whole time; the camera never turns up to her face.";

/**
 * The legs line of a capture: a legs capture (`LEGS_CAPTURES`: pov-legs, which `provenCaptureOf` has proven from the photo's own POV line, and low-feet) is a legs frame by
 * construction (the bank schema and the renderer deal it to legs moments only), and its face was never judged, so the camera stays off it. FU-CLIP: a legs frame on any
 * other capture (mirror-hidden, or a pov-legs photo its prompt does not prove, `unknown`) has no legs line: only the plan's framing says her legs fill that photo (C3 K1's
 * «pov-legs» photo was a selfie from above).
 */
export function legsLineOf(capture: ClipCapture): string | null {
  return capture !== "unknown" && LEGS_CAPTURES.includes(capture) ? LEGS_LINE : null;
}

/** The continuity line (new; spike B K05's paper card, K09's lost bag). */
export const CONTINUITY_LINE = "Nothing new appears, and nothing she holds or wears changes.";

/** The continuity line of a motion that moves what she wears or a cover (critic M5): it never contradicts the motion. */
export const COMES_OFF_LINE = "Nothing new appears, and nothing she wears comes off.";

/**
 * The continuity line of a motion that takes clothing off (Q-H = 2, the owner 2026-10-14; plan s5b2 §5.3), or bares her (S5.WC2b, the controller's decision 5): since S5.WC2c
 * (the owner, 2026-10-17) a vision suggestion or an own idea on any frame may, and its prompt says «Nothing new appears.» alone, with no clothing clause: the video model decides.
 */
export const NOTHING_NEW_LINE = "Nothing new appears.";

/**
 * What she wears that a motion moves (r2.2 and the controller's round 2): a garment or a cover (strap, sheet, blanket, duvet, waistband, hem, laces, zip, coat), an accessory
 * (earring, sunglasses), or a sleeve she puts on («she slides one arm in slowly»: a coat or a jacket going on, matched as that phrase, never by «arm», which a stretch says
 * too). A held object (a cup, a glass, a mug, her keys, her phone, a fork, a weight) is not one: «nothing she holds … changes» holds it, and «shifts her weight» is her body.
 * The window «glass» she leans on is not a drink and not worn. The sweep over all 7 banks pins exactly which motions take it. S5.WC2 round 2: every garment the one motion
 * check names (`GARMENT`: a robe, a top, a dress, a towel, a bra …, never «her top knee») is one too, so a model's text that only moves it takes «comes off»; no bank motion
 * names one the list did not already hold.
 */
export const WORN_OR_HELD = new RegExp(
  String.raw`\b(?:straps?|sheets?|blankets?|duvets?|waistbands?|hems?|laces|zip(?:s|ped|ping|per|pers)?|coats?|earrings?|sunglasses|slides one arm in)\b|${GARMENT.source}`,
  "i",
);

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
 * The continuity line for a motion: «Nothing new appears.» alone when it takes clothing off (S5.WC2c: a vision or own motion on any frame may), «comes off» when it moves what
 * she wears, the base line otherwise, and always the base line for a bag she holds. `activity` is the slot's moment as the photo carries it (null when
 * it does not): «adjusts the strap of her bag» makes «she tugs the strap a little» a bag's strap. `takesClothingOff` is the prompt's reading of the motion by its source
 * (`undressesBy`: taking clothing off or baring her, as the grammar reads it, S5.WC2c); by itself the motion is read with `takesOff`.
 */
export function continuityLineOf(motion: string, activity: string | null, takesClothingOff: boolean = takesOff(motion)): string {
  if (takesClothingOff) return NOTHING_NEW_LINE;
  if (HELD_BAG.test(motion) || (activity !== null && HELD_BAG.test(activity))) return CONTINUITY_LINE;
  return WORN_OR_HELD.test(motion) ? COMES_OFF_LINE : CONTINUITY_LINE;
}

/** The legwear line (spike B2's sock fix): only from the slot's own legwear, never from the motion's words. A bold legs slot names its stockings here and nowhere else. */
export function legwearLineOf(legwear: string): string {
  return `Her ${legwear} stay on her feet the whole time.`;
}

/** The pacing, verbatim from the probes. */
export const SLOW_LINE = "Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures.";

/** The look: the probes' own words, plus «One continuous shot, no cuts.» (C3 K1: a clip jumped mid-way). */
export const LOOK_LINE = "Vertical phone video, slight noise, everything in focus. One continuous shot, no cuts. No text on screen.";

/** I5.13: every clip prompt ends with it. */
export const ADULT_LINE = "She is an adult woman.";

/**
 * Whether a motion or an activity stages the camera or the edit: the bank's MOTION_STAGING, or a video word (I5.51). Read on a motion and an activity only, never on these lines
 * (the legs line says «frame»). Since S5.WC2 its one definition is the one motion check's (shared/scenes/motionText.ts).
 */
export { hasVideoStagingWord } from "../../shared/scenes/motionText";

/** The words of a prompt, counted on whitespace (the cap's measure). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}
