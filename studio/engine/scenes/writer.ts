import { z } from "zod";
import { isBoldFrame } from "../../shared/engine";
import { contentLevelOf, contentProblems, type ContentLevel } from "../../shared/scenes/contentLine";
import { bankPlaceOf } from "../../shared/scenes/bankLookup";
import { boldWordsIn } from "../../shared/scenes/banks/boldRules";
import { captureOfShot, type Capture } from "../../shared/scenes/captures";
import { exposureWordsIn } from "../../shared/scenes/explicitWords";
import { slotCoverageOf } from "../../shared/scenes/template";
import { ownerBannedOutfitWords } from "../../shared/scenes/words";
import { WRITER_CALL, writerCallOf, writerExpectedMicros, writerWorstMicros, type Estimate, type WriterMode } from "../money/estimate";
import type { PriceBook } from "../money/prices";
import type { ChatMessage } from "../openrouter/types";
import { categoryLabelOf, type CategoryLabelOf } from "./categories";
import { lightOf } from "./phoneLook";
import { PHONE_WORDS, SELFIE_WORDS } from "./pools";
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
  selfie: "her own arm's-length photo",
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
    "- In an arm's-length photo or a mirror selfie, only one hand is free: describe only what that hand does, or say nothing about her hands. Never describe an action that needs both hands in these shots.",
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

// C1: a custom category's label is LLM-written and sent as every slot's category, and the writer is told to use it. A selfie slot's sentence may not name a
// phone or say selfie (phone-in-selfie), so those words never reach it through the label; bytes only shrink.
const SELFIE_LABEL_WORDS = new RegExp(`${PHONE_WORDS.source}|${SELFIE_WORDS.source}`, "gi");

/** The category label as a selfie slot is told it: without the phone and selfie words, «everyday» when nothing is left. */
function labelForSelfie(label: string): string {
  const cleaned = label.replace(SELFIE_LABEL_WORDS, " ").replace(/\s+/g, " ").trim();
  return cleaned === "" ? "everyday" : cleaned;
}

function slotForWriter(slot: PlanSlot, labelOf: CategoryLabelOf): Record<string, unknown> {
  const label = labelOf(slot.category);
  return {
    slotIndex: slot.slotIndex,
    category: slot.shot === "selfie" ? labelForSelfie(label) : label,
    location: slot.location,
    timeOfDay: lightOf(slot.timeOfDay),
    shot: SHOT_LABEL[slot.shot],
    pose: POSE_LABEL[slot.pose],
    outfit: slot.outfit,
    activity: slot.activity,
  };
}

// ---------- the bold mode (5a.4, S5.BA4, plan s5a4 §5.3.3) ----------

// A custom category's «Смелая» frames are written in a mode of their own: a sibling system prompt and slot JSON. The ordinary prompt above stays byte for byte
// (writer.bold.test.ts pins its every byte, the floor pins its length). What the paid probe P-BA (2026-10-26) found the drafts did wrong is fixed in what the model
// is FED, not only in what it is told: the model pasted the slot's labels into its prose («facing the viewer», «captured in her own photo from above», «set in the
// world of …», «morning daylight»), so in this mode the pose goes out as its bare name, the time of day as a plain word with no light in it, the shot as a short
// capture label the prompt says never to write, and the category label (which names the public world the slot must stay out of) not at all.

/**
 * r2.2 P1: what the bold writer is told of who takes the photo, one label per capture. The stored shot hides two things the sentence must know: a timer is stored
 * on the friend shot, and a mirror-hidden frame would not say that her phone covers her face. Each label is at most 33 characters, today's longest `SHOT_LABEL`,
 * so the worst chunk does not grow; a self-shot is «her own photo …» or a «mirror selfie», the words the one-hand rule names.
 */
export const CAPTURE_LABEL: Readonly<Record<Capture, string>> = Object.freeze({
  "mirror-hidden": "mirror selfie, phone covers face",
  mirror: "her mirror selfie",
  above: "her own photo from above",
  prone: "her own photo, on her stomach",
  "over-shoulder": "her own photo over her shoulder",
  selfie: "her own photo at arm's length",
  "pov-legs": "her own photo down her legs",
  // S5.BA4b (P-BW, P1r#1:17): the phone is propped up, so it is in neither hand.
  timer: "phone propped on a timer, alone",
  friend: "a phone snap a friend took",
  candid: "a friend's snap while she is busy",
  "low-feet": "a friend's photo low at her feet",
});

/** The stored times as the bold writer is told them: when, never how it is lit (the light lines of `lightOf` were pasted as «daylight»), and never a soft-list word. */
const TIME_WORDS: ReadonlyMap<string, string> = new Map([
  ["morning", "morning"],
  ["midday", "midday"],
  ["golden hour", "late afternoon"],
  ["evening", "evening"],
  ["night", "night"],
  ["studio lighting", "indoors"],
]);

/** A stored time of day as a plain word for the bold writer; «any time» for a time the table does not know (the ordinary writer's neutral light, in words). */
export function timeWordOf(time: string): string {
  return TIME_WORDS.get(time) ?? "any time";
}

function writerBoldSystemPrompt(): string {
  return [
    "You write one plain sentence of what an ordinary phone photo of her shows, for each of the given slots, of one recurring adult woman who posts her own photos.",
    "Reference images supply her identity, so you never describe her face, never give her a name, and never describe her hair, eyes or body type.",
    "",
    'A slot with a world is a private moment of hers at home or where she is staying. The world is the place her day belongs to: set the location inside it (her hotel room in that city, the cabin of that boat, the balcony over that view) and add one ordinary detail that ties the photo to it, a different one in each slot: the view through her window, flowers in a glass, a small souvenir she brought back, never a paper bag. Unless the location is by the water, she is never in a public place, such as the world\'s cafe, restaurant, bar, street, shop, office, gym, beach or marina. Never join her location and the world with "at", "in" or "on" ("her room at the restaurant"): the world shows only as its city, its boat, its view or something she brought back. By the water she is at the world\'s own water place, in her swimwear. A slot without a world keeps its location as given.',
    "",
    "For each slot, write exactly one full English sentence (never a fragment) that uses the slot's location, world, time of day, outfit and activity, and adds natural, concrete detail: what her hands and body do, her expression, and that one ordinary detail. The shot and the pose tell you who takes the photo and how she is turned: keep to them, but never write them, and never write the words world or slot. Do not describe the light, the colours or the mood; if light comes up, name only its source.",
    "",
    "Rules:",
    "- One full sentence per slot, about 25 to 45 words, plain present tense.",
    '- Write "she", then the activity word for word in one piece with its commas, then "wearing" and the outfit word for word: no word goes inside either; the location goes before "she", every other detail after the outfit.',
    "- In her own photo or a mirror selfie, only one hand is free: describe only what that hand does, or say nothing about her hands. Never describe an action that needs both hands in these shots. On a timer both of her hands are empty.",
    "- When her face is hidden, describe neither her face nor her gaze.",
    '- Match each slot\'s pose: "back" has her back to the viewer, she never looks at, toward or into the viewer, and her face is never described; "profile" has her face turned fully to the side, never looking at or toward the viewer; "front" and "three-quarter" may face or glance toward the viewer as the shot allows.',
    "- In a friend's snap while she is busy, she never looks at the viewer.",
    "- She is a grown adult woman; no children or minors anywhere in the scene, and never a word that suggests she or anyone else is not an adult.",
    "- Describe the outfit exactly as given, in its own words: never more or less revealing, never add or remove a garment.",
    "- Never write naked, nude, topless, nipples, see-through or transparent, and call nothing sheer the outfit does not.",
    "- No text, logos, brand names or readable signs; nothing but her phone covers her face.",
    "- Never write about the camera, the lens, the photo, the shot, the timer or the framing, and never say selfie or snap.",
    "- When she looks toward whoever takes the photo, write that she looks at the viewer; never name a phone, camera or lens for her gaze. Her own phone appears only when the slot's activity uses it.",
    "- No paper, books, magazines, documents, notebooks, menus, maps, desks or studying; no laptops or tablets: her phone is the only screen.",
    "- Never describe mess, clutter or things lying around; the room's state is given separately.",
    "- Never use these words: professional, photographer, photoshoot, studio, editorial, fashion, model, posing, captures, candid, cinematic, bokeh, golden hour, softly lit, soft light, glow, glowing, dramatic, moody, dreamy, elegant, luxurious, lavish, glamorous, chic, sophisticated, polished, pristine, marble, silk, satin, velvet, stunning, beautiful, perfect, flawless, gorgeous, unless the slot's own place, outfit or activity uses it.",
    "",
    'Return JSON matching the schema: {"scenes": [{"slotIndex", "sentence"}, ...]}, exactly one object per slot, in the given order.',
  ].join("\n");
}

/** A slot as the bold writer is told it: no category, the world when it has one, a plain time word, the capture label, the pose's own name. */
function boldSlotForWriter(slot: PlanSlot): Record<string, unknown> {
  return {
    slotIndex: slot.slotIndex,
    location: slot.location,
    ...(slot.world === undefined ? {} : { world: slot.world }),
    timeOfDay: timeWordOf(slot.timeOfDay),
    shot: CAPTURE_LABEL[slot.capture ?? captureOfShot(slot.shot)],
    pose: slot.pose,
    outfit: slot.outfit,
    activity: slot.activity,
  };
}

/**
 * 5a.4 (S5.BA4, plan s5a4 §5.3.4 «The mode», r2.1 L3, I5.77): the mode a writer chunk is asked, priced and reserved in, from the slots it sends the model: bold
 * when ANY of them is a «Смелая» frame (`isBoldFrame`: on the Seedream route, or of «Ночнушки и бельё» or «Пляж и бассейн»), ordinary otherwise. A new
 * request's chunk is bold exactly at «Смелая» (its custom slots are routed); an old set's chunk is bold when it holds such a frame the template no longer writes
 * (nightwear's cotton after Q-A2), and then every slot of it is written in bold mode, each held to its own content level. A chunk of only the five's old flirty
 * slots or old custom slots stays ordinary.
 */
export function writerModeOf(slots: readonly Pick<PlanSlot, "category" | "route">[]): WriterMode {
  return slots.some((slot) => isBoldFrame({ category: slot.category, route: slot.route })) ? "bold" : "ordinary";
}

// ---------- refusal / re-ask feedback ----------

export type WriterProblem =
  | "not-json"
  | "empty"
  | "missing-slots"
  /** No longer raised by the reader (5a.2, S5.6d: an item for a slot nobody asked about is dropped). Kept so a refusal built by hand keeps its reason, and the floor pins still measure the longest text. */
  | "unknown-slot"
  | "duplicate-slot"
  | "two-handed"
  | "youth-word"
  | "revealing-word"
  | "pose-contradiction"
  /** S5.R1 M3: a front-camera selfie's sentence names a phone, which would draw a second one. */
  | "phone-in-selfie"
  /** CS.8a: an idea write's shot or pose the model had to pick is missing, outside the vocabulary or an impossible pair (ideaWriter.ts). */
  | "bad-angle"
  | BoldProblem;

/**
 * 5a.4 (S5.BA4, plan s5a4 §5.3.3 «The reader»): what only the bold mode's reader refuses (`readBoldWriterAnswer`). Each belongs to its slot: the slot is marked and
 * asked again with a fixed reason, the others are kept.
 * - `place-missing`: a slot with a world names none of its place's words (`PLACE_KEYS`): she was not set in the slot's location.
 * - `outfit-missing`: a garment of the slot's outfit is not named: the outfit was not described as given.
 * - `exposure-word`: an exposure word (`explicitWords.ts`): what Seedream refuses to draw, so a frame the owner would not get (I5.76).
 * - `label-word` (P-BA): the camera, the photo, the light or a slot label pasted into the prose («captured in her own photo from above», «morning daylight», «set in
 *   the world of …»).
 * - `public-place` (P-BA W2:2): a slot with a world put in a public place of it («in the seafood restaurant»); by the water its beach is her place.
 * - `moment-split` (P-BA W1:2, W2:2): «she» and the bank moment are not there word for word and in one piece, which the clip's «Как в сцене» needs (frameFacts.ts).
 */
export const BOLD_PROBLEMS = ["place-missing", "outfit-missing", "exposure-word", "label-word", "public-place", "moment-split"] as const;
export type BoldProblem = (typeof BOLD_PROBLEMS)[number];
/** The two bold problems whose refusal names the words it found (from our lists, never the model's sentence). */
export type WordedBoldProblem = "label-word" | "public-place";
/** What the bold reader finds in one slot's sentence: a problem, with the words it found for the two that name them. */
type BoldFinding = Exclude<BoldProblem, WordedBoldProblem> | { problem: WordedBoldProblem; words: readonly string[] };

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
  /** 5a.4 (S5.BA4): the slots of each bold problem, ascending. Absent in every refusal the bold reader did not make. */
  boldSlots?: Partial<Record<BoldProblem, number[]>>;
  /**
   * S5.BA4 round 2 (review LOW): the words `label-word` and `public-place` found, as our lists write them (lower case), told back the way the youth and revealing
   * words are: at most REFUSAL_WORDS_MAX, each clipped to REFUSAL_WORD_BYTES_MAX bytes. Never the model's sentence.
   */
  boldWords?: Partial<Record<WordedBoldProblem, string[]>>;
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

/** «: "w1", "w2"» for a bold reason that found words, nothing for one that did not (a refusal built by hand). */
function toldOf(words: readonly string[] | undefined): string {
  return words === undefined || words.length === 0 ? "" : `: ${quotedList(words)}`;
}

/**
 * The slot numbers a reason names, in the order given. A run of consecutive numbers is told as a range («76-100»), so a refusal over a whole chunk costs a few
 * bytes: the re-ask is priced on its bytes before it is sent (S5.R1). Commas carry no space, for the same reason. The longest list over a set of numbers is not «every other
 * one» (a pair, a gap, a pair is dearer per slot): the floor pins find it exactly (scenes/testing/worstSlotList.ts).
 */
export function slotList(indices: readonly number[]): string {
  const told: string[] = [];
  for (let from = 0; from < indices.length; ) {
    let to = from;
    while (to + 1 < indices.length && indices[to + 1] === (indices[to] as number) + 1) to++;
    told.push(to > from ? `${indices[from]}-${indices[to]}` : String(indices[from]));
    from = to + 1;
  }
  return told.join(",");
}

const REASON: Partial<Record<WriterProblem, (r: WriterRefusal) => string>> = {
  "not-json": () => 'it was not the JSON object {"scenes": [...]}, one sentence per slot',
  empty: () => "it was empty",
  "missing-slots": (r) => `it was missing a sentence for slot(s) ${slotList(r.missingSlots)}`,
  "unknown-slot": () => "it returned a slotIndex that is not in the plan",
  "duplicate-slot": () => "it returned the same slotIndex more than once",
  "two-handed": (r) => `slot(s) ${slotList(r.twoHandedSlots)} used a two-handed action in a selfie or mirror shot; only one hand is free`,
  "youth-word": (r) => `slot(s) ${slotList(r.wordSlots)} used words we do not allow: ${quotedList(r.words)}; call her a woman and use none of them`,
  "revealing-word": (r) => `slot(s) ${slotList(r.wordSlots)} used a revealing word we do not allow: ${quotedList(r.words)}`,
  "pose-contradiction": (r) => `slot(s) ${slotList(r.poseSlots)} contradicted their pose or shot by looking toward the camera; match each slot's given pose`,
  // No slot list: the re-ask rewrites the whole chunk, and the floor pins hold the reason to one fixed sentence (`phoneSlots` is for the logs and the tests).
  "phone-in-selfie": () => "a selfie sentence named a phone or said selfie; name none, describe only her free hand",
  "bad-angle": (r) => `slot(s) ${slotList(r.angleSlots ?? [])} gave a shot or a pose that is missing, outside the lists the rules give, or a selfie or mirror shot not facing the camera (front or three-quarter only)`,
  // 5a.4 (S5.BA4): the bold reader's own, each a fixed sentence with its slot numbers; never a word of the sentence it refused.
  "place-missing": (r) => `slot(s) ${slotList(r.boldSlots?.["place-missing"] ?? [])} did not say where she is: name the slot's location, set inside its world`,
  // S5.BA4b (P-BW): where the outfit goes, the order rule's own words.
  "outfit-missing": (r) => `slot(s) ${slotList(r.boldSlots?.["outfit-missing"] ?? [])} left out the outfit: write "wearing" and then the outfit word for word right after the activity`,
  "exposure-word": (r) => `slot(s) ${slotList(r.boldSlots?.["exposure-word"] ?? [])} named nudity: describe only what the outfit shows`,
  "label-word": (r) => `slot(s) ${slotList(r.boldSlots?.["label-word"] ?? [])} wrote a word of the camera, the light or the slot's labels${toldOf(r.boldWords?.["label-word"])}; write none of them`,
  "public-place": (r) => `slot(s) ${slotList(r.boldSlots?.["public-place"] ?? [])} put her in a public place${toldOf(r.boldWords?.["public-place"])}; keep her in the slot's location`,
  "moment-split": (r) => `slot(s) ${slotList(r.boldSlots?.["moment-split"] ?? [])} did not write "she" and then the activity word for word, in one piece`,
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
  return messagesOf(writerSystemPrompt(), slots.map((slot) => slotForWriter(slot, labelOf)), refusal, ORDINARY_REASK);
}

/**
 * 5a.4 (S5.BA4, plan s5a4 §5.3.3): the messages of one attempt in bold mode, a chunk that holds a «Смелая» frame (`writerModeOf`). Its own system prompt and
 * slot JSON; the refusal is fed back exactly as the ordinary one is. It needs no label resolver: the bold slot carries no category.
 */
export function writerBoldMessages(slots: readonly PlanSlot[], refusal: WriterRefusal = NO_REFUSAL): ChatMessage[] {
  return messagesOf(writerBoldSystemPrompt(), slots.map(boldSlotForWriter), refusal, BOLD_REASK);
}

/** What a re-ask asks for after the reasons: the ordinary writer's, byte for byte. */
const ORDINARY_REASK = "Write a new answer that follows every rule.";
/** S5.BA4b (P-BW): the bold re-ask broke the moment in 12 of 24 and 5 of 6 slots, so it asks for the order rule's three parts by name. */
const BOLD_REASK = 'Write a new answer that follows every rule, with "she", the activity and the outfit word for word in every sentence.';

function messagesOf(system: string, slots: readonly Record<string, unknown>[], refusal: WriterRefusal, reask: string): ChatMessage[] {
  const lines = ["Slots:", JSON.stringify(slots)];
  if (refusal.problems.length > 0) {
    lines.push("", `An earlier answer was rejected: ${writerRefusalText(refusal)}. ${reask}`);
  }
  return [
    { role: "system", content: system },
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
 *
 * 5a.4 (S5.BA4, plan s5a4 §5.3.3 «The reader»): a planned slot also hands over its «Смелая» marker (category, level, route), so its sentence is held to its
 * own content level (`contentLevelOf`): a «Смелая» frame to the youth words alone, everything else to today's rule. A slot without a category (an own
 * scene) reads at ordinary, the stricter level, so a caller that leaves the marker out refuses more, never less.
 */
export type ReadableSlot = Pick<PlanSlot, "slotIndex" | "shot" | "pose"> & Partial<Pick<PlanSlot, "category" | "level" | "route">>;

/** The content level a slot's sentence is held to: its own (`contentLevelOf`), or ordinary for a slot without a category. */
function contentLevelOfSlot(slot: ReadableSlot): ContentLevel {
  return slot.category === undefined ? "ordinary" : contentLevelOf({ category: slot.category, level: slot.level, route: slot.route });
}

function phoneInHand(slot: ReadableSlot): boolean {
  return slot.shot === "selfie" || slot.shot === "mirror";
}

/**
 * M3: a selfie's sentence names a phone. The phone is the camera, so a phone in the sentence is the second one, whatever the slot's activity. C1: the same
 * for the words «selfie» and «front camera», which draw a phone on their own. A mirror shot may name it: the phone is in the mirror.
 */
function phoneNamedInSelfie(slot: ReadableSlot, sentence: string): boolean {
  return slot.shot === "selfie" && (PHONE_WORDS.test(sentence) || SELFIE_WORDS.test(sentence));
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
// 5a.2 (S5.6d): «into the phone» is a gaze into the lens in its own right (a selfie's phone is the camera), so it is a phrase of its own and not a fourth
// noun after «at|toward|into the». «at the phone» stays allowed: a look down at her own phone is a slot's activity, not a gaze at the viewer.
const CAMERA_GAZE_TARGET = "(?:(?:at|toward|towards|into)\\s+the\\s+(?:camera|viewer|lens)|into\\s+the\\s+phone)\\b";
const CAMERA_GAZE = new RegExp(`\\b(?<!${CAMERA_GAZE_NEGATOR})${CAMERA_GAZE_VERB}\\b[^.]{0,25}?\\b${CAMERA_GAZE_TARGET}`, "i");

/**
 * Whether `sentence` contradicts `pose` in a cheaply detectable way (T5c,
 * plan: "reject a sentence that contradicts the pose ... for example a back
 * pose whose sentence says 'looking at the camera'"). Back and profile carry
 * this rule, and so does a candid whatever its pose (S5.R1 L1: in a friend's
 * snap while she is busy she never looks at the viewer); the other shots with
 * a front or three-quarter pose may freely face or glance toward the camera.
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

/**
 * 5a.2 (S5.6d, plan s5a2 §5.5): what a refusal that belongs to some slots leaves for the next attempt. The `marked` slots (in the slot list's order) are asked
 * again with the refusal's reason; the `accepted` ones passed every rule and are kept. A refusal of the answer as a whole carries no repair: nothing is kept
 * and the next attempt is the whole chunk.
 */
export interface SlotRepair {
  accepted: Map<number, string>;
  marked: number[];
}

export type WriterAnswer = { ok: true; sentences: Map<number, string> } | ({ ok: false } & WriterRefusal & { repair?: SlotRepair });

// ---------- the bold reader's own checks (5a.4, S5.BA4) ----------

/**
 * r2.2 P8: the words that say a slot's place, by the shared «rooms» bank's place name: the place itself, or what the world calls it (on a yacht her room is a
 * cabin, her window a porthole, her balcony the deck). Pinned by writer.bold.test.ts, one row per «rooms» place.
 */
export const PLACE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "her room": ["room", "bedroom", "suite", "cabin", "chalet", "bed"],
  "her bathroom": ["bathroom", "shower", "bath", "tub", "mirror"],
  // S5.BA4 round 2 (review LOW, the controller's amendment to P8): a window moment says the pane or the sill, a sofa may be a daybed or a settee.
  "her window": ["window", "porthole", "pane", "sill", "windowsill"],
  "her balcony": ["balcony", "terrace", "deck", "veranda"],
  "her sofa": ["sofa", "couch", "living room", "lounge", "daybed", "settee"],
});

/** The words that say a «by the water» place (every place of that bank is a water place, `BankPlace.water`). */
export const WATER_PLACE_KEYS: readonly string[] = Object.freeze(["water", "pool", "sea", "beach", "shore", "lake", "bay", "deck", "sundeck", "lounger"]);

/** Whether `text` says `phrase` as whole words, in any case, its plural too («beds», «porthole»s). */
function saysWord(text: string, phrase: string): boolean {
  const words = phrase.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?:s|es)?(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * The garments the reader knows besides the «Смелая» vocabulary (banks/boldRules.ts `boldWordsIn`: the lingerie, the swimwear, the stockings and the satin), one
 * pattern each, singular and plural: the satin nightwear's and the covers' (the towel, the sheet, the foam), and the everyday ones an old set's unrouted slot may
 * wear. An outfit word in neither («set», «slip», «lace») asks nothing of the sentence.
 */
const GARMENTS: readonly RegExp[] = [
  /\bcamis?\b/i,
  /\bshorts\b/i,
  /\bnightdress(?:es)?\b/i,
  /\brobes?\b/i,
  /\bshirts?\b/i,
  /\bsweatshirts?\b/i,
  /\bt-shirts?\b/i,
  /\btees?\b/i,
  /\btops?\b/i,
  /\bjeans\b/i,
  /\bsarongs?\b/i,
  /\bhats?\b/i,
  /\btowels?\b/i,
  /\b(?:bed)?sheets?\b/i,
  /\bfoam\b/i,
  /\bdress(?:es)?\b/i,
  /\bskirts?\b/i,
  /\btrousers\b/i,
  /\bleggings\b/i,
  /\bsweaters?\b/i,
  /\bjumpers?\b/i,
  /\bcardigans?\b/i,
  /\bhoodies?\b/i,
  /\bjackets?\b/i,
  /\bcoats?\b/i,
  /\bblouses?\b/i,
];

/** A «Смелая» vocabulary word in its forms: itself, with its plural «s», or without it («bras», «panty» for «panties» aside: the banks say «panties»). */
const formsOf = (word: string): string[] => [word, `${word}s`, word.replace(/s$/, "")];

/** Whether `outfit` names a garment that `sentence` does not: a «Смелая» vocabulary word, or one of `GARMENTS`. */
function missesAGarment(outfit: string, sentence: string): boolean {
  const said = new Set(boldWordsIn(sentence).map((word) => word.toLowerCase()));
  if (boldWordsIn(outfit).some((word) => !formsOf(word.toLowerCase()).some((form) => said.has(form)))) return true;
  return GARMENTS.some((garment) => garment.test(outfit) && !garment.test(sentence));
}

/**
 * P-BA: the words of the slot's labels that the drafts pasted into the prose, and only those (review LOW, S5.BA4 round 2): who takes the photo and how (the capture
 * labels' selfie, snap and timer, «captured», the camera and its lens), the light line the ordinary writer feeds («daylight»), the pose's own name, and the slot's
 * field names; review round 3 adds the capture label's phrases («her own photo», «in the timer shot», «photo from above»), S5.BA4b the pose code («facing
 * front»). The light named by its source (sunlight, sunshine, lamplight), a frame of the view, a framed photo on the wall and a shot of espresso are not leaks;
 * her phone and the viewer are the gaze rule's own words (on a timer her phone is one: `boldProblemsOf`).
 */
const LABEL_WORDS = /\b(?:daylight|captured|selfies?|snaps?|timers?|cameras?|lens(?:es)?|three-quarter|worlds?|slots?|her own photo|(?:in|on) the (?:\w+ )?shot(?!\s+(?:glass|of)\b)|photo from above|fac(?:es|ing) front)\b/gi;

/** The label words of a sentence, as it writes them. */
function labelWordsIn(sentence: string): string[] {
  return Array.from(sentence.matchAll(LABEL_WORDS), (m) => m[0]);
}

/** The public places of a world: where she must never be in her underwear. */
const PUBLIC_NOUNS =
  "caf(?:e|é)s?|coffee\\s+shops?|restaurants?|bistros?|brasseries?|bars?|pubs?|(?:night)?clubs?|streets?|sidewalks?|shops?|stores?|boutiques?|markets?|malls?|offices?|gyms?|parks?|plazas?|squares?|stations?|airports?|museums?|galler(?:y|ies)|lobb(?:y|ies)|librar(?:y|ies)|bakery|bakeries";
/** The shore's public places, public anywhere but a water slot's own water place (below). */
const SHORE_NOUNS = "beach(?:es)?|marinas?|harbou?rs?|piers?|promenades?|boardwalks?";
/**
 * Review round 3, LOW: what a water slot (the water branch, in swimwear) is at, its world's own water place: the beach and the marina here (the pool, the lido, the
 * sea and the lake are no public noun at all; the beach club is read apart, `waterVenue`). The harbour, the pier, the promenade and the boardwalk stay public:
 * when in doubt, refuse.
 */
const WATER_SLOT_NOUNS = "harbou?rs?|piers?|promenades?|boardwalks?";
const DETERMINER = "(?:the|a|an|this|that|her|its|one)";

/**
 * Where a sentence names a public place (S5.BA4 round 2, review M2 and its LOWs), three forms, each with the noun it names: where she is («in», «at», «on»,
 * «inside», «into», «outside»), a part of the place («the window of the seafood restaurant», «a table of the bistro»), and the place's own («the restaurant's
 * window»). Two words between at most.
 */
const placeForms = (nouns: string): RegExp[] => [
  new RegExp(String.raw`\b(?:in|at|on|inside|into|outside)\s+(?:${DETERMINER}\s+)?(?:[\w'-]+\s+){0,2}?(?<noun>${nouns})\b`, "gi"),
  new RegExp(String.raw`\b(?:window|table|terrace|counter|corner|door|doorway|entrance|seat|booth|patio|bar)s?\s+of\s+(?:${DETERMINER}\s+)?(?:[\w'-]+\s+){0,2}?(?<noun>${nouns})\b`, "gi"),
  new RegExp(String.raw`\b(?:the|a|an|this|that)\s+(?:[\w'-]+\s+){0,2}?(?<noun>${nouns})(?='s\b)`, "gi"),
];
const PUBLIC_FORMS = placeForms(`${PUBLIC_NOUNS}|${SHORE_NOUNS}`);
const PUBLIC_FORMS_BY_THE_WATER = placeForms(`${PUBLIC_NOUNS}|${WATER_SLOT_NOUNS}`);
/** A public noun right after the one a form found («the beach club restaurant»): the place is that one, whatever excuses the first. */
const NEXT_PUBLIC = new RegExp(String.raw`^\s+(?<next>${PUBLIC_NOUNS})\b`, "i");

/** The heads that make a public noun before them a modifier, no place she is in: a private place of hers (the beach house, the hotel suite) or a thing she has. */
const OWN_HEAD =
  /^(?:'s\s+(?:[\w-]+\s+)?|\s+)(?:house|home|cottage|villa|apartment|flat|suite|room|bedroom|cabin|box|bag|tote|basket|cup|towel|umbrella|hat|bottle|receipt|treats?|pastr(?:y|ies)|flowers|bouquet)\b/i;
/** Review round 3: a club or a resort is hers only as where her own room is: «her suite at the beach club», «her room at the beach resort». */
const CLUB_OR_RESORT = /^\s+(?:club|resort)s?\b/i;
const HER_ROOM_BEFORE = /\b(?:suite|room|villa|cabin|bungalow)\s+$/i;
/** Review round 3: she is back from it, «after» or «following» a visit of hers right before it (after time at a cafe terrace, after a stop at a bakery). */
const BACK_FROM = /\b(?:after|following)\s+(?:(?:a|her|the)\s+)?(?:time|stop|stopping|visit|lunch|dinner|drinks|swim|walk|coffee|day|evening|morning|night)\s*$/i;
/**
 * Review round 3: time spent there, and only as past: «spent the morning at the cafe terrace», «back from a day at the museum», «after an evening in the bar».
 * «Spending the evening at the bar» is the present: she is there (the final check).
 */
const TIME_SPENT = /\b(?:after|following|back\s+from|spent)\s+(?:(?:a|an|her|the|this)\s+)?(?:morning|evening|afternoon|lunch|dinner|drinks|coffee|day)\s*$/i;
/**
 * Something she brought back from it, then where it stands, with «on» only: «a paper bag from the bakery on a side street». «At» or «in» after it name where she is
 * («a croissant from the bakery at the cafe terrace»), and a bare «from» excuses nothing («waving from her table at the cafe»).
 */
const THING_FROM =
  /\b(?:bag|box|cup|tote|basket|bottle|receipt|treats?|pastr(?:y|ies)|flowers|bouquet|croissants?|macarons?|takeaway|shell|souvenirs?)\s+from\s+(?:(?:the|a|an)\s+)?(?:[\w'-]+\s+){0,2}$/i;
/** The final check: the harbour right after the yacht, the boat or the deck is where the yacht lies («on the deck of the yacht in the harbour»), not where she is. */
const YACHT_IN_HARBOUR = /\b(?:yachts?|boats?|decks?)\s+$/i;
const HARBOUR = /^harbou?rs?$/i;
/** A view of it: she looks «out» or «down» at it. */
const A_VIEW = /\b(?:out|down)\s*$/i;

/** What `publicPlacesIn` weighs a sentence against: whether the slot is by the water (the water branch). */
interface PlaceContext {
  water: boolean;
}

/** A water slot's own beach club: «by the pool at the beach club». */
const waterVenue = (matched: string): boolean => /\bbeach\s+clubs?$/i.test(matched);

/**
 * The public places a slot's sentence puts her in, the noun of each, lower-cased; none when it only names one. When in doubt, refuse (review round 3): a false
 * refusal costs one re-ask, a lingerie frame in a cafe breaks the owner's first rule. The world of her category is only the background: naming it while the
 * sentence also names her room excuses nothing. Not a place she is in:
 * - a modifier: a public noun before a private place or a thing (the beach house, a bakery box, a market tote), or joined by a hyphen (beach-house,
 *   street-facing); a club or a resort only right after her own room («her suite at the beach club»);
 * - where she came back from: «after» or «following» a visit of hers just before it (after time at a cafe terrace, after stopping at a bakery), time spent
 *   there as past («having spent the morning at the cafe terrace», «back from a day at the museum»), and a place named right after one of those (at a bakery on
 *   a side street); a thing she brought from it, then where it stood with «on» (a paper bag from the bakery on a side street);
 * - where the yacht lies: the harbour right after the yacht, the boat or the deck;
 * - a view: «out at the street».
 * These read only where she is: a part of the place or the place's own (the restaurant's window) is public whatever comes before it. A public noun right after an
 * excused one is counted («the beach club restaurant»). By the water the beach, the marina and the beach club are her place (`water`).
 */
function publicPlacesIn(sentence: string, place: PlaceContext): string[] {
  const found: string[] = [];
  for (const [index, form] of (place.water ? PUBLIC_FORMS_BY_THE_WATER : PUBLIC_FORMS).entries()) {
    const whereSheIs = index === 0;
    let backFromEnd = -1;
    for (const match of sentence.matchAll(form)) {
      const noun = match.groups?.["noun"] ?? "";
      const start = match.index;
      const end = start + match[0].length;
      const before = sentence.slice(0, start);
      const after = sentence.slice(end);
      // Her own room's club or resort: excused, unless a public noun follows it («her suite at the beach club bar»).
      const club = whereSheIs && /^at\b/i.test(match[0]) && HER_ROOM_BEFORE.test(before) ? CLUB_OR_RESORT.exec(after) : null;
      const next = NEXT_PUBLIC.exec(club === null ? after : after.slice(club[0].length))?.groups?.["next"];
      if (next !== undefined) {
        found.push(next.toLowerCase());
        continue;
      }
      if (club !== null || /^-\w/.test(after) || OWN_HEAD.test(after)) continue;
      if (whereSheIs && place.water && waterVenue(match[0])) continue;
      if (whereSheIs && HARBOUR.test(noun) && YACHT_IN_HARBOUR.test(before)) continue;
      const atOrIn = /^(?:at|in)\b/i.test(match[0]);
      if (BACK_FROM.test(before) || (whereSheIs && atOrIn && TIME_SPENT.test(before)) || (backFromEnd >= 0 && sentence.slice(backFromEnd, start).trim() === "")) {
        backFromEnd = end;
        continue;
      }
      // A thing she brought from it excuses only where it came from, with «on», and lends that to no place after it.
      if (whereSheIs && /^on\b/i.test(match[0]) && THING_FROM.test(before)) continue;
      if (whereSheIs && A_VIEW.test(before)) continue;
      found.push(noun.toLowerCase());
    }
  }
  return found;
}

/** The bank moment's text without the punctuation a stored text may end with (the plain sentence's and frameFacts.ts's `trimmed`). */
const momentText = (text: string): string => text.trim().replace(/[\s.,;:!]+$/, "");

/** Whether `sentence` says «she {moment}» word for word: in any case, its commas included, as a phrase of its own (frameFacts.ts `says`). */
function saysMoment(sentence: string, moment: string): boolean {
  const phrase = `she ${momentText(moment)}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${phrase}(?![\\p{L}\\p{N}])`, "iu").test(sentence);
}

/**
 * The bold problems of one slot's sentence. `place-missing` and `public-place` read only a slot with a world (an old set's slot without one keeps its location as
 * given, r2.1 L3); `moment-split` reads a slot whose activity is a bank moment; the outfit, the exposure and the label words read every slot of the chunk. A word
 * the slot's own texts say is never held against it.
 */
function boldProblemsOf(slot: PlanSlot, sentence: string): BoldFinding[] {
  const problems: BoldFinding[] = [];
  const own = [slot.location, slot.activity, slot.outfit, slot.world ?? ""].join(" ");
  const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
  const water = hit?.place.water === true;
  const keys = hit === undefined ? [] : water ? WATER_PLACE_KEYS : (PLACE_KEYS[hit.place.name] ?? []);
  if (slot.world !== undefined && keys.length > 0 && !keys.some((key) => saysWord(sentence, key))) problems.push("place-missing");
  if (missesAGarment(slot.outfit, sentence)) problems.push("outfit-missing");
  if (exposureWordsIn(sentence).some((word) => !saysWord(own, word))) problems.push("exposure-word");
  const labels = labelWordsIn(sentence).filter((word) => !saysWord(own, word));
  // S5.BA4b (P-BW, P1r#1:17): on a timer the phone is the camera, propped up; a phone in the sentence is one in her hand, unless the slot's own texts name it.
  if ((slot.capture ?? captureOfShot(slot.shot)) === "timer" && PHONE_WORDS.test(sentence) && !PHONE_WORDS.test(own)) labels.push("phone");
  if (labels.length > 0) problems.push({ problem: "label-word", words: labels.map((word) => word.toLowerCase()) });
  const places = slot.world === undefined ? [] : publicPlacesIn(sentence, { water });
  if (places.length > 0) problems.push({ problem: "public-place", words: places });
  if (hit?.moment !== undefined && !saysMoment(sentence, hit.moment.text)) problems.push("moment-split");
  return problems;
}

function refused(problems: WriterProblem[], extra: Partial<WriterRefusal> & { repair?: SlotRepair } = {}): WriterAnswer {
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
 *
 * 5a.2 (S5.6d) classifies what it finds. An item for a slot nobody asked about is dropped (no problem). A youth word is a problem of the whole answer. Everything
 * else belongs to a slot (a missing or repeated slot, a two-handed or phone-naming sentence, a pose contradiction, a revealing word): that slot is marked and the
 * sentences of the other slots are kept (`repair`).
 */
export function readWriterScenes(scenes: readonly Pick<WriterScene, "slotIndex" | "sentence">[], slots: readonly ReadableSlot[]): WriterAnswer {
  return readScenes(scenes, slots);
}

/**
 * 5a.4 (S5.BA4, plan s5a4 §5.3.3 «The reader»): a bold-mode answer against its chunk's planned slots. Today's rules, each slot at its own content level, and the
 * bold problems (`boldProblemsOf`), each of its slot: the slot is marked and asked again, the others are kept.
 */
export function readBoldWriterAnswer(content: string, slots: readonly PlanSlot[]): WriterAnswer {
  const parsed = WriterOutputSchema.safeParse(parseJson(content));
  if (!parsed.success) return refused(["not-json"]);
  return readScenes(parsed.data.scenes, slots, boldProblemsOf);
}

/**
 * 5a.4 (S5.BA4, plan s5a4 §5.3.3 «After the read», I5.74): the bold mode's reader. It reads the model's sentences (`readBoldWriterAnswer`), then appends to every
 * sentence it accepts the coverage sentence of the slot's outfit by the avatar's origin, exactly as the template and the plain sentence append it: the kept,
 * restrictive one for an imported avatar or one of unknown origin (`impliedNudity` false, the default), the open one (or none) for a Studio-created avatar. Once:
 * a sentence is read, and so covered, in one attempt only (a refusal's kept sentences now; a slot asked again in the next attempt).
 */
export function boldReader(impliedNudity = false): (content: string, slots: readonly PlanSlot[]) => WriterAnswer {
  return (content, slots) => {
    const read = readBoldWriterAnswer(content, slots);
    const bySlot = new Map(slots.map((slot) => [slot.slotIndex, slot]));
    const covered = (sentences: ReadonlyMap<number, string>): Map<number, string> =>
      new Map(
        [...sentences].map(([slotIndex, sentence]) => {
          const slot = bySlot.get(slotIndex);
          const coverage = slot === undefined ? undefined : slotCoverageOf(slot, impliedNudity);
          return [slotIndex, coverage === undefined ? sentence : `${withFullStop(sentence)} ${coverage}`];
        }),
      );
    if (read.ok) return { ok: true, sentences: covered(read.sentences) };
    return read.repair === undefined ? read : { ...read, repair: { ...read.repair, accepted: covered(read.repair.accepted) } };
  };
}

/** The sentence with its closing full stop (a sentence the model ended without one), so the coverage reads as the next sentence. */
const withFullStop = (sentence: string): string => {
  const trimmed = sentence.trimEnd();
  return /[.!?]["')\]]*$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** `readWriterScenes`, with the bold problems of each slot when `boldOf` is given (the bold mode). */
function readScenes<S extends ReadableSlot>(scenes: readonly Pick<WriterScene, "slotIndex" | "sentence">[], slots: readonly S[], boldOf?: (slot: S, sentence: string) => readonly BoldFinding[]): WriterAnswer {
  const known = new Map(slots.map((s) => [s.slotIndex, s]));
  const bySlot = new Map<number, string>();
  const repeated = new Set<number>();
  const problems = new Set<WriterProblem>();

  for (const scene of scenes) {
    // An item for a slot nobody asked about is dropped: it costs the answer nothing.
    if (!known.has(scene.slotIndex)) continue;
    if (bySlot.has(scene.slotIndex)) {
      problems.add("duplicate-slot");
      repeated.add(scene.slotIndex);
      continue;
    }
    bySlot.set(scene.slotIndex, scene.sentence);
  }

  const missingSlots = slots.filter((s) => !bySlot.has(s.slotIndex)).map((s) => s.slotIndex);
  if (missingSlots.length > 0) problems.add("missing-slots");

  const twoHandedSlots: number[] = [];
  const wordSlots = new Set<number>();
  const revealingSlots = new Set<number>();
  const words = new Set<string>();
  const poseSlots: number[] = [];
  const phoneSlots: number[] = [];
  const boldSlots: Partial<Record<BoldProblem, number[]>> = {};
  const boldWords: Partial<Record<WordedBoldProblem, Set<string>>> = {};
  for (const s of slots) {
    const sentence = bySlot.get(s.slotIndex);
    if (sentence === undefined) continue;
    // 5a.4 (S5.BA4): the content line at the slot's own level. At ordinary it is today's pair (the youth words, then the revealing words); at «Смелая» the
    // youth words alone, its garment names exempt.
    const content = contentProblems(sentence, contentLevelOfSlot(s));
    const youth = content.find((p) => p.reason === "youth-word")?.words ?? [];
    // S5.6R: the owner's denim shorts and skirts are refused as a revealing word under our name for them, so the reason and the word cap are the ones the floor pins measure.
    // They are the owner's own ban, not a content line: refused at every level.
    const revealing = [...(content.find((p) => p.reason === "revealing-word")?.words ?? []), ...ownerBannedOutfitWords(sentence)];
    if (youth.length > 0) {
      problems.add("youth-word");
      wordSlots.add(s.slotIndex);
      youth.forEach((w) => words.add(w));
    }
    if (revealing.length > 0) {
      problems.add("revealing-word");
      wordSlots.add(s.slotIndex);
      revealingSlots.add(s.slotIndex);
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
    for (const finding of boldOf?.(s, sentence) ?? []) {
      const problem = typeof finding === "string" ? finding : finding.problem;
      problems.add(problem);
      (boldSlots[problem] ??= []).push(s.slotIndex);
      if (typeof finding !== "string") for (const word of finding.words) (boldWords[finding.problem] ??= new Set()).add(word);
    }
  }

  if (problems.size === 0) return { ok: true, sentences: bySlot };
  const refusal: Partial<WriterRefusal> = {
    missingSlots,
    twoHandedSlots,
    wordSlots: [...wordSlots].sort((a, b) => a - b),
    words: [...words],
    poseSlots,
    ...(phoneSlots.length > 0 ? { phoneSlots } : {}),
    ...(Object.keys(boldSlots).length > 0 ? { boldSlots } : {}),
    ...(Object.keys(boldWords).length > 0 ? { boldWords: Object.fromEntries(Object.entries(boldWords).map(([problem, found]) => [problem, [...found]])) } : {}),
  };
  // A youth word is the answer's, not a slot's: nothing is kept and the next attempt is the whole chunk.
  if (problems.has("youth-word")) return refused([...problems], refusal);
  const markedSet = new Set<number>([...missingSlots, ...repeated, ...twoHandedSlots, ...revealingSlots, ...poseSlots, ...phoneSlots, ...Object.values(boldSlots).flat()]);
  const marked = slots.map((s) => s.slotIndex).filter((slotIndex) => markedSet.has(slotIndex));
  const accepted = new Map<number, string>();
  for (const s of slots) {
    const sentence = bySlot.get(s.slotIndex);
    if (sentence !== undefined && !markedSet.has(s.slotIndex)) accepted.set(s.slotIndex, sentence);
  }
  return refused([...problems], { ...refusal, repair: { accepted, marked } });
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
 * never re-declares or edits it). 5a.4 (S5.BA5, r2.1 L2): the shape comes through
 * `writerCallOf(mode)`, the one door to the writer's money; S5.BA4 gave this its
 * mode (a REQUIRED one: a bold run priced as an ordinary one would under-price).
 */
export function writerRunPrice(book: PriceBook, slotCount: number, mode: WriterMode): Estimate {
  if (!Number.isInteger(slotCount) || slotCount < 0) {
    throw new RangeError(`slotCount must be a non-negative integer, got ${slotCount}`);
  }
  const call = writerCallOf(mode);
  // Round 2 (M1): one attempt of each chunk at the typical tokens (`writerExpectedMicros`).
  const expectedMicros = writerExpectedMicros(book, call, Math.ceil(slotCount / call.slotsPerCall), slotCount);
  return { expectedMicros, worstMicros: writerWorstMicros(book, call, slotCount), priceSource: book.source };
}
