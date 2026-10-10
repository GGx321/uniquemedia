import { youthWords, type AvatarDescriptor } from "../../shared/engine";
import { promptSubject } from "../avatars/prompts";
import type { LibraryReference } from "../library/media";
import { artefactLine, CAPTURE_LINE, CONSTRAINTS, imperfectionOf, lightOf, phoneHandLine, roomStateOf, slotKeyOf, type RoomPlace } from "./phoneLook";
import { revealingWordsIn } from "./words";
import { isOwnSlot, type Pose, type RunSlot, type ScenePlan } from "./schema";
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

/** One rule a sentence breaks, with the words that broke it (ours to name: the rules' own vocabulary, never the model's other text). */
export interface SentenceProblem {
  reason: "youth-word" | "revealing-word";
  words: string[];
}

/**
 * Every rule a sentence breaks before it may go into an image prompt: a youth
 * word, a revealing word (the youth words first). The one check the assembler's
 * last gate runs and the owner's edit-time check can show at once. Not a new
 * rule: the same two the writer's answer reader applies.
 */
export function sentenceProblems(sentence: string): SentenceProblem[] {
  const problems: SentenceProblem[] = [];
  const youth = youthWords(sentence, "descriptor");
  if (youth.length > 0) problems.push({ reason: "youth-word", words: youth });
  const revealing = revealingWordsIn(sentence);
  if (revealing.length > 0) problems.push({ reason: "revealing-word", words: revealing });
  return problems;
}

// T5c, S5.1a: how the photo was taken (the capture line, first in the prompt) now lives in phoneLook.ts with every other look phrase (I5.1). This
// module's POSE_PHRASE below says which way she is turned and whether her face is visible: friend/candid/photographer slots can land on any pose, so
// the face-visibility claim comes from it and is never hardcoded in a capture line (a back pose would contradict it). Selfie and mirror are always
// front or three-quarter (schema.ts), so POSE_PHRASE's face claim is always right for them.

/**
 * T5c: a fixed phrase per pose — the capture line (phoneLook.ts) says how the
 * photo was taken, this says which way she is turned and whether her face is
 * visible.
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

const BINDING = "The same woman as in the reference photo,";

/**
 * T5c: the reference-binding anchor, pose-aware. Front/three-quarter keep
 * the original face anchor; a profile shot's face is still visible, so it
 * keeps the face too, with "profile" and "build" named explicitly (the
 * reference-binding wording must still make sense for a profile shot); a
 * back shot has no face to bind at all, so it anchors on hair, build and
 * posture instead. S5.1a (C-21): every pose asks for «the exact hair colour
 * from the reference photo», never «natural» (a dyed colour is hers too).
 */
export const BINDING_ANCHOR: Record<Pose, string> = {
  front: "with her exact face, facial proportions and the exact hair colour from the reference photo",
  "three-quarter": "with her exact face, facial proportions and the exact hair colour from the reference photo",
  profile: "with her exact facial profile, the exact hair colour from the reference photo and build",
  back: "with the exact hair colour from the reference photo, her build and posture",
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

function constraintsFor(slot: RunSlot): string {
  const hand = phoneHandLine(slot.shot);
  return hand === null ? CONSTRAINTS : `${CONSTRAINTS} ${hand}`;
}

export interface AssembleOptions {
  /** The run's id: with the slot's attempt id base it seeds the slot's look draws (the imperfection, the room state), so a resume assembles the same prompt (I5.4). */
  runId: string;
  /** «Реализм камеры»: the artefact line carries the camera-roll artefacts and the imperfection. Off when absent. */
  cameraRealism?: boolean;
  /** The place of a slot as the room draw reads it, or null for none (an own scene, a renamed place). Absent: no slot gets a room phrase. */
  roomPlaceOf?: (slot: RunSlot) => RoomPlace | null;
}

export interface AssembledScene {
  slotIndex: number;
  prompt: string;
  /** Always the avatar's master alone in Stage 2 (the fixed decision: no identity pack). */
  references: readonly LibraryReference[];
}

/**
 * Builds one slot's final image prompt, in the settled order (S5.1a, plan 6.2): the capture line, the pose phrase, the writer's sentence, the room
 * phrase (if the slot's place is a room), the reference binding and the avatar's descriptor (via `promptSubject`, the only path from the avatar
 * into the prompt), the artefact line («Реализм камеры» on or off) and the constraints. Every look phrase comes from phoneLook.ts; the draws (the
 * imperfection, the room state) are pure functions of `${runId}:${attemptIdBase}`. Then it strips stop-words. `sentence` is re-checked against the
 * same youth- and revealing-word rules the writer's own gate already ran (runs/writerPhase.ts / readWriterAnswer): a defense-in-depth last resort,
 * since this is the last engine code to see the text before an image is paid for.
 */
export function assembleSlot(descriptor: AvatarDescriptor, slot: RunSlot, sentence: string, master: LibraryReference, options: AssembleOptions): AssembledScene {
  const [problem] = sentenceProblems(sentence);
  if (problem !== undefined) {
    const kind = problem.reason === "youth-word" ? "a youth word" : "a revealing word";
    throw new AssemblerRefusalError(`the sentence for slot ${slot.slotIndex} still carries ${kind}: ${problem.words.join(", ")}`);
  }

  const anchor = promptSubject(descriptor);
  const key = slotKeyOf(options.runId, slot.attemptIdBase);
  // An own scene has no stored time (the writer's sentence carries its light) and no place, so it gets the neutral light and no room phrase.
  const light = lightOf(isOwnSlot(slot) ? undefined : slot.timeOfDay);
  const room = roomStateOf(key, options.roomPlaceOf?.(slot) ?? null);
  const artefact = artefactLine({ cameraRealism: options.cameraRealism === true, light, imperfection: imperfectionOf(slot.shot, key) });
  const raw =
    `${CAPTURE_LINE[slot.shot]} ${POSE_PHRASE[slot.pose]}. ${field(sentence)}. ` +
    (room === null ? "" : `${room} `) +
    `${BINDING} ${BINDING_ANCHOR[slot.pose]}; ${anchor}. ` +
    `${artefact} ${constraintsFor(slot)}`;
  return { slotIndex: slot.slotIndex, prompt: normalize(raw), references: [master] };
}

/** Assembles every slot of a plan against one sentence map (the writer job's result); throws if any slot has no sentence. */
export function assembleRun(descriptor: AvatarDescriptor, scenePlan: { readonly slots: readonly RunSlot[] } & Partial<Omit<ScenePlan, "slots">>, sentences: ReadonlyMap<number, string>, master: LibraryReference, options: AssembleOptions): AssembledScene[] {
  return scenePlan.slots.map((slot) => {
    const sentence = sentences.get(slot.slotIndex);
    if (sentence === undefined) throw new RangeError(`no writer sentence for slot ${slot.slotIndex}`);
    return assembleSlot(descriptor, slot, sentence, master, options);
  });
}
