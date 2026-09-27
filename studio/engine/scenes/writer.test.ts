import { describe, expect, test } from "bun:test";
import { estimateRun, WRITER_CALL, type RunPlanInput } from "../money/estimate";
import { PriceBook } from "../money/prices";
import { promptTokenFloor } from "../openrouter/chat";
import { CATEGORIES } from "./types";
import { plan } from "./planner";
import type { PlanSlot } from "./schema";
import {
  chunkSlots,
  isTwoHanded,
  readWriterAnswer,
  revealingWordsIn,
  writerMessages,
  writerRefusalText,
  writerRunPrice,
  WRITER_JSON_SCHEMA,
  type WriterOutput,
  type WriterProblem,
  type WriterRefusal,
} from "./writer";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T5b: the scene writer's pure logic (prompts, the model's output schema, the
// re-ask detectors and the writer's own pricing). No I/O, no money, no
// network: those live in writerJob.test.ts.

function slot(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: "home",
    location: "a bright kitchen",
    timeOfDay: "morning",
    activity: "holding a ceramic coffee mug",
    outfit: "a plain white t-shirt and cotton shorts",
    shot: "friend",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...overrides,
  };
}

function output(scenes: { slotIndex: number; sentence: string }[]): string {
  return JSON.stringify({ scenes });
}

describe("writerMessages", () => {
  test("the system prompt states the one-hand-holds-the-phone rule, full sentences, and no children", () => {
    const [system] = writerMessages([slot()]);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("one");
    expect(system?.content.toLowerCase()).toContain("hand");
    expect(system?.content.toLowerCase()).toContain("full");
    expect(system?.content.toLowerCase()).toContain("no children");
  });

  test("the user message carries only the plan's slot fields, in order", () => {
    const slots = [slot({ slotIndex: 1, category: "home" }), slot({ slotIndex: 2, category: "fitness", shot: "selfie" })];
    const [, user] = writerMessages(slots);
    expect(user?.role).toBe("user");
    const body = JSON.parse(user?.content.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    expect(body).toEqual([
      { slotIndex: 1, category: "Home", location: "a bright kitchen", timeOfDay: "morning", shot: "photo taken by a friend", outfit: "a plain white t-shirt and cotton shorts", activity: "holding a ceramic coffee mug" },
      { slotIndex: 2, category: "Fitness", location: "a bright kitchen", timeOfDay: "morning", shot: "front-camera selfie", outfit: "a plain white t-shirt and cotton shorts", activity: "holding a ceramic coffee mug" },
    ]);
  });

  test("with no refusal, the user message names no earlier rejection", () => {
    const [, user] = writerMessages([slot()]);
    expect(user?.content).not.toContain("rejected");
  });

  test("a refusal is fed back as fixed reasons, in the next message", () => {
    const [, user] = writerMessages([slot()], { problems: ["two-handed"], missingSlots: [], twoHandedSlots: [1], wordSlots: [], words: [] });
    expect(user?.content).toContain("rejected");
    expect(user?.content).toContain("1");
  });
});

describe("readWriterAnswer", () => {
  const SLOTS = [slot({ slotIndex: 1, shot: "selfie" }), slot({ slotIndex: 2, shot: "friend" })];
  const GOOD_SELFIE = "She holds her phone in one hand and brushes a loose strand of hair back with the other, smiling softly at her reflection.";
  const GOOD_FRIEND = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";

  test("a valid answer with one sentence per slot is read as the sentences", () => {
    const answer = readWriterAnswer(output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: GOOD_FRIEND }]), SLOTS);
    expect(answer).toEqual({ ok: true, sentences: new Map([[1, GOOD_SELFIE], [2, GOOD_FRIEND]]) });
  });

  test("content that is not JSON is refused as not-json", () => {
    const answer = readWriterAnswer("not json at all", SLOTS);
    expect(answer).toMatchObject({ ok: false, problems: ["not-json"] });
  });

  test("content that does not match the schema is refused as not-json", () => {
    const answer = readWriterAnswer(JSON.stringify({ scenes: [{ slotIndex: 1, sentence: "" }, { slotIndex: 2, sentence: GOOD_FRIEND }] }), SLOTS);
    expect(answer).toMatchObject({ ok: false, problems: ["not-json"] });
  });

  test("a missing slot is refused, naming it", () => {
    const answer = readWriterAnswer(output([{ slotIndex: 1, sentence: GOOD_SELFIE }]), SLOTS);
    expect(answer).toMatchObject({ ok: false, problems: ["missing-slots"], missingSlots: [2] });
  });

  test("an unknown slot index is refused", () => {
    const answer = readWriterAnswer(
      output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: GOOD_FRIEND }, { slotIndex: 99, sentence: GOOD_FRIEND }]),
      SLOTS,
    );
    expect(answer).toMatchObject({ ok: false, problems: ["unknown-slot"] });
  });

  test("a duplicated slot index is refused", () => {
    const answer = readWriterAnswer(
      output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: GOOD_FRIEND }]),
      SLOTS,
    );
    expect(answer).toMatchObject({ ok: false, problems: ["duplicate-slot"] });
  });

  test("a two-handed action in a selfie slot is refused, naming the slot", () => {
    const twoHanded = "She raises her phone for a selfie, holding a cup of coffee with both hands, glancing warmly at the camera.";
    const answer = readWriterAnswer(output([{ slotIndex: 1, sentence: twoHanded }, { slotIndex: 2, sentence: GOOD_FRIEND }]), SLOTS);
    expect(answer).toMatchObject({ ok: false, problems: ["two-handed"], twoHandedSlots: [1] });
  });

  test("the same two-handed wording in a non-selfie, non-mirror slot is not flagged", () => {
    const twoHanded = "A friend photographs her holding a cup of coffee with both hands at the kitchen counter.";
    const answer = readWriterAnswer(output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: twoHanded }]), SLOTS);
    expect(answer).toMatchObject({ ok: true });
  });

  test("a youth word is refused, naming the word and the slot", () => {
    const answer = readWriterAnswer(
      output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: "A young girl laughs in the kitchen." }]),
      SLOTS,
    );
    expect(answer).toMatchObject({ ok: false, problems: ["youth-word"], wordSlots: [2] });
    if (!answer.ok) expect(answer.words.length).toBeGreaterThan(0);
  });

  test("a revealing word is refused, naming the word and the slot", () => {
    const answer = readWriterAnswer(
      output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: "She lounges by the pool in a bikini, laughing." }]),
      SLOTS,
    );
    expect(answer).toMatchObject({ ok: false, problems: ["revealing-word"], wordSlots: [2] });
    if (!answer.ok) expect(answer.words.map((w) => w.toLowerCase())).toContain("bikini");
  });

  test("several problems across slots are all reported at once, deduplicated", () => {
    const answer = readWriterAnswer(
      output([
        { slotIndex: 1, sentence: "She raises her phone for a selfie, holding a mug with both hands." },
        { slotIndex: 2, sentence: "A young girl in a bikini laughs in the kitchen." },
      ]),
      SLOTS,
    );
    expect(answer).toMatchObject({ ok: false });
    if (answer.ok) throw new Error("expected a refusal");
    const expectedProblems: WriterProblem[] = ["revealing-word", "two-handed", "youth-word"];
    expect([...answer.problems].sort()).toEqual(expectedProblems.sort());
    expect(answer.twoHandedSlots).toEqual([1]);
    expect(answer.wordSlots).toEqual([2]);
  });
});

describe("detectors", () => {
  test.each([
    ["holding a cup of coffee with both hands", true],
    ["her hands pulling her ponytail tighter", true],
    ["each hand gripping a strap of her backpack", true],
    ["using both hands to adjust her hair", true],
    ["holds her phone in one hand and waves with the other", false],
    ["a relaxed half-smile, her free hand resting on the counter", false],
    ["she smiles softly at the camera", false],
    // Review round 1 (MEDIUM): a free 40-char proximity window let "holding"
    // match even though it belongs to "her other hand", not to "hands" —
    // false positive that would have burned both paid attempts.
    ["She takes a mirror selfie, her hands neatly manicured, holding the phone with her other hand and smiling softly.", false],
    // Review round 1 (LOW/MEDIUM): past tense and typing/texting/carrying were missing.
    ["Her hands adjusted the strap of her bag before she smiled for the mirror.", true],
    ["She glances at the screen, her hands typing quickly on the counter.", true],
    ["her hands held the railing tightly as she posed", true],
    ["her hands carried the tray steadily", true],
  ])("isTwoHanded(%j) -> %p", (sentence, expected) => {
    expect(isTwoHanded(sentence)).toBe(expected);
  });

  test.each([
    ["she wears a bikini at the pool", ["bikini"]],
    ["a lace lingerie set and heels", ["lingerie"]],
    ["a sports bra and running shorts", ["sports bra"]],
    ["an oversized cream sweater", []],
  ])("revealingWordsIn(%j) -> %p", (sentence, expected) => {
    expect(revealingWordsIn(sentence).map((w) => w.toLowerCase())).toEqual(expected);
  });
});

describe("writerRefusalText", () => {
  test("names the two-handed slots and the rule", () => {
    const text = writerRefusalText({ problems: ["two-handed"], missingSlots: [], twoHandedSlots: [3], wordSlots: [], words: [] });
    expect(text).toContain("3");
    expect(text.toLowerCase()).toContain("hand");
  });

  test("never repeats the model's own rejected words back verbatim, only our fixed reasons", () => {
    const text = writerRefusalText({ problems: ["youth-word"], missingSlots: [], twoHandedSlots: [], wordSlots: [2], words: ["girl"] });
    expect(text).toContain("girl");
    expect(text).not.toContain("laughs in the kitchen");
  });
});

describe("chunkSlots", () => {
  function slotsOf(count: number): PlanSlot[] {
    return Array.from({ length: count }, (_, i) => slot({ slotIndex: i + 1 }));
  }

  test.each([
    [0, []],
    [1, [1]],
    [WRITER_CALL.slotsPerCall, [WRITER_CALL.slotsPerCall]],
    [WRITER_CALL.slotsPerCall + 1, [WRITER_CALL.slotsPerCall, 1]],
    [2 * WRITER_CALL.slotsPerCall, [WRITER_CALL.slotsPerCall, WRITER_CALL.slotsPerCall]],
    [100, [WRITER_CALL.slotsPerCall, WRITER_CALL.slotsPerCall, WRITER_CALL.slotsPerCall, WRITER_CALL.slotsPerCall]],
  ])("%i slots -> chunk sizes %j", (count, sizes) => {
    expect(chunkSlots(slotsOf(count)).map((c) => c.length)).toEqual(sizes);
  });

  test("keeps every slot's order, split by position, nothing dropped or duplicated", () => {
    const all = slotsOf(2 * WRITER_CALL.slotsPerCall + 7);
    const chunks = chunkSlots(all);
    expect(chunks.flat()).toEqual(all);
  });
});

describe("writerRunPrice", () => {
  // Review round 2/3: RunRequest.count allows up to 100 slots, so the writer
  // job makes ceil(slotCount / WRITER_CALL.slotsPerCall) calls, each retried
  // up to WRITER_CALL.maxAttempts times before the job gives up on it; the
  // worst case is chunks × maxAttempts × the per-call ceiling (review round
  // 3: a flat one-call, one-attempt ceiling priced this too low).
  test("the worst case is chunks × maxAttempts × the per-call ceiling", () => {
    const book = PriceBook.fallback();
    expect(writerRunPrice(book, 0).worstMicros).toBe(0);
    expect(writerRunPrice(book, 1).worstMicros).toBe(70_000);
    expect(writerRunPrice(book, WRITER_CALL.slotsPerCall).worstMicros).toBe(70_000);
    expect(writerRunPrice(book, WRITER_CALL.slotsPerCall + 1).worstMicros).toBe(140_000);
    expect(writerRunPrice(book, 100).worstMicros).toBe(280_000);
  });

  test("the expected cost scales per scene, at the spike's measured per-scene tokens, unaffected by chunking or attempts", () => {
    const book = PriceBook.fallback();
    expect(writerRunPrice(book, 0).expectedMicros).toBe(0);
    expect(writerRunPrice(book, 1).expectedMicros).toBe(458);
    expect(writerRunPrice(book, 25).expectedMicros).toBe(11_438);
    expect(writerRunPrice(book, 26).expectedMicros).toBe(11_895);
    expect(writerRunPrice(book, 100).expectedMicros).toBe(45_750);
  });

  test("the price source follows the book", () => {
    expect(writerRunPrice(PriceBook.fallback(), 20).priceSource).toBe("fallback");
  });

  test("rejects a negative or non-integer slot count", () => {
    expect(() => writerRunPrice(PriceBook.fallback(), -1)).toThrow();
    expect(() => writerRunPrice(PriceBook.fallback(), 1.5)).toThrow();
  });

  // Review round 3: writerRunPrice must delegate to the exact same money
  // helper (writerWorstMicros) estimateRun uses for its own writer term, so
  // the two can never drift apart again. Isolates the writer's own
  // contribution to estimateRun's worst case by using one image choice, no
  // age checks and attemptsPerSlot 1, then subtracting the (independently
  // computed, via the public PriceBook API) image-only cost.
  test("agrees with estimateRun's writer term for the same slot count (drift guard)", () => {
    const book = PriceBook.fallback();
    const image = { model: "x-ai/grok-imagine-image-2.0", resolution: "1K" as const, quality: "low" as const, refs: 1 };
    const imageOnlyPerPhoto = book.imageWorstCase(image);

    for (const slotCount of [0, 1, WRITER_CALL.slotsPerCall, WRITER_CALL.slotsPerCall + 1, 100]) {
      const run: RunPlanInput = { photos: slotCount, attemptsPerSlot: 1, route: [image], writer: WRITER_CALL, ageChecks: null };
      const writerPortion = estimateRun(book, run).worstMicros - slotCount * imageOnlyPerPhoto;
      expect(writerPortion).toBe(writerRunPrice(book, slotCount).worstMicros);
    }
  });
});

test("WRITER_JSON_SCHEMA and WRITER_CALL.maxAttempts", () => {
  expect(WRITER_CALL.maxAttempts).toBe(2);
  expect(WRITER_JSON_SCHEMA.name).toBe("scene_sentences");
  const good: WriterOutput = { scenes: [{ slotIndex: 1, sentence: "x" }] };
  expect(good.scenes[0]?.slotIndex).toBe(1);
});

describe("WRITER_CALL's per-call ceilings cover one full chunk", () => {
  // Review round 2: RunRequest.count (studio/shared/engine/state.ts) allows
  // 1..100 photos, possibly all in one category — far more than a single
  // writer call can safely take (a 100-slot prompt floor measured ~30_223
  // tokens, and 100 scenes' typical output alone, ~13_000 tokens, already
  // exceeds max_tokens). The writer job (writerJob.ts) now chunks the plan
  // into calls of at most WRITER_CALL.slotsPerCall slots each, so the ceiling
  // only ever has to cover ONE chunk — never the whole run — whatever the
  // run's total slot count.
  //
  // The worst plausible single refusal: almost every slot both two-handed
  // and carrying a youth/revealing word, one slot missing outright.
  function worstRefusal(slots: readonly PlanSlot[]): WriterRefusal {
    const indices = slots.map((s) => s.slotIndex);
    const missingSlots = indices.slice(-1);
    const rest = indices.slice(0, -1);
    return {
      problems: ["missing-slots", "two-handed", "youth-word", "revealing-word"],
      missingSlots,
      twoHandedSlots: rest,
      wordSlots: rest,
      words: ["girl", "teen", "child", "kid", "school uniform", "bikini", "lingerie", "stockings", "sports bra", "slip dress"],
    };
  }

  test("a full chunk's worst refusal message stays under WRITER_CALL.inputTokens", () => {
    const scenePlan = plan({ seed: 20260924, count: WRITER_CALL.slotsPerCall, categories: [...CATEGORIES] });
    const messages = writerMessages(scenePlan.slots, worstRefusal(scenePlan.slots));
    const floor = promptTokenFloor({ messages, jsonSchema: WRITER_JSON_SCHEMA, images: 0 });

    // Measured (2026-09-27): a WRITER_CALL.slotsPerCall (25) chunk, plain ~8317,
    // +worst refusal ~9168; 20 slots plain ~7027, +worst refusal ~7818; 30
    // slots +worst refusal ~10522 (over one chunk, for reference only — a
    // 30-slot run is itself split into two chunks of 25 and 5).
    // WRITER_CALL.inputTokens = 12_000 leaves ~2_800 headroom over one full
    // chunk's worst refusal.
    expect(floor).toBeLessThanOrEqual(WRITER_CALL.inputTokens);
  });

  test("a smaller chunk (the run's documented default of 20 photos, all in one chunk) leaves even more headroom", () => {
    const scenePlan = plan({ seed: 20260924, count: 20, categories: [...CATEGORIES] });
    const messages = writerMessages(scenePlan.slots, worstRefusal(scenePlan.slots));
    const floor = promptTokenFloor({ messages, jsonSchema: WRITER_JSON_SCHEMA, images: 0 });

    expect(floor).toBeLessThanOrEqual(WRITER_CALL.inputTokens);
  });

  // Reliability, not money-safety: max_tokens is a hard API ceiling either
  // way (an attempt is truncated, never overpaid), but a chunk whose
  // scenes cannot fit inside it would waste an attempt on a truncated,
  // invalid-JSON answer every time. WORST_OUTPUT_TOKENS_PER_SCENE doubles
  // the spike's measured typical (130 tokens for ~39 words/scene,
  // WRITER_CALL.typicalPerScene.outputTokens) — generous headroom over the
  // system prompt's own "25 to 45 words" target.
  const WORST_OUTPUT_TOKENS_PER_SCENE = WRITER_CALL.typicalPerScene.outputTokens * 2;

  test("the output ceiling comfortably fits one full chunk, even generously overshooting the target sentence length", () => {
    expect(WRITER_CALL.slotsPerCall * WORST_OUTPUT_TOKENS_PER_SCENE).toBeLessThanOrEqual(WRITER_CALL.maxTokens);
  });
});
