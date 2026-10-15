import { BOLD_CLIPS, type BoldClipsMode, type ClipMotionChoice, type ClipUnsuitableReason } from "../../shared/engine";
import { frameRefusalOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { clipPromptOf } from "./prompt";
import type { ClipCapture, ClipDialect } from "./videoLook";

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.5 «Choices», I5.51): what the sheet offers for a photo, at most four, the default first.
//
// 1. «Как в сцене»: the moment's own `motion`, verbatim, when the photo's prompt still says the moment (frameFacts). A bank motion that fails a check before money (prompt.ts)
//    is dropped and logged, never offered.
// 2. Code motions (the table below) for who took the photo and whether her face shows, at most three: so a photo without a bank motion (an older photo, a custom
//    category, an own scene, a renamed moment) still gets two or three. A candid clip never looks at the viewer, and no code motion names a phone. A «Ножки» frame and a
//    face-hidden frame get none (only the hips turn to a mirror on mirror-hidden): their motions come from the banks alone.
//
// The text is data or code, never free text: `clips.create` sends a motion only by an id this module listed for the photo.

export type CodeMotionId = `g-${string}`;

export interface CodeMotion {
  readonly id: CodeMotionId;
  /** The sheet's label (Russian). */
  readonly label: string;
  /** The motion the prompt carries (I5.35 grammar: «she/her …», one movement, small or slow; at most 60 characters, like a bank's). */
  readonly text: string;
  /** The captures it fits. `face` is whether it needs her face to show (`faceVisibleOf` yes); the hips turn does not. */
  readonly captures: readonly ClipCapture[];
  readonly face: boolean;
}

const FACE_VISIBLE: readonly ClipCapture[] = ["selfie", "above", "prone", "over-shoulder", "mirror", "timer", "friend", "candid", "unknown"];
const NOT_CANDID = FACE_VISIBLE.filter((capture) => capture !== "candid");

/**
 * The plan's table (§5.5). g-hair dropped «with her free hand» from the plan's draft: the draft was 67 characters, over the bank's 60, and every capture that takes it has
 * a free hand anyway (the camera lines keep the phone in the other).
 */
export const CODE_MOTIONS: readonly CodeMotion[] = [
  { id: "g-blink", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile", captures: NOT_CANDID, face: true },
  { id: "g-hair", label: "Поправляет прядь", text: "she slowly tucks a strand of hair behind her ear", captures: FACE_VISIBLE, face: true },
  { id: "g-tilt", label: "Наклоняет голову", text: "she tilts her head a little to one side and smiles", captures: NOT_CANDID, face: true },
  { id: "g-glance", label: "Отводит взгляд и возвращает", text: "she slowly glances to the side and looks back", captures: ["selfie", "mirror", "friend", "timer"], face: true },
  { id: "g-breath", label: "Медленный вдох", text: "she slowly takes a breath and relaxes her shoulders", captures: FACE_VISIBLE, face: true },
  { id: "g-down", label: "Улыбается про себя", text: "she slowly looks down and smiles to herself", captures: ["candid", "friend"], face: true },
  { id: "g-hips", label: "Чуть поворачивается к зеркалу", text: "she turns her hips a little toward the mirror and back", captures: ["mirror", "mirror-hidden"], face: false },
];

/**
 * Which fitting code motions the sheet shows first: the mirror's own turn and the candid's look down lead where they fit, the blink leads everywhere else, then the glance,
 * the tilt, the breath and the hair. So a mirror gets the blink, the hips and the glance; a friend the blink, the look down and the glance; a candid the look down, the
 * breath and the hair; a selfie or a timer the blink, the glance and the tilt; a selfie from above, a prone or an over-the-shoulder one, or an unknown capture, the blink,
 * the tilt and the breath.
 */
const PREFERENCE: readonly CodeMotionId[] = ["g-blink", "g-hips", "g-down", "g-glance", "g-tilt", "g-breath", "g-hair"];

/** At most this many code motions per photo: with «Как в сцене» the sheet shows four. */
const CODE_MOTIONS_MAX = 3;
const CHOICES_MAX = 4;

function fits(motion: CodeMotion, facts: FrameFacts): boolean {
  if (facts.legs || !motion.captures.includes(facts.capture)) return false;
  return !motion.face || facts.face === "yes";
}

/** The code motions a photo gets, best first, at most three. None on a legs frame; on a face-hidden frame only the hips turn to a mirror. */
export function codeMotionsFor(facts: FrameFacts): CodeMotion[] {
  const fitting = CODE_MOTIONS.filter((motion) => fits(motion, facts));
  return PREFERENCE.flatMap((id) => fitting.filter((motion) => motion.id === id)).slice(0, CODE_MOTIONS_MAX);
}

const DIALECTS: readonly ClipDialect[] = ["kling", "grok"];

/** Why a motion cannot be sent for this photo in either dialect (Kling first, Grok the fallback), or an empty list. The one motion check reads it as its source (S5.WC2). */
function sendProblems(facts: FrameFacts, text: string, source: "scene" | "code"): string[] {
  return DIALECTS.flatMap((dialect) => {
    const result = clipPromptOf(facts, text, dialect, source);
    return result.ok ? [] : result.problems.map((problem) => `${dialect}: ${problem}`);
  });
}

/** The sheet's motions for a photo: «Как в сцене» first when it is offered and passes, then the code motions; at most four. A motion that fails a check is logged and left out. */
export function motionChoicesOf(facts: FrameFacts, log: (line: string) => void = () => undefined): ClipMotionChoice[] {
  const choices: ClipMotionChoice[] = [];
  if (facts.sceneMotion && facts.moment !== null) {
    const text = facts.moment.motion;
    const problems = sendProblems(facts, text, "scene");
    if (problems.length === 0) choices.push({ id: "scene", source: "scene", label: "Как в сцене", text });
    else log(`[clip] photo ${facts.photoId}: the scene motion «${text}» is not offered (${problems.join("; ")})`);
  }
  for (const motion of codeMotionsFor(facts)) {
    const problems = sendProblems(facts, motion.text, "code");
    if (problems.length === 0) choices.push({ id: motion.id, source: "code", label: motion.label, text: motion.text });
    else log(`[clip] photo ${facts.photoId}: the code motion ${motion.id} is not offered (${problems.join("; ")})`);
  }
  return choices.slice(0, CHOICES_MAX);
}

/** The listed choice with this id, or null: an id the sheet did not list for this photo (`unknown-motion`) never becomes a prompt. */
export function chosenMotion(facts: FrameFacts, id: string, log?: (line: string) => void): ClipMotionChoice | null {
  return motionChoicesOf(facts, log).find((choice) => choice.id === id) ?? null;
}

export type ClipSuitability = { readonly suitable: true; readonly facts: FrameFacts; readonly motions: ClipMotionChoice[] } | { readonly suitable: false; readonly reason: ClipUnsuitableReason };

/**
 * Whether a photo can be animated (§5.4), in `clips.create`'s order: a gallery photo, an age verdict that is not refused, «Смелая» not `off` (I5.57), then at least one
 * motion. The first frame's pixel checks (`photo-unreadable`, `not-vertical`) are V4b's and sit between the age and «Смелая» in that order.
 */
export function clipSuitabilityOf(result: FrameFactsResult, boldClips: BoldClipsMode = BOLD_CLIPS, log?: (line: string) => void): ClipSuitability {
  if (result.kind === "not-a-gallery-photo") return { suitable: false, reason: "not-a-gallery-photo" };
  const refusal = frameRefusalOf(result.facts, boldClips);
  if (refusal !== null) return { suitable: false, reason: refusal };
  const motions = motionChoicesOf(result.facts, log);
  if (motions.length === 0) return { suitable: false, reason: "no-motion" };
  return { suitable: true, facts: result.facts, motions };
}
