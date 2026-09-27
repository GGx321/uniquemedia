import { z } from "zod";
import { youthWords } from "../../shared/engine";
import { WRITER_CALL, writerWorstMicros, type Estimate } from "../money/estimate";
import type { PriceBook } from "../money/prices";
import type { ChatMessage } from "../openrouter/types";
import type { Category, Shot } from "./types";
import type { PlanSlot } from "./schema";
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
 * which is what lets writerJob.ts's attempt ids
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

const CATEGORY_LABEL: Record<Category, string> = {
  home: "Home",
  travel: "Travel",
  photoshoot: "Photoshoot",
  glamour: "Glamour",
  fitness: "Fitness",
};
const SHOT_LABEL: Record<Shot, string> = {
  friend: "photo taken by a friend",
  selfie: "front-camera selfie",
  mirror: "mirror selfie",
  candid: "candid shot, not looking at the camera",
  photographer: "photo taken by a photographer with a full-frame camera",
};

function writerSystemPrompt(): string {
  return [
    "You write one photorealistic scene sentence for each of the given photo slots, of one recurring adult woman.",
    "Reference images supply her identity, so you never describe her face, never give her a name, and never change her hair, eyes or body type.",
    "",
    "For each slot, write exactly one full English sentence (never a fragment) that uses the slot's category, location, time of day, shot type, outfit and activity, and adds natural, concrete detail: what her hands and body do, her expression, the background and the light.",
    "",
    "Rules:",
    "- One full sentence per slot, about 25 to 45 words, plain present tense.",
    '- In a front-camera selfie or a mirror selfie, one hand always holds the phone: describe only what her other, single hand does, or say nothing about her hands. Never describe an action that needs both hands in these shots.',
    "- She is a grown adult woman; no children or minors anywhere in the scene, and never a word that suggests she or anyone else is not an adult.",
    "- No revealing clothing (no bikini, swimsuit, swimwear, lingerie, sports bra, thong, stockings or a robe over lingerie): whatever the given outfit, describe it as covering and non-revealing.",
    "- No text, logos, brand names or readable signs; nothing covers her face.",
    '- Never use "stunning", "beautiful", "perfect" or "flawless".',
    "",
    'Return JSON matching the schema: {"scenes": [{"slotIndex", "sentence"}, ...]}, exactly one object per slot, in the given order.',
  ].join("\n");
}

function slotForWriter(slot: PlanSlot): Record<string, unknown> {
  return {
    slotIndex: slot.slotIndex,
    category: CATEGORY_LABEL[slot.category],
    location: slot.location,
    timeOfDay: slot.timeOfDay,
    shot: SHOT_LABEL[slot.shot],
    outfit: slot.outfit,
    activity: slot.activity,
  };
}

// ---------- refusal / re-ask feedback ----------

export type WriterProblem = "not-json" | "empty" | "missing-slots" | "unknown-slot" | "duplicate-slot" | "two-handed" | "youth-word" | "revealing-word";

/** Why an answer was refused, as the next attempt is told: fixed reasons and
 *  slot numbers, never the model's own rejected wording (the youth/revealing
 *  words are ours to name; a slot's rejected sentence never is). */
export interface WriterRefusal {
  problems: WriterProblem[];
  missingSlots: number[];
  twoHandedSlots: number[];
  wordSlots: number[];
  words: string[];
}

const NO_REFUSAL: WriterRefusal = { problems: [], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [] };

function quotedList(words: readonly string[]): string {
  return words.map((w) => `"${w}"`).join(", ");
}

function slotList(indices: readonly number[]): string {
  return indices.join(", ");
}

const REASON: Partial<Record<WriterProblem, (r: WriterRefusal) => string>> = {
  "not-json": () => 'it was not the JSON object {"scenes": [...]}, one sentence per slot',
  empty: () => "it was empty",
  "missing-slots": (r) => `it was missing a sentence for slot(s) ${slotList(r.missingSlots)}`,
  "unknown-slot": () => "it returned a slotIndex that is not in the plan",
  "duplicate-slot": () => "it returned the same slotIndex more than once",
  "two-handed": (r) => `slot(s) ${slotList(r.twoHandedSlots)} used a two-handed action in a selfie or mirror shot; one hand always holds the phone, so only the other hand may act`,
  "youth-word": (r) => `slot(s) ${slotList(r.wordSlots)} used words we do not allow: ${quotedList(r.words)}; call her a woman and use none of them`,
  "revealing-word": (r) => `slot(s) ${slotList(r.wordSlots)} used a revealing word we do not allow: ${quotedList(r.words)}`,
};

/** Every reason a refusal happened, as fixed sentences; never the model's own rejected text. */
export function writerRefusalText(refusal: WriterRefusal): string {
  return [...new Set(refusal.problems)].map((p) => REASON[p]?.(refusal) ?? p).join("; ");
}

/** The messages of one writer attempt; `refusal` is why the previous answer was rejected. */
export function writerMessages(slots: readonly PlanSlot[], refusal: WriterRefusal = NO_REFUSAL): ChatMessage[] {
  const lines = ["Slots:", JSON.stringify(slots.map(slotForWriter), null, 2)];
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

function phoneInHand(slot: PlanSlot): boolean {
  return slot.shot === "selfie" || slot.shot === "mirror";
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
  return { ok: false, problems, missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], ...extra };
}

/** The model's answer against the plan's slots, or every reason it cannot be used. */
export function readWriterAnswer(content: string, slots: readonly PlanSlot[]): WriterAnswer {
  const parsed = WriterOutputSchema.safeParse(parseJson(content));
  if (!parsed.success) return refused(["not-json"]);

  const known = new Map(slots.map((s) => [s.slotIndex, s]));
  const bySlot = new Map<number, string>();
  const problems = new Set<WriterProblem>();

  for (const scene of parsed.data.scenes) {
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
  }

  if (problems.size > 0) {
    return refused([...problems], { missingSlots, twoHandedSlots, wordSlots: [...wordSlots].sort((a, b) => a - b), words: [...words] });
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
