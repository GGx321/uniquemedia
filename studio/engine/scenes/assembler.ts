import { youthWords, type AvatarDescriptor } from "../../shared/engine";
import { promptSubject } from "../avatars/prompts";
import type { LibraryReference } from "../library/media";
import { revealingWordsIn } from "./words";
import type { ScenePlan } from "./schema";
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

// TODO(pose): every phrase below assumes her face is always visible
// (frontal/three-quarter framing). A later task adds the plan slot's own
// `pose` field (front, three-quarter, profile, back) and should make these
// pose-aware instead of hardcoding "face clearly/fully visible".
const SHOT_PHRASE: Record<Shot, string> = {
  friend: "Photo taken by a friend with the rear phone camera, three-quarter or full-body framing, face clearly visible",
  selfie: "Front-camera selfie at arm's length, slight wide-angle distortion, face fully visible",
  mirror: "Mirror selfie, phone held at chest height, face fully visible in the mirror",
  candid: "Candid shot, she is not looking at the camera, face in three-quarter view and clearly visible",
  photographer: "Photographed by a photographer with a full-frame camera, three-quarter or full-body framing, face clearly visible",
};

const REALISM_EDITORIAL = "Editorial photo, natural skin texture, no heavy retouching.";
const REALISM_PHONE = "Smartphone photo, natural skin texture, slight noise, no retouching, no beauty filter.";

const BASE_CONSTRAINTS = "She is an adult woman. Only she is in focus; no text, logos, brand names or watermark.";
const PHONE_HAND_CONSTRAINT = " One hand holds the phone; only her other hand acts.";

// TODO(pose): "her exact face, facial proportions and hairline" (below,
// where this is used) assumes the face is the visible identity anchor;
// a back-facing pose (once `pose` exists on the plan slot) will need a
// different anchor phrase (hair, build, posture) instead of the face.
const BINDING = "The same woman as in the reference photo,";

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
 * (writerJob.ts / readWriterAnswer): a defense-in-depth last resort, since
 * this is the last engine code to see the text before an image is paid for.
 */
export function assembleSlot(descriptor: AvatarDescriptor, slot: PlanSlot, sentence: string, master: LibraryReference): AssembledScene {
  const youth = youthWords(sentence, "descriptor");
  if (youth.length > 0) throw new AssemblerRefusalError(`the sentence for slot ${slot.slotIndex} still carries a youth word: ${youth.join(", ")}`);
  const revealing = revealingWordsIn(sentence);
  if (revealing.length > 0) throw new AssemblerRefusalError(`the sentence for slot ${slot.slotIndex} still carries a revealing word: ${revealing.join(", ")}`);

  const anchor = promptSubject(descriptor);
  const realism = slot.category === "photoshoot" ? REALISM_EDITORIAL : REALISM_PHONE;
  // TODO(pose): "with her exact face, facial proportions and hairline" hardcodes a face-visible pose (see BINDING's own note above).
  const raw =
    `${BINDING} with her exact face, facial proportions and hairline; ${anchor}. ` +
    `${SHOT_PHRASE[slot.shot]}. ${field(sentence)}. ` +
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
