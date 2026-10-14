import { z } from "zod";
import { ClipMotionChoice, MOTION_LABEL_MAX } from "./clips";
import { Micros } from "./primitives";
import { assertMicros } from "./usd";

// Stage 5, 5b.2 part C «свои движения» (S5.WC1; plan s5b2 §5.3, I5.66-I5.68; Q-H = 2): the contract of the vision motion writer and of «Своя идея». Pure: zod and `shared/engine/*` only.
//
//  - `clips.estimateSuggest` / `clips.suggestMotions`: the vision writer looks at ONE photo (at most 1024 px, never the master) and suggests up to three small motions, each already checked like a bank motion.
//  - `clips.estimateIdea` / `clips.translateIdea`: the owner writes one idea in Russian (1-300 characters, no control character); the translator turns it into an English motion of at most 60 characters or
//    refuses it with closed `MotionProblem`s. On a frame of «Смелая» only (Q-H = 2) an idea that takes clothing off is accepted; its prompt then carries «Nothing new appears.» alone. Elsewhere it is `takes-off`.
//  - the owner's idea text exists only in the `translateIdea` payload and in the engine's memory while the call runs (I5.67). The clip commands carry motion ids only.
//
// The guard, both ways (r2.1 N10; the engine binds, the sheet only mirrors it):
//  - `suggestMotions` and `translateIdea` answer IN_FLIGHT `clip-busy` while a clip or a batch holds the clip money unit, so no chat line enters a clip's proof window;
//  - `clips.create` and `clips.createBatch` answer IN_FLIGHT `motion-busy` while ANY part C call runs (any avatar, any photo; critic decision, 2026-10-15), so no clip baseline is read while a chat reserve is open;
//  - one call per photo at a time: `suggest-busy` for a second `suggestMotions`, `idea-busy` for a second `translateIdea`.
//
// How the window shows a call's cost (`costMicros` on every result): «бесплатно» only when `costMicros === 0` (a moderation 4xx is free); a mixed paid-then-moderation `none` has a cost above 0 and shows
// «оплачено $X»; a cost above 0 shows as at least $0.001 (`motionCostShownMicros`, then `formatUsdTiered(…, "nearest")`). A price ceiling shows in three decimals, rounded up (`formatUsdTiered(…, "up")`).

// ---------- the numbers ----------

/** A call has at most two model attempts: the second runs only if the first answer was unusable, and its feedback is closed problem codes (I5.68). */
export const MOTION_MAX_ATTEMPTS = 2;

/** The owner's idea: 1 to this many characters. */
export const OWN_IDEA_MAX = 300;

/** What a photo's motion store keeps at most, suggestions and ideas together; the oldest go first (FIFO). */
export const MOTION_STORE_MAX_ITEMS = 12;

/** The label of an own idea whose words cannot be shown (a recovered clip whose store item is gone). */
export const OWN_IDEA_FALLBACK_LABEL = "Своя идея";

// Micro-dollars per call, from plan s5b2 §5.3 «Money per call». The worst case is two attempts. The engine's live estimate (`clips.estimateSuggest` / `clips.estimateIdea`) is the price the owner accepts; these are the
// design figures the mock, the mockups and the tests share. Ceilings show in three decimals, rounded up: «до $0.013» and «до $0.005».
export const MOTION_SUGGEST_EXPECTED_MICROS = 3_400;
export const MOTION_SUGGEST_WORST_MICROS = 12_500;
export const MOTION_TRANSLATE_EXPECTED_MICROS = 1_000;
export const MOTION_TRANSLATE_WORST_MICROS = 5_000;

/** A paid call below this shows as this (the window never says «$0.000» for money that was spent). */
export const MOTION_MIN_SHOWN_MICROS = 1_000;

/** What the window shows as a call's cost: 0 stays 0 («бесплатно»), any other cost shows as at least `MOTION_MIN_SHOWN_MICROS`. */
export function motionCostShownMicros(costMicros: number): number {
  assertMicros(costMicros);
  return costMicros === 0 ? 0 : Math.max(costMicros, MOTION_MIN_SHOWN_MICROS);
}

// ---------- the owner's idea ----------

/**
 * The owner's idea as the window sends it: 1 to 300 characters, not blank, no control character (a newline too: the window replaces line breaks with spaces before it sends), no line or paragraph separator and
 * no broken surrogate. It reaches the translator as JSON data and is never stored or logged (I5.67).
 */
export const OwnIdeaText = z
  .string()
  .min(1)
  .max(OWN_IDEA_MAX)
  .refine((text) => text.trim().length > 0, "an idea must not be blank")
  .refine((text) => /^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}]*$/u.test(text), "an idea must not hold control characters or broken surrogates");
export type OwnIdeaText = z.infer<typeof OwnIdeaText>;

const LABEL_ROOM = MOTION_LABEL_MAX - 1;
const TRAILING_PUNCTUATION = /[\s,;:.!?\-–—]+$/u;

/** The longest prefix of whole code points that fits, so a surrogate pair is never split. */
function hardCut(text: string, room: number): string {
  let out = "";
  for (const char of text) {
    if (out.length + char.length > room) break;
    out += char;
  }
  return out;
}

/**
 * The label of an own idea: his words, cut by WORD to at most 40 characters with a trailing «…» (the engine makes it, so the I5.67 canary check and the window agree; plan s5b2 §5.3, mockup 63a).
 * The rule, in order:
 *  1. runs of white space become one space and the edges are trimmed; a blank text gets `OWN_IDEA_FALLBACK_LABEL`;
 *  2. a text of at most 40 characters is its own label, untouched;
 *  3. else the whole words that fit in 39 characters (the «…» is the 40th) are kept, then a trailing word of one or two letters (a preposition, a conjunction) is dropped while another word remains,
 *     then trailing punctuation and spaces are cut, then «…» is added;
 *  4. a first word longer than 39 characters is cut hard at 39 (never inside a surrogate pair).
 * «медленно поворачивает голову, прислушиваясь к шуму за окном» → «медленно поворачивает голову…»; «медленно греет ладони о кружку, глядя в окно» → «медленно греет ладони о кружку, глядя…».
 */
export function ownIdeaLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return OWN_IDEA_FALLBACK_LABEL;
  if (flat.length <= MOTION_LABEL_MAX) return flat;
  const kept: string[] = [];
  let length = 0;
  for (const word of flat.split(" ")) {
    const next = kept.length === 0 ? word.length : length + 1 + word.length;
    if (next > LABEL_ROOM) break;
    kept.push(word);
    length = next;
  }
  if (kept.length === 0) return `${hardCut(flat, LABEL_ROOM)}…`;
  while (kept.length > 1 && (kept[kept.length - 1] ?? "").replace(/[^\p{L}\p{N}]/gu, "").length <= 2) kept.pop();
  const cut = kept.join(" ").replace(TRAILING_PUNCTUATION, "");
  return cut === "" ? `${hardCut(flat, LABEL_ROOM)}…` : `${cut}…`;
}

// ---------- the frame reading ----------

/**
 * What the vision writer noticed about the frame, marks only: it never refuses, changes no price and no camera line (I5.68).
 * - capture-differs: «Камера в кадре не такая, как в сцене».
 * - second-phone: «В кадре виден второй телефон — он может остаться в клипе».
 */
export const CLIP_FRAME_NOTES = ["capture-differs", "second-phone"] as const;
export const ClipFrameNote = z.enum(CLIP_FRAME_NOTES);
export type ClipFrameNote = z.infer<typeof ClipFrameNote>;

export const ClipFrameReading = z
  .strictObject({ notes: z.array(ClipFrameNote).max(CLIP_FRAME_NOTES.length) })
  .refine((r) => new Set(r.notes).size === r.notes.length, { message: "a note appears once", path: ["notes"] });
export type ClipFrameReading = z.infer<typeof ClipFrameReading>;

// ---------- why an idea was refused ----------

/**
 * The closed reasons the translator refuses an idea, IN THE ORDER the window shows them: a rejection lists its problems in this order and the window shows the text of the first (mockups 63b-63c).
 * - not-motion: the idea holds no movement. - content: words not fit for this frame. - takes-off: it takes clothing off, and the frame is not «Смелая» (Q-H = 2). - staging: it changes the camera or the cut.
 * - phone: it names a phone the frame does not allow. - face-hidden: it acts with a face the frame does not show. - two-movements: more than one movement. - not-small: a big or fast movement.
 * - too-long: too detailed for a clip (more than 60 characters, or a prompt over 130 words). The Russian texts are `MOTION_PROBLEMS_RU`.
 */
export const MOTION_PROBLEMS = ["not-motion", "content", "takes-off", "staging", "phone", "face-hidden", "two-movements", "not-small", "too-long"] as const;
export const MotionProblem = z.enum(MOTION_PROBLEMS);
export type MotionProblem = z.infer<typeof MotionProblem>;

/** One to nine problems, each once, in `MOTION_PROBLEMS` order. */
export const MotionProblems = z
  .array(MotionProblem)
  .min(1)
  .max(MOTION_PROBLEMS.length)
  .refine((problems) => problems.every((problem, i) => i === 0 || MOTION_PROBLEMS.indexOf(problems[i - 1] ?? problem) < MOTION_PROBLEMS.indexOf(problem)), {
    message: "the problems are listed once each, in the fixed display order",
  });
export type MotionProblems = z.infer<typeof MotionProblems>;

// ---------- the results ----------

/** A suggestion is a vision motion with a `v-<n>` id. */
const SuggestedMotion = ClipMotionChoice.refine((m) => m.source === "vision", { message: "a suggestion has the source `vision`", path: ["source"] });
/** The new item of a translation is an own motion with an `o-<n>` id. */
const OwnMotion = ClipMotionChoice.refine((m) => m.source === "own", { message: "a translated idea has the source `own`", path: ["source"] });

/**
 * What `clips.suggestMotions` answers. Every result carries `costMicros`, what the call cost (0 = free).
 * - ok: one to three checked suggestions (also stored under the photo; `v-<n>` ids, unique) and the frame reading (marks only).
 * - none: nothing usable came out. Free when the model refused the frame (a moderation 4xx), paid after an unusable answer; a mixed case shows the paid sum.
 */
export const ClipSuggestResult = z.discriminatedUnion("outcome", [
  z
    .strictObject({ outcome: z.literal("ok"), motions: z.array(SuggestedMotion).min(1).max(3), reading: ClipFrameReading, costMicros: Micros })
    .refine((r) => new Set(r.motions.map((m) => m.id)).size === r.motions.length, { message: "a motion id must not repeat", path: ["motions"] }),
  z.strictObject({ outcome: z.literal("none"), costMicros: Micros }),
]);
export type ClipSuggestResult = z.infer<typeof ClipSuggestResult>;

/**
 * What `clips.translateIdea` answers. Every result carries `costMicros`.
 * - ok: the new own item (`o-<n>`, label of at most 40 characters = `ownIdeaLabel`, English text of at most 60), stored under the photo; the window selects it.
 * - none: no usable answer (the model refused, or nothing could be read). Free (0) after a moderation 4xx, paid otherwise.
 * - rejected: the answer failed the checks after at most one repair; `problems` is non-empty, unique and in `MOTION_PROBLEMS` order, and the call is paid (the model answered).
 */
export const ClipTranslateResult = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("ok"), item: OwnMotion, costMicros: Micros }),
  z.strictObject({ outcome: z.literal("none"), costMicros: Micros }),
  z.strictObject({ outcome: z.literal("rejected"), problems: MotionProblems, costMicros: Micros }),
]);
export type ClipTranslateResult = z.infer<typeof ClipTranslateResult>;
