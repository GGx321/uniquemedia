import { youthWords, type AvatarDescriptor, type CategorySnapshot } from "../../shared/engine";
import { promptSubject } from "../avatars/prompts";
import type { LibraryReference } from "../library/media";
import { categoryStyleOf } from "./categories";
import { revealingWordsIn } from "./words";
import type { Pose, RunSlot, ScenePlan } from "./schema";
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

/**
 * «Реализм камеры» (Settings, off by default): the one fixed clause appended to the END of every image prompt of a run
 * that started with the switch on. The default phrases above already ask for natural skin and no retouching, yet some
 * models still draw too clean («будто кистью нарисовано»); this names the camera artefacts those models leave out. It is a
 * constant in this one place, never built from a descriptor, a sentence or any user text, and it avoids every stop-word.
 */
export const CAMERA_REALISM_CLAUSE =
  "Candid smartphone photo, natural skin texture with pores, slight sensor noise, imperfect natural light, no retouching, no airbrushing.";

/**
 * The same clause for a `photoshoot` slot, whose prompt already says «Editorial photo» (REALISM_EDITORIAL): a camera, not a phone, so
 * the two sentences do not contradict each other (review round 1, M4). Every other category takes CAMERA_REALISM_CLAUSE.
 */
export const CAMERA_REALISM_CLAUSE_EDITORIAL =
  "Shot on a camera, natural skin texture with pores, subtle grain, imperfect natural light, no retouching, no airbrushing.";

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

function constraintsFor(slot: RunSlot): string {
  return BASE_CONSTRAINTS + (phoneInHand(slot.shot) ? PHONE_HAND_CONSTRAINT : "");
}

export interface AssembleOptions {
  /** «Реализм камеры»: append CAMERA_REALISM_CLAUSE (CAMERA_REALISM_CLAUSE_EDITORIAL for an editorial category). Off when absent. */
  cameraRealism?: boolean;
  /** The plan's own category snapshots: a custom category's finish (editorial or phone) is its snapshot's, never the library's. */
  categories?: readonly CategorySnapshot[] | undefined;
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
export function assembleSlot(descriptor: AvatarDescriptor, slot: RunSlot, sentence: string, master: LibraryReference, options: AssembleOptions = {}): AssembledScene {
  const snapshots = options.categories ?? [];
  const [problem] = sentenceProblems(sentence);
  if (problem !== undefined) {
    const kind = problem.reason === "youth-word" ? "a youth word" : "a revealing word";
    throw new AssemblerRefusalError(`the sentence for slot ${slot.slotIndex} still carries ${kind}: ${problem.words.join(", ")}`);
  }

  const anchor = promptSubject(descriptor);
  // A built-in's finish is fixed (the photoshoot is editorial); a custom category's is its snapshot's, never the category library's.
  const editorial = categoryStyleOf(slot.category, snapshots) === "editorial";
  const realism = editorial ? REALISM_EDITORIAL : REALISM_PHONE;
  const raw =
    `${BINDING} ${BINDING_ANCHOR[slot.pose]}; ${anchor}. ` +
    `${SHOT_PHRASE[slot.shot]}. ${POSE_PHRASE[slot.pose]}. ${field(sentence)}. ` +
    `${realism} ${constraintsFor(slot)}`;
  const prompt = normalize(raw);
  // «Реализм камеры» goes last, after normalize, and in the same style as the finish above: a camera for an editorial category (a photoshoot, or a custom
  // category whose snapshot says so), a phone for the rest, so the two sentences never contradict each other.
  const clause = editorial ? CAMERA_REALISM_CLAUSE_EDITORIAL : CAMERA_REALISM_CLAUSE;
  return { slotIndex: slot.slotIndex, prompt: options.cameraRealism === true ? `${prompt} ${clause}` : prompt, references: [master] };
}

/** Assembles every slot of a plan against one sentence map (the writer job's result); throws if any slot has no sentence. `options.categories` are the plan's own snapshots. */
export function assembleRun(descriptor: AvatarDescriptor, scenePlan: { readonly slots: readonly RunSlot[] } & Partial<Omit<ScenePlan, "slots">>, sentences: ReadonlyMap<number, string>, master: LibraryReference, options: AssembleOptions = {}): AssembledScene[] {
  return scenePlan.slots.map((slot) => {
    const sentence = sentences.get(slot.slotIndex);
    if (sentence === undefined) throw new RangeError(`no writer sentence for slot ${slot.slotIndex}`);
    return assembleSlot(descriptor, slot, sentence, master, options);
  });
}
