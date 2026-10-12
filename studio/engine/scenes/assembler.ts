import type { AvatarDescriptor } from "../../shared/engine";
import { promptSubject } from "../avatars/prompts";
import type { LibraryReference } from "../library/media";
import { captureOfShot, type Capture } from "../../shared/scenes/captures";
import { contentProblems, type ContentProblem } from "../../shared/scenes/contentLine";
import { FEET_MOMENT_WORDS, GLANCE_BACK_WORDS, notDenimClause, unfabricBottomsIn } from "../../shared/scenes/words";
import { artefactLine, captureLineOf, CONSTRAINTS, hairLine, imperfectionOf, isLampMood, lightOf, MIRROR_BACK_LINE, phoneHandLineOf, roomStateOf, slotKeyOf, type RoomPlace } from "./phoneLook";
import type { SlotLook } from "./roomPlace";
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
export type SentenceProblem = ContentProblem;

/**
 * Every rule a sentence breaks before it may go into an image prompt: a youth word, a revealing word (the youth words first). S5.9b1: the check is the
 * shared content line (`contentProblems`); this is its "ordinary" reading, the one the LLM-path callers and the tests keep naming.
 */
export function sentenceProblems(sentence: string): SentenceProblem[] {
  return contentProblems(sentence, "ordinary");
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

/**
 * 5a.2 (S5.6b): a frame with the phone over her face (`mirror-hidden`) does not claim her face is clearly visible; it says which way her body is turned. Only
 * front and three-quarter occur: a hand-held capture faces the phone.
 */
export const HIDDEN_FACE_POSE_PHRASE: Record<Pose, string> = {
  front: "Her body is turned toward the mirror, her face behind her phone",
  "three-quarter": "Her body is turned to a three-quarter angle toward the mirror, her face behind her phone",
  profile: "She is seen in profile, her face behind her phone",
  back: "Photographed from behind, her face not visible",
};

/**
 * Back or side to the mirror (the approved T42 composition): she stands or sits in profile to the mirror. The capture line already says the phone hides her face and
 * MIRROR_BACK_LINE that only her reflection is in the picture, so the pose phrase says only which way her body is turned.
 */
export const MIRROR_BACK_POSE_PHRASE = "Her body is in profile to the mirror";

/**
 * C3′ (the Grok probe c3fix 4b): glancing back over her shoulder, her face turns to the camera at three-quarter, even under «Photographed from behind, her face not
 * visible». A photo taken from a distance (someone she asked, a candid, the timer) of such a moment says so: half from behind at three-quarter (the banks hold a glance
 * back to three-quarter, so the face gate judges it like any three-quarter frame), and from behind with her head turned back on a custom back slot (`faceVisibleOf`
 * says no for a back pose, so the gate marks it). A self-shot keeps its own capture line.
 */
export const THREE_QUARTER_BACK_POSE_PHRASE = "Seen half from behind, her face turned back to a three-quarter angle, clearly visible";
export const BACK_GLANCE_POSE_PHRASE = "Photographed from behind, her head turned back over her shoulder, her face in profile";
const DISTANT_CAPTURES: readonly Capture[] = ["friend", "candid", "timer"];

/**
 * «Ножки» (S5.8a, plan s5a2 §7.2): a legs frame says what fills it, not which way she is turned. Her legs and feet fill most of the frame and her face may be out of it, so the
 * phrase claims no face and no orientation, whatever the capture or the pose.
 */
export const LEGS_POSE_PHRASE = "Her legs fill most of the frame; her face may be out of frame.";

const BINDING = "The same woman as in the reference photo,";

/** Binding for a frame without her face (plan r1.5 §5.4): the face binding is dropped; her hair, build and skin tone carry the likeness. */
export const NO_FACE_ANCHOR = "with the exact hair colour and hair length from the reference photo, her build and skin tone";

/** The frames whose face the phone or her own legs hide (`captures.ts` faceVisibleOf, by capture): the binding is NO_FACE_ANCHOR. A back pose keeps its own, as it always did. */
const FACELESS_CAPTURES: readonly Capture[] = ["mirror-hidden", "pov-legs"];

/** The captures that get the body binding when the avatar has a body (plan r1.5 §5.4, review S5.6b #8: her hips and legs are in the over-the-shoulder frame); the close self-shots from above and the selfie do not. */
const BODY_BINDING_CAPTURES: readonly Capture[] = ["mirror-hidden", "mirror", "prone", "over-shoulder", "timer", "friend", "candid", "pov-legs", "low-feet"];

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

/**
 * Stage 5, S5.2c: joins the reference binding when the avatar has a body and the shot shows more than her face and arm (not a selfie), so the model keeps the
 * body the descriptor names. Never on a selfie, never without a body: such a prompt is byte-identical to the one before Stage 5.
 */
const BODY_BINDING = ", and her exact body proportions as described";

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

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * C3′ (the owner's verdict, 2026-10-12): Grok draws a skirt or shorts named without its fabric as denim. The banks name every fabric (banks/schema.ts); a custom
 * pool's outfit, the writer's and an idea's may not, so the prompt says the probe's «her shorts are not denim» (c3fix 3a): right after the slot's outfit and
 * whatever runs on with it (« with {legwear}») when the sentence carries it word for word, else as a sentence of its own after the scene's. A slot with a stored
 * outfit is judged by that outfit alone (review: «playing mini golf» elsewhere in the sentence is no skirt); an own scene, which stores none, by its sentence.
 * The stored sentence is untouched; only the prompt says it.
 */
function withNotDenim(sentence: string, outfit: string | undefined): string {
  const bottoms = unfabricBottomsIn(outfit ?? sentence);
  if (bottoms.length === 0) return sentence;
  const clause = notDenimClause(bottoms);
  const at = outfit === undefined ? -1 : sentence.indexOf(outfit);
  if (outfit === undefined || at < 0) return `${sentence}. ${capitalise(clause)}`;
  const rest = sentence.slice(at + outfit.length);
  const runOn = rest.search(/[,.;]/);
  const end = at + outfit.length + (runOn < 0 ? rest.length : runOn);
  return `${sentence.slice(0, end)}, ${clause}${sentence.slice(end)}`;
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

function constraintsFor(capture: Capture): string {
  const hand = phoneHandLineOf(capture);
  return hand === null ? CONSTRAINTS : `${CONSTRAINTS} ${hand}`;
}

/** Who took the photo: the slot's capture, or (a slot stored before captures, an own scene) the one its stored shot says. */
function captureOfRunSlot(slot: RunSlot): Capture {
  return "capture" in slot && slot.capture !== undefined ? slot.capture : captureOfShot(slot.shot);
}

export interface AssembleOptions {
  /** The run's id: with the slot's attempt id base it seeds the slot's look draws (the imperfection, the room state), so a resume assembles the same prompt (I5.4). */
  runId: string;
  /** «Реализм камеры»: the artefact line carries the camera-roll artefacts and the imperfection. Off when absent. */
  cameraRealism?: boolean;
  /** The place of a slot as the room draw reads it, or null for none (an own scene, a renamed place). Absent: no slot gets a room phrase. */
  roomPlaceOf?: (slot: RunSlot) => RoomPlace | null;
  /**
   * 5a.2: the marks of the slot's place and moment the look reads: a lamp place (the lamp mood at evening and night, I5.34) and a back-to-the-mirror moment
   * (the «only her reflection» sentence). Injected like the room lookup; absent: neither applies.
   */
  lookOf?: (slot: RunSlot) => SlotLook | null;
  /** 5a.2: the slot's hairstyle as it reads after «Today her hair is …» (shared/scenes/hair.ts hairstyleSequence), or null for no hair line. Absent: none. */
  hairStyleOf?: (slot: RunSlot) => string | null;
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
  const [problem] = contentProblems(sentence, "ordinary");
  if (problem !== undefined) {
    const kind = problem.reason === "youth-word" ? "a youth word" : "a revealing word";
    throw new AssemblerRefusalError(`the sentence for slot ${slot.slotIndex} still carries ${kind}: ${problem.words.join(", ")}`);
  }

  const anchor = promptSubject(descriptor);
  const key = slotKeyOf(options.runId, slot.attemptIdBase);
  const capture = captureOfRunSlot(slot);
  // An own scene has no stored time (the writer's sentence carries its light) and no place, so it gets the neutral light and no room phrase.
  const timeOfDay = isOwnSlot(slot) ? undefined : slot.timeOfDay;
  const light = lightOf(timeOfDay);
  const room = roomStateOf(key, options.roomPlaceOf?.(slot) ?? null);
  const look = options.lookOf?.(slot) ?? null;
  // «Ножки» (S5.8a): a legs slot has its own pose phrase, the body binding whatever the shot, and no hair line (her legs fill the frame, not her hair).
  const legs = !isOwnSlot(slot) && slot.framing === "legs";
  const artefact = artefactLine({ cameraRealism: options.cameraRealism === true, light, imperfection: imperfectionOf(slot.shot, key, legs), lampMood: isLampMood(look, timeOfDay) });
  const hairStyle = legs ? null : (options.hairStyleOf?.(slot) ?? null);
  const faceless = FACELESS_CAPTURES.includes(capture);
  const glancesBack = !isOwnSlot(slot) && DISTANT_CAPTURES.includes(capture) && GLANCE_BACK_WORDS.test(slot.activity);
  const glancePhrase = !glancesBack ? null : slot.pose === "three-quarter" ? THREE_QUARTER_BACK_POSE_PHRASE : slot.pose === "back" ? BACK_GLANCE_POSE_PHRASE : null;
  const posePhrase = legs ? LEGS_POSE_PHRASE : capture === "mirror-hidden" ? (look?.mirrorBack === true ? MIRROR_BACK_POSE_PHRASE : HIDDEN_FACE_POSE_PHRASE[slot.pose]) : (glancePhrase ?? POSE_PHRASE[slot.pose]);
  const bindingAnchor = faceless ? NO_FACE_ANCHOR : BINDING_ANCHOR[slot.pose];
  // S5.6R: a friend's photo of a moment about her feet shows her whole body (an own scene has no stored moment: the line its key draws).
  const wholeBody = !isOwnSlot(slot) && FEET_MOMENT_WORDS.test(slot.activity);
  const scene = withNotDenim(field(sentence), isOwnSlot(slot) ? undefined : slot.outfit);
  const raw =
    `${captureLineOf(capture, key, { wholeBody })} ${look?.mirrorBack === true ? `${MIRROR_BACK_LINE} ` : ""}${posePhrase}. ${scene}. ` +
    (room === null ? "" : `${room} `) +
    `${BINDING} ${bindingAnchor}${descriptor.body !== undefined && (legs || BODY_BINDING_CAPTURES.includes(capture)) ? BODY_BINDING : ""}; ${anchor}. ` +
    (hairStyle === null ? "" : `${hairLine(hairStyle)} `) +
    `${artefact} ${constraintsFor(capture)}`;
  return { slotIndex: slot.slotIndex, prompt: normalize(raw), references: [master] };
}

/**
 * 5a.2 (S5.6d, plan s5a2 §5.5): one slot of a run as the assembler leaves it. A slot whose sentence breaks today's youth or revealing word rules is not a defect of
 * the run: it ends alone (`slot-text-problem`), free, before any image is paid for, and the other slots go on.
 */
export type AssembledSlot = ({ ok: true } & AssembledScene) | { ok: false; slotIndex: number; reason: "slot-text-problem"; problems: SentenceProblem[] };

/** The scenes among a run's per-slot results, in order. */
export function assembledScenes(results: readonly AssembledSlot[]): AssembledScene[] {
  return results.flatMap((result) => (result.ok ? [{ slotIndex: result.slotIndex, prompt: result.prompt, references: result.references }] : []));
}

/**
 * Assembles every slot of a plan against one sentence map (the writer job's result), one result per slot in plan order. A sentence that breaks the word rules
 * is that slot's `slot-text-problem` result; a slot with no sentence at all is a defect and throws.
 */
export function assembleRun(descriptor: AvatarDescriptor, scenePlan: { readonly slots: readonly RunSlot[] } & Partial<Omit<ScenePlan, "slots">>, sentences: ReadonlyMap<number, string>, master: LibraryReference, options: AssembleOptions): AssembledSlot[] {
  return scenePlan.slots.map((slot): AssembledSlot => {
    const sentence = sentences.get(slot.slotIndex);
    if (sentence === undefined) throw new RangeError(`no writer sentence for slot ${slot.slotIndex}`);
    const problems = contentProblems(sentence, "ordinary");
    if (problems.length > 0) return { ok: false, slotIndex: slot.slotIndex, reason: "slot-text-problem", problems };
    return { ok: true, ...assembleSlot(descriptor, slot, sentence, master, options) };
  });
}
