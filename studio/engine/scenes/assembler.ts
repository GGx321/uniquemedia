import { youthWords, type AvatarDescriptor } from "../../shared/engine";
import { promptSubject } from "../avatars/prompts";
import type { LibraryReference } from "../library/media";
import { revealingWordsIn } from "./words";
import type { Pose, ScenePlan } from "./schema";
import type { PlanSlot } from "./schema";
import type { Shot } from "./types";

// T5b: the assembler. Pure, no I/O, deterministic: the same descriptor, slot,
// sentence and reference always build the exact same prompt. The anchor
// (promptSubject(descriptor)) is the only path from the avatar into the
// prompt — this module never reads the avatar's traits or its free-text mood
// note, only its descriptor, exactly like avatars/prompts.ts's own image
// prompts (candidatePrompt). The master reference is bound by its branded
// type alone: this module never takes raw bytes and never mints the brand
// itself (only Library.loadReference() may, per library/media.ts).

/** A writer sentence that still fails today's rules, caught as a last-resort gate before any image request is built (invariant 8). */
export class AssemblerRefusalError extends TypeError {}

// T5c: selfie and mirror are always front/three-quarter (schema.ts's own
// refine pins this), so their own "face fully visible" wording stays exactly
// right regardless of pose. friend/candid/photographer can land on any pose,
// so their face-visibility claim now comes from POSE_PHRASE below instead of
// being hardcoded here — hardcoding "face clearly visible" on these three
// would contradict a back or profile pose's own phrase.
//
// Round 2 review (HIGH): candid's own "not looking at the camera" combined
// with front's original "She faces the camera" produced a self-contradicting
// prompt for a candid+front slot — a real combination (candid draws any
// pose). Exported so assembler.test.ts's coherence test can scan every
// value directly, and so the shot×pose coherence check has the exact text
// to reason about.
export const SHOT_PHRASE: Record<Shot, string> = {
  friend: "Photo taken by a friend with the rear phone camera, three-quarter or full-body framing",
  selfie: "Front-camera selfie at arm's length, slight wide-angle distortion, face fully visible",
  mirror: "Mirror selfie, phone held at chest height, face fully visible in the mirror",
  candid: "Candid shot, she is not looking at the camera",
  photographer: "Photographed by a photographer with a full-frame camera, three-quarter or full-body framing",
};

/**
 * T5c: a fixed phrase per pose, exactly like SHOT_PHRASE — the shot phrase
 * above says how the photo was taken, this says which way she is turned and
 * whether her face is visible.
 *
 * Round 2 review (HIGH): `front` no longer says "She faces the camera"
 * (an active gaze claim that contradicts candid's "not looking at the
 * camera"). It now describes orientation only — her face and body turned
 * toward the lens, face clearly visible — without claiming eye contact, so
 * it reads fine next to candid ("not looking at the camera" can still be
 * true of someone turned toward the lens but glancing elsewhere), next to
 * friend/photographer (no gaze claim either way), and next to selfie/mirror
 * (their own "face fully visible" wording is consistent, not contradictory).
 * `three-quarter` never claimed eye contact and is unchanged.
 */
export const POSE_PHRASE: Record<Pose, string> = {
  front: "Her face and body oriented toward the camera, her face clearly visible",
  "three-quarter": "Her face and body turned to a three-quarter angle, face clearly visible",
  profile: "She is seen in profile, her face turned fully to the side",
  back: "Photographed from behind, her face not visible",
};

const REALISM_EDITORIAL = "Editorial photo, natural skin texture, no heavy retouching.";
const REALISM_PHONE = "Smartphone photo, natural skin texture, slight noise, no retouching, no beauty filter.";

const BASE_CONSTRAINTS = "She is an adult woman. Only she is in focus; no text, logos, brand names or watermark.";
const PHONE_HAND_CONSTRAINT = " One hand holds the phone; only her other hand acts.";

const BINDING = "The same woman as in the reference photo,";

/**
 * T5c: the reference-binding anchor, pose-aware. Front/three-quarter keep
 * the original face anchor; a profile shot's face is still visible, so it
 * keeps the face too, with "profile" and "build" named explicitly (the
 * reference-binding wording must still make sense for a profile shot); a
 * back shot has no face to bind at all, so it anchors on hair, build and
 * posture instead.
 */
export const BINDING_ANCHOR: Record<Pose, string> = {
  front: "with her exact face, facial proportions and hairline",
  "three-quarter": "with her exact face, facial proportions and hairline",
  profile: "with her exact facial profile, hairline and build",
  back: "with her exact hair, build and posture",
};

const STOP_WORD_LIST = "8k|masterpiece|professional photo|perfect skin|stunning|flawless|beautiful";
/**
 * Stop-words: marketing superlatives the assembler never lets through,
 * whatever fed them in (mirrors the spike's assembler). Takes a directly
 * adjacent comma on either side with it — review round 1 (LOW): a bare word
 * removal left a dangling comma ("A stunning, flawless view" -> "A, view");
 * a leading comma is tried first (it starts the match earlier in the
 * string, so it wins over the bare-word alternative), then a trailing one,
 * then the bare word alone.
 */
const STOP_WORDS = new RegExp(`,\\s*\\b(?:${STOP_WORD_LIST})\\b|\\b(?:${STOP_WORD_LIST})\\b\\s*,|\\b(?:${STOP_WORD_LIST})\\b`, "gi");

/** Trailing punctuation dropped so the template's own separators are the only ones. */
function field(text: string): string {
  return text.trim().replace(/[\s.,;:!]+$/, "");
}

function normalize(text: string): string {
  return text
    .replace(STOP_WORDS, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;])/g, "$1")
    .replace(/,(?:\s*,)+/g, ",")
    .replace(/\.(?:\s*\.)+/g, ".")
    .replace(/,\s*\./g, ".")
    .trim();
}

function phoneInHand(shot: Shot): boolean {
  return shot === "selfie" || shot === "mirror";
}

function constraintsFor(slot: PlanSlot): string {
  return BASE_CONSTRAINTS + (phoneInHand(slot.shot) ? PHONE_HAND_CONSTRAINT : "");
}

export interface AssembledScene {
  slotIndex: number;
  prompt: string;
  /** Always the avatar's master alone in Stage 2 (the fixed decision: no identity pack). */
  references: readonly LibraryReference[];
}

/**
 * Builds one slot's final image prompt from the avatar's descriptor (via
 * `promptSubject`, the only path from the avatar into the prompt), the
 * writer's sentence, a shot phrase, a realism suffix and the constraints
 * (one hand holds the phone for a selfie/mirror slot, no text/watermark,
 * adult woman), then strips stop-words. `sentence` is re-checked against the
 * same youth- and revealing-word rules the writer's own gate already ran
 * (runs/writerPhase.ts / readWriterAnswer): a defense-in-depth last resort, since
 * this is the last engine code to see the text before an image is paid for.
 */
export function assembleSlot(descriptor: AvatarDescriptor, slot: PlanSlot, sentence: string, master: LibraryReference): AssembledScene {
  const youth = youthWords(sentence, "descriptor");
  if (youth.length > 0) throw new AssemblerRefusalError(`the sentence for slot ${slot.slotIndex} still carries a youth word: ${youth.join(", ")}`);
  const revealing = revealingWordsIn(sentence);
  if (revealing.length > 0) throw new AssemblerRefusalError(`the sentence for slot ${slot.slotIndex} still carries a revealing word: ${revealing.join(", ")}`);

  const anchor = promptSubject(descriptor);
  const realism = slot.category === "photoshoot" ? REALISM_EDITORIAL : REALISM_PHONE;
  const raw =
    `${BINDING} ${BINDING_ANCHOR[slot.pose]}; ${anchor}. ` +
    `${SHOT_PHRASE[slot.shot]}. ${POSE_PHRASE[slot.pose]}. ${field(sentence)}. ` +
    `${realism} ${constraintsFor(slot)}`;
  return { slotIndex: slot.slotIndex, prompt: normalize(raw), references: [master] };
}

/** Assembles every slot of a plan against one sentence map (the writer job's result); throws if any slot has no sentence. */
export function assembleRun(descriptor: AvatarDescriptor, scenePlan: ScenePlan, sentences: ReadonlyMap<number, string>, master: LibraryReference): AssembledScene[] {
  return scenePlan.slots.map((slot) => {
    const sentence = sentences.get(slot.slotIndex);
    if (sentence === undefined) throw new RangeError(`no writer sentence for slot ${slot.slotIndex}`);
    return assembleSlot(descriptor, slot, sentence, master);
  });
}
