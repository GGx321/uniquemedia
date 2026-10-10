import { z } from "zod";
import { youthWords } from "../../shared/engine";
import { WRITER_CALL, writerWorstMicros, type Estimate } from "../money/estimate";
import type { PriceBook } from "../money/prices";
import type { ChatMessage } from "../openrouter/types";
import { categoryLabelOf, type CategoryLabelOf } from "./categories";
import { lightOf } from "./phoneLook";
import { PHONE_WORDS } from "./pools";
import type { Shot } from "./types";
import type { PlanSlot, Pose } from "./schema";
import { revealingWordsIn } from "./words";

// T5b: the scene writer, prompt v2. A paid chat call per chunk turns the
// plan's slots (this module never sees the avatar's traits or its free-text
// mood note, only what the seeded planner produced) into one full English
// sentence per slot. The plan's own one-handed-activity filter (planner.ts)
// already keeps every selfie/mirror slot's *given* activity one-handed, but
// the spike found the model's own rewrite adds a two-handed action anyway in
// about half of those slots ("holding a cup of coffee with both hands");
// this module's job is to say so in the prompt AND catch it in the answer.
//
// The chunk size and the retry ceiling (WRITER_CALL.slotsPerCall,
// .maxAttempts) live in money/estimate.ts, not here (review round 3): that
// is the one source of truth both this module and estimateRun's own writer
// term read, so the two cannot drift apart the way they did when this
// module kept its own copy of "25" and "2".

/**
 * Splits `slots` into chunks of at most `WRITER_CALL.slotsPerCall`, in
 * order, nothing dropped or duplicated. Pure position-based slicing (no
 * shuffling): for a given plan, the chunk boundaries are always the same,
 * which is what lets runs/writerPhase.ts's attempt ids
 * (`${runId}:writer-${chunkIndex}#N`) stay stable across a resume (T6).
 * Review round 2: `RunRequest.count` (studio/shared/engine/state.ts) allows
 * 1..100 photos per run, possibly all in one category, so a run's plan can
 * hold far more slots than one call should ever take: a 100-slot prompt
 * floor measured ~30_223 tokens (a 50-slot one ~16_247), and 100 scenes'
 * typical output alone (~130 tokens/scene, WRITER_CALL.typicalPerScene) is
 * ~13_000 tokens, already over WRITER_CALL.maxTokens — and a single call
 * asked to write that many scenes at once is unreliable besides.
 */
export function chunkSlots(slots: readonly PlanSlot[]): PlanSlot[][] {
  const chunks: PlanSlot[][] = [];
  for (let i = 0; i < slots.length; i += WRITER_CALL.slotsPerCall) {
    chunks.push(slots.slice(i, i + WRITER_CALL.slotsPerCall));
  }
  return chunks;
}

// ---------- the model's output ----------

export const WriterSceneSchema = z.strictObject({
  slotIndex: z.int().positive(),
  sentence: z.string().min(1),
});
export type WriterScene = z.infer<typeof WriterSceneSchema>;

export const WriterOutputSchema = z.strictObject({ scenes: z.array(WriterSceneSchema) });
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

/** Structured output: an array of {slotIndex, sentence}, sent as a strict JSON schema. */
export const WRITER_JSON_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: "scene_sentences",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["scenes"],
    properties: {
      scenes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["slotIndex", "sentence"],
          properties: {
            slotIndex: { type: "integer" },
            sentence: { type: "string" },
          },
        },
      },
    },
  },
};

// ---------- the prompt ----------

export const SHOT_LABEL: Record<Shot, string> = {
  friend: "a phone snap a friend took",
  selfie: "her own front-camera selfie",
  mirror: "her mirror selfie",
  candid: "a friend's snap while she is busy",
  photographer: "a phone snap a friend took",
};

/**
 * T5c: how each pose is described to the writer model, so its sentence
 * agrees with the plan's own `pose` (assembler.ts's own fixed phrase per
 * pose is separate — this is only what the writer is told to write around).
 */
export const POSE_LABEL: Record<Pose, string> = {
  front: "facing the viewer",
  "three-quarter": "a three-quarter view, turned slightly from the viewer",
  profile: "in profile, her face turned fully to the side",
  back: "from behind, her face not visible",
};

function writerSystemPrompt(): string {
  return [
    "You write one plain sentence of what an ordinary phone photo of her shows, for each of the given slots, of one recurring adult woman who posts her own photos.",
    "Reference images supply her identity, so you never describe her face, never give her a name, and never describe her hair, eyes or body type.",
    "",
    "For each slot, write exactly one full English sentence (never a fragment) that uses the slot's category, location, time of day, shot type, pose, outfit and activity, and adds natural, concrete detail: what her hands and body do, her expression, and at most one ordinary detail of the place. Do not describe the light, the colours or the mood; if light comes up, name only its source.",
    "",
    "Rules:",
    "- One full sentence per slot, about 25 to 45 words, plain present tense.",
    '- In a front-camera selfie or a mirror selfie, only one hand is free: describe only what that hand does, or say nothing about her hands. Never describe an action that needs both hands in these shots.',
    '- Match each slot\'s pose: for pose "from behind, her face not visible" write the scene from behind — she never looks at, toward or into the viewer, and her face is never described; for pose "in profile, her face turned fully to the side" write her in profile — her face turned to the side, never looking at or toward the viewer. For any other pose she may face or glance toward the viewer as the shot allows.',
    "- In a friend's snap while she is busy, she never looks at the viewer.",
    "- She is a grown adult woman; no children or minors anywhere in the scene, and never a word that suggests she or anyone else is not an adult.",
    "- Describe the outfit exactly as given, in its own words: never more or less revealing, never add or remove a garment. Never name bikini, swimsuit, swimwear, lingerie, sports bra, thong, stockings or a robe over lingerie.",
    "- No text, logos, brand names or readable signs; nothing covers her face.",
    "- Never write about the camera, the lens, the photo, the shot or the framing.",
    "- When she looks toward whoever takes the photo, write that she looks at the viewer; never name a phone, camera or lens for her gaze. Her own phone appears only when the slot's activity uses it.",
    "- No paper, books, magazines, documents, notebooks, menus, maps, desks or studying; no laptops or tablets: her phone is the only screen.",
    "- Never describe mess, clutter or things lying around; the room's state is given separately.",
    "- Never use these words: professional, photographer, photoshoot, studio, editorial, fashion, model, posing, captures, candid, cinematic, bokeh, golden hour, softly lit, soft light, glow, glowing, dramatic, moody, dreamy, elegant, luxurious, lavish, glamorous, chic, sophisticated, polished, pristine, marble, silk, satin, velvet, stunning, beautiful, perfect, flawless, gorgeous, unless the slot's own place, outfit or activity uses it.",
    "",
    'Return JSON matching the schema: {"scenes": [{"slotIndex", "sentence"}, ...]}, exactly one object per slot, in the given order.',
  ].join("\n");
}

function slotForWriter(slot: PlanSlot, labelOf: CategoryLabelOf): Record<string, unknown> {
  return {
    slotIndex: slot.slotIndex,
    category: labelOf(slot.category),
    location: slot.location,
    timeOfDay: lightOf(slot.timeOfDay),
    shot: SHOT_LABEL[slot.shot],
    pose: POSE_LABEL[slot.pose],
    outfit: slot.outfit,
    activity: slot.activity,
  };
}

// ---------- refusal / re-ask feedback ----------

export type WriterProblem =
  | "not-json"
  | "empty"
  | "missing-slots"
  | "unknown-slot"
  | "duplicate-slot"
  | "two-handed"
  | "youth-word"
  | "revealing-word"
  | "pose-contradiction"
  /** S5.R1 M3: a front-camera selfie's sentence names a phone, which would draw a second one. */
  | "phone-in-selfie"
  /** CS.8a: an idea write's shot or pose the model had to pick is missing, outside the vocabulary or an impossible pair (ideaWriter.ts). */
  | "bad-angle";

/** Why an answer was refused, as the next attempt is told: fixed reasons and
 *  slot numbers, never the model's own rejected wording (the youth/revealing
 *  words are ours to name; a slot's rejected sentence never is). */
export interface WriterRefusal {
  problems: WriterProblem[];
  missingSlots: number[];
  twoHandedSlots: number[];
  wordSlots: number[];
  words: string[];
  /** T5c: slots whose sentence contradicts their own pose (e.g. a back pose "looking at the camera"). */
  poseSlots: number[];
  /** S5.R1 M3: selfie slots whose sentence names a phone (`phone-in-selfie`). Absent in every other refusal. */
  phoneSlots?: number[];
  /** CS.8a: idea-write slots whose picked shot or pose was refused (`bad-angle`). Absent in every other refusal. */
  angleSlots?: number[];
}

export const NO_REFUSAL: WriterRefusal = { problems: [], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [] };

/** The refusal a paid answer without content gets: the next attempt is told it was empty. Fresh on every call. */
export function emptyAnswerRefusal(): WriterRefusal {
  return { problems: ["empty"], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [] };
}

/** A refusal tells the model at most this many of the words it used, and each at most this many UTF-8 bytes. */
export const REFUSAL_WORDS_MAX = 6;
export const REFUSAL_WORD_BYTES_MAX = 16;

/** `word` cut to at most `maxBytes` UTF-8 bytes, never in the middle of a character. */
function clipBytes(word: string, maxBytes: number): string {
  let bytes = 0;
  let clipped = "";
  for (const char of word) {
    bytes += Buffer.byteLength(char, "utf8");
    if (bytes > maxBytes) break;
    clipped += char;
  }
  return clipped;
}

/**
 * The words a refusal tells the model about. They are the model's own text (a youth rule quotes what the answer said), so
 * they are bounded: each word clipped, the same word in another case told once (in the spelling it first came in), a word
 * clipped to nothing dropped, and at most REFUSAL_WORDS_MAX of them. The re-ask's prompt is priced on bytes before it is
 * sent, so what the model wrote must never decide how large it can grow.
 */
function toldWords(words: readonly string[]): string[] {
  const told = new Map<string, string>();
  for (const word of words) {
    const clipped = clipBytes(word, REFUSAL_WORD_BYTES_MAX);
    const key = clipped.toLowerCase();
    if (clipped.length > 0 && !told.has(key)) told.set(key, clipped);
  }
  return [...told.values()].slice(0, REFUSAL_WORDS_MAX);
}

function quotedList(words: readonly string[]): string {
  return toldWords(words).map((w) => `"${w}"`).join(", ");
}

/**
 * The slot numbers a reason names, in the order given. A run of consecutive numbers is told as a range («76-100»), so a refusal over a whole chunk costs a few
 * bytes: the re-ask is priced on its bytes before it is sent (S5.R1). The longest list is then every other slot, which the floor pins use.
 */
function slotList(indices: readonly number[]): string {
  const told: string[] = [];
  for (let from = 0; from < indices.length; ) {
    let to = from;
    while (to + 1 < indices.length && indices[to + 1] === (indices[to] as number) + 1) to++;
    told.push(to > from ? `${indices[from]}-${indices[to]}` : String(indices[from]));
    from = to + 1;
  }
  return told.join(", ");
}

const REASON: Partial<Record<WriterProblem, (r: WriterRefusal) => string>> = {
  "not-json": () => 'it was not the JSON object {"scenes": [...]}, one sentence per slot',
  empty: () => "it was empty",
  "missing-slots": (r) => `it was missing a sentence for slot(s) ${slotList(r.missingSlots)}`,
  "unknown-slot": () => "it returned a slotIndex that is not in the plan",
  "duplicate-slot": () => "it returned the same slotIndex more than once",
  "two-handed": (r) => `slot(s) ${slotList(r.twoHandedSlots)} used a two-handed action in a selfie or mirror shot; only one hand is free, so only that hand may act`,
  "youth-word": (r) => `slot(s) ${slotList(r.wordSlots)} used words we do not allow: ${quotedList(r.words)}; call her a woman and use none of them`,
  "revealing-word": (r) => `slot(s) ${slotList(r.wordSlots)} used a revealing word we do not allow: ${quotedList(r.words)}`,
  "pose-contradiction": (r) => `slot(s) ${slotList(r.poseSlots)} contradicted their own pose (a back or profile pose, or a friend's snap while busy, looking toward the camera); match each slot's given pose instead`,
  // No slot list: the re-ask rewrites the whole chunk, and the floor pins hold the reason to one fixed sentence (`phoneSlots` is for the logs and the tests).
  "phone-in-selfie": () => "a selfie sentence named a phone; name none, describe only her free hand",
  "bad-angle": (r) => `slot(s) ${slotList(r.angleSlots ?? [])} gave a shot or a pose that is missing, outside the lists the rules give, or a selfie or mirror shot not facing the camera (front or three-quarter only)`,
};

/** Every reason a refusal happened, as fixed sentences; never the model's own rejected text. */
export function writerRefusalText(refusal: WriterRefusal): string {
  return [...new Set(refusal.problems)].map((p) => REASON[p]?.(refusal) ?? p).join("; ");
}

/**
 * The messages of one writer attempt; `refusal` is why the previous answer was
 * rejected. `labelOf` says what each slot's category is called to the model:
 * by default the five built-ins' fixed names (a custom slot is refused, never
 * sent under a made-up name); a run passes the resolver of its plan's snapshot.
 */
export function writerMessages(slots: readonly PlanSlot[], refusal: WriterRefusal = NO_REFUSAL, labelOf: CategoryLabelOf = categoryLabelOf()): ChatMessage[] {
  const lines = ["Slots:", JSON.stringify(slots.map((slot) => slotForWriter(slot, labelOf)))];
  if (refusal.problems.length > 0) {
    lines.push("", `An earlier answer was rejected: ${writerRefusalText(refusal)}. Write a new answer that follows every rule.`);
  }
  return [
    { role: "system", content: writerSystemPrompt() },
    { role: "user", content: lines.join("\n") },
  ];
}

// ---------- detectors ----------

// revealingWordsIn (a sentence must never describe revealing clothing
// either, the same guard the planner's outfit pool uses) lives in ./words.ts
// now (review round 1, MEDIUM: it was duplicated here and in pools.ts);
// re-exported so callers keep importing it from this module.
export { revealingWordsIn };

/**
 * A verb whose actor is "hands" itself, base/-ing/-s and past forms: hold,
 * grip, pull, tie, cup, clasp, adjust, raise, rest, type, text, carry.
 * Review round 1 (LOW/MEDIUM): the past tense and typing/texting/carrying
 * were missing from the first cut.
 */
const HANDS_VERB =
  "(?:hold(?:ing|s)?|held" +
  "|grip(?:ping|s)?|gripped" +
  "|pull(?:ing|s)?|pulled" +
  "|ty(?:ing|es)?|tied" +
  "|cup(?:ping|s)?|cupped" +
  "|clasp(?:ing|s)?|clasped" +
  "|adjust(?:ing|s)?|adjusted" +
  "|rais(?:ing|es)?|raised" +
  "|rest(?:ing|s)?|rested" +
  "|typ(?:ing|es)?|typed" +
  "|text(?:ing|s)?|texted" +
  "|carry(?:ing)?|carries|carried)";

/**
 * Whether the sentence describes a two-handed action: an explicit "both
 * hands"/"two hands"/"each hand"/"with (both) her hands", or "hands" itself
 * as the grammatical actor of a gripping/adjusting/typing kind of verb.
 * Review round 1 (MEDIUM): the verb must belong to "hands" directly
 * (immediately, an auxiliary such as "are"/"were" aside) — a free
 * proximity window let "holding" match a sentence where it belonged to
 * "her other hand", not to "hands" ("her hands neatly manicured, holding
 * the phone with her other hand"), which would have burned both attempts
 * on a valid one-handed answer.
 */
const TWO_HANDED = new RegExp(
  String.raw`\bboth\s+(?:of\s+her\s+)?hands\b` +
    String.raw`|\btwo\s+hands\b` +
    String.raw`|\beach\s+hand\b` +
    String.raw`|\bwith\s+her\s+hands\b` +
    String.raw`|\busing\s+(?:both\s+)?(?:of\s+)?her\s+hands\b` +
    String.raw`|\bhands\b\s+(?:are\s+|were\s+|'re\s+)?${HANDS_VERB}\b`,
  "i",
);

export function isTwoHanded(sentence: string): boolean {
  return TWO_HANDED.test(sentence);
}

/**
 * What the answer reader needs of a slot: its number, its shot (the phone hand) and its pose. A plan's slot has more; an own scene (CS.4b) has only these,
 * so the same rules read both.
 */
export type ReadableSlot = Pick<PlanSlot, "slotIndex" | "shot" | "pose"> & {
  /** The slot's own activity (or an idea's text), when it has one: a selfie whose own text names a phone may name it in the sentence too (M3). */
  activity?: string | undefined;
};

function phoneInHand(slot: ReadableSlot): boolean {
  return slot.shot === "selfie" || slot.shot === "mirror";
}

/** M3: a front-camera selfie's sentence names a phone the slot's own text did not ask for. A mirror shot may name it: the phone is in the mirror. */
function phoneNamedInSelfie(slot: ReadableSlot, sentence: string): boolean {
  return slot.shot === "selfie" && PHONE_WORDS.test(sentence) && !PHONE_WORDS.test(slot.activity ?? "");
}

/**
 * A sentence describing her looking, gazing, staring, glancing, smiling or
 * peering at/toward/into the camera — cheaply detectable, and the plan's own
 * example of what a back or profile pose's sentence must never say (a
 * back-facing woman cannot be "looking at the camera"; a profile shot's
 * whole point is that her face is turned to the side, not toward it).
 *
 * Round 2 review (MEDIUM): a bare `verb\s+preposition` required the two to
 * sit right next to each other, missing natural writing like "looking over
 * her shoulder at the camera" or "peers at the camera from over her
 * shoulder" — a real paid answer could phrase it exactly that way and slip
 * past the gate. `[^.]{0,25}?` allows a short aside (an "over her shoulder"
 * or "back" between the verb and the preposition) without the sentence
 * boundary, lazily so it only matches as far as it needs to; kept tight (25
 * chars, never crossing a period) because a false positive here costs a
 * paid retry, not just a missed catch.
 *
 * Round 3 review: "not/isn't/is not/never/without/no longer looking at the
 * camera" is a perfectly compliant sentence for a back/profile pose (that
 * IS the pose) — but it contains the bare substring "looking at the
 * camera", so it self-triggered before this negative lookbehind, burning a
 * paid retry on an answer that was already correct. The lookbehind only
 * excludes a negator immediately before the verb (no gap): a negation
 * elsewhere in the sentence, or before some other word, never suppresses a
 * real "looks over her shoulder at the camera" catch (writer.test.ts pins
 * both directions).
 */
const CAMERA_GAZE_VERB = "(?:look(?:ing|s)?|gaz(?:ing|es)?|star(?:ing|es)?|glanc(?:ing|es)?|smil(?:ing|es)?|peer(?:ing|s)?)";
const CAMERA_GAZE_NEGATOR = "(?:not|isn't|is\\s+not|never|without|no\\s+longer)\\s+";
const CAMERA_GAZE = new RegExp(
  `\\b(?<!${CAMERA_GAZE_NEGATOR})${CAMERA_GAZE_VERB}\\b[^.]{0,25}?\\b(?:at|toward|towards|into)\\s+the\\s+(?:camera|viewer|lens)\\b`,
  "i",
);

/**
 * Whether `sentence` contradicts `pose` in a cheaply detectable way (T5c,
 * plan: "reject a sentence that contradicts the pose ... for example a back
 * pose whose sentence says 'looking at the camera'"). Only back and profile
 * carry this rule: front and three-quarter may freely face or glance toward
 * the camera.
 */
export function contradictsPose(sentence: string, pose: Pose, shot?: Shot): boolean {
  // S5.R1 L1: a candid is a friend's snap while she is busy, so she never looks at the viewer, whatever her pose.
  return (pose === "back" || pose === "profile" || shot === "candid") && CAMERA_GAZE.test(sentence);
}

// ---------- reading the answer ----------

/** The JSON of the answer, tolerating a markdown fence around it (mirrors avatars/descriptor.ts). */
function parseJson(content: string): unknown {
  const unfenced = content.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
}

export type WriterAnswer = { ok: true; sentences: Map<number, string> } | ({ ok: false } & WriterRefusal);

function refused(problems: WriterProblem[], extra: Partial<WriterRefusal> = {}): WriterAnswer {
  return { ok: false, problems, missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [], ...extra };
}

/** The model's answer against the plan's slots, or every reason it cannot be used. */
export function readWriterAnswer(content: string, slots: readonly ReadableSlot[]): WriterAnswer {
  const parsed = WriterOutputSchema.safeParse(parseJson(content));
  if (!parsed.success) return refused(["not-json"]);
  return readWriterScenes(parsed.data.scenes, slots);
}

/**
 * The answer's scenes (already parsed) against the slots: the number rules, the words, the phone hand and the pose. Shared by `readWriterAnswer` and the idea
 * write's reader (ideaWriter.ts), which parses a wider scene (the shot and pose the model picked) and hands the sentences here with the angles it settled on.
 */
export function readWriterScenes(scenes: readonly Pick<WriterScene, "slotIndex" | "sentence">[], slots: readonly ReadableSlot[]): WriterAnswer {
  const known = new Map(slots.map((s) => [s.slotIndex, s]));
  const bySlot = new Map<number, string>();
  const problems = new Set<WriterProblem>();

  for (const scene of scenes) {
    if (!known.has(scene.slotIndex)) {
      problems.add("unknown-slot");
      continue;
    }
    if (bySlot.has(scene.slotIndex)) {
      problems.add("duplicate-slot");
      continue;
    }
    bySlot.set(scene.slotIndex, scene.sentence);
  }

  const missingSlots = slots.filter((s) => !bySlot.has(s.slotIndex)).map((s) => s.slotIndex);
  if (missingSlots.length > 0) problems.add("missing-slots");

  const twoHandedSlots: number[] = [];
  const wordSlots = new Set<number>();
  const words = new Set<string>();
  const poseSlots: number[] = [];
  const phoneSlots: number[] = [];
  for (const s of slots) {
    const sentence = bySlot.get(s.slotIndex);
    if (sentence === undefined) continue;
    const youth = youthWords(sentence, "descriptor");
    const revealing = revealingWordsIn(sentence);
    if (youth.length > 0) {
      problems.add("youth-word");
      wordSlots.add(s.slotIndex);
      youth.forEach((w) => words.add(w));
    }
    if (revealing.length > 0) {
      problems.add("revealing-word");
      wordSlots.add(s.slotIndex);
      revealing.forEach((w) => words.add(w));
    }
    if (phoneInHand(s) && isTwoHanded(sentence)) {
      problems.add("two-handed");
      twoHandedSlots.push(s.slotIndex);
    }
    if (contradictsPose(sentence, s.pose, s.shot)) {
      problems.add("pose-contradiction");
      poseSlots.push(s.slotIndex);
    }
    if (phoneNamedInSelfie(s, sentence)) {
      problems.add("phone-in-selfie");
      phoneSlots.push(s.slotIndex);
    }
  }

  if (problems.size > 0) {
    return refused([...problems], {
      missingSlots,
      twoHandedSlots,
      wordSlots: [...wordSlots].sort((a, b) => a - b),
      words: [...words],
      poseSlots,
      ...(phoneSlots.length > 0 ? { phoneSlots } : {}),
    });
  }
  return { ok: true, sentences: bySlot };
}

// ---------- pricing (item 3: for T6's run estimate to add) ----------

/**
 * The writer's own worst/expected cost from the price book. Worst case:
 * delegates to money/estimate.ts's `writerWorstMicros` — the exact same
 * helper `estimateRun`'s own writer term calls — so this can never drift
 * from the run estimate again (review round 3: it once multiplied by the
 * chunk count alone, without WRITER_CALL.maxAttempts, and `estimateRun`
 * fixed that but this function did not; writer.test.ts's own drift-guard
 * test pins that the two agree). Expected: unaffected by chunking or
 * attempts, at `slotCount` × the spike's measured per-scene token counts
 * (money/estimate.ts's own WRITER_CALL, which this module only reads: it
 * never re-declares or edits it).
 */
export function writerRunPrice(book: PriceBook, slotCount: number): Estimate {
  if (!Number.isInteger(slotCount) || slotCount < 0) {
    throw new RangeError(`slotCount must be a non-negative integer, got ${slotCount}`);
  }
  const expectedMicros = book.chatCost({
    model: WRITER_CALL.model,
    images: WRITER_CALL.images,
    inputTokens: WRITER_CALL.typicalPerScene.inputTokens * slotCount,
    outputTokens: WRITER_CALL.typicalPerScene.outputTokens * slotCount,
  });
  return { expectedMicros, worstMicros: writerWorstMicros(book, WRITER_CALL, slotCount), priceSource: book.source };
}
