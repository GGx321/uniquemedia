import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORY_LABEL_MAX, POOL_TEXT_MAX, POOL_TIMES, type CategorySnapshot } from "../../shared/engine";
import { WRITER_CALL } from "../money/estimate";
import { promptTokenFloor } from "../openrouter/chat";
import { categoryLabelOf, categoryStyleOf } from "./categories";
import { plan, planWithPools } from "./planner";
import { POOLS, type Pool } from "./pools";
import { lightOf } from "./phoneLook";
import type { PlanSlot, Pose } from "./schema";
import { CATEGORIES, SHOTS as CANON_SHOTS } from "./types";
import { chunkSlots, POSE_LABEL, REFUSAL_WORD_BYTES_MAX, REFUSAL_WORDS_MAX, SHOT_LABEL, writerMessages, writerRefusalText, WRITER_JSON_SCHEMA, type WriterRefusal } from "./writer";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.1: what the writer is told a custom category is comes from the plan's
// snapshot, never from the category library; a built-in's messages do not move.

const CUSTOM = "cat-paris-cafes";
const SNAPSHOT: CategorySnapshot = { ref: CUSTOM, name: "Кофейни Парижа", label: "Paris cafes", style: "phone" };
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function slot(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: CUSTOM,
    location: "a corner cafe",
    timeOfDay: "morning",
    activity: "reading a menu",
    outfit: "a beige trench coat and jeans",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...overrides,
  };
}

function userSlots(messages: ReturnType<typeof writerMessages>): { category: string }[] {
  return JSON.parse(messages[1]?.content.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
}

describe("the writer names a custom category by its snapshot's label", () => {
  test("a custom slot's category in the message is the label, not the id or the owner's name", () => {
    const messages = writerMessages([slot()], undefined, categoryLabelOf([SNAPSHOT]));
    expect(userSlots(messages)[0]?.category).toBe("Paris cafes");
    expect(messages[1]?.content).not.toContain(CUSTOM);
    expect(messages[1]?.content).not.toContain("Кофейни");
  });

  test("a built-in slot beside it keeps its own fixed English name", () => {
    const messages = writerMessages([slot({ slotIndex: 1, category: "fitness" }), slot({ slotIndex: 2 })], undefined, categoryLabelOf([SNAPSHOT]));
    expect(userSlots(messages).map((s) => s.category)).toEqual(["Fitness", "Paris cafes"]);
  });

  test("a custom slot with no snapshot entry is refused rather than sent under a made-up name", () => {
    expect(() => writerMessages([slot()], undefined, categoryLabelOf([]))).toThrow(RangeError);
    expect(() => writerMessages([slot()])).toThrow(RangeError);
  });

  test("the system prompt is the same for a custom run as for a built-in one", () => {
    expect(writerMessages([slot()], undefined, categoryLabelOf([SNAPSHOT]))[0]).toEqual(writerMessages([slot({ category: "home" })])[0]);
  });
});

describe("categoryStyleOf", () => {
  test("the photoshoot is editorial and every other built-in is a phone photo, as before", () => {
    expect(categoryStyleOf("photoshoot")).toBe("editorial");
    for (const category of CATEGORIES.filter((c) => c !== "photoshoot")) expect(categoryStyleOf(category)).toBe("phone");
  });

  test("a custom category's style is the snapshot's", () => {
    expect(categoryStyleOf(CUSTOM, [{ ...SNAPSHOT, style: "editorial" }])).toBe("editorial");
    expect(categoryStyleOf(CUSTOM, [SNAPSHOT])).toBe("phone");
  });

  test("a custom category with no snapshot entry is refused", () => {
    expect(() => categoryStyleOf(CUSTOM, [])).toThrow(RangeError);
  });
});

describe("a built-in run's writer messages are pinned to the S5.1b phone-look prompts (re-pinned from main 3a9cd498)", () => {
  const fixture: { messages: Record<string, string> } = JSON.parse(readFileSync(join(import.meta.dir, "..", "runs", "fixtures", "writer-main-3a9cd498.json"), "utf8"));
  const slots = plan({ seed: 3, count: 30, categories: [...CATEGORIES], poses: { profile: true, back: true } }).slots;

  test("chunk 1 and chunk 2, plain and after an empty answer", () => {
    const chunks = chunkSlots(slots);
    expect(sha(writerMessages(chunks[0] ?? []))).toBe(fixture.messages.chunk1);
    expect(sha(writerMessages(chunks[1] ?? []))).toBe(fixture.messages.chunk2);
    const empty: WriterRefusal = { problems: ["empty"], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [] };
    expect(sha(writerMessages(chunks[0] ?? [], empty))).toBe(fixture.messages["chunk1-empty"]);
    expect(sha(writerMessages(chunks[1] ?? [], empty))).toBe(fixture.messages["chunk2-empty"]);
  });
});

describe("a refusal's feedback is bounded: the words are the model's own text, so they are clipped, deduplicated and counted", () => {
  const refusal = (words: string[]): WriterRefusal => ({ problems: ["youth-word", "revealing-word"], missingSlots: [], twoHandedSlots: [], wordSlots: [1], words, poseSlots: [] });
  /** The quoted words of the text, in order, one list per reason (the youth reason first, then the revealing one). */
  const quotedPerReason = (text: string): string[][] => text.split("; ").map((reason) => [...reason.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "")).filter((words) => words.length > 0);

  test("a short list reads exactly as before, with the model's own spelling", () => {
    expect(writerRefusalText(refusal(["Bikini", "thong"]))).toBe(
      'slot(s) 1 used words we do not allow: "Bikini", "thong"; call her a woman and use none of them; slot(s) 1 used a revealing word we do not allow: "Bikini", "thong"',
    );
  });

  test("the same word in another case is told once, in the spelling it first came in", () => {
    const [youth] = quotedPerReason(writerRefusalText(refusal(["Bikini", "bikini", "BIKINI", "thong"])));
    expect(youth).toEqual(["Bikini", "thong"]);
  });

  test("at most REFUSAL_WORDS_MAX words are told, in the order they came", () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${String.fromCharCode(97 + i)}`);
    for (const told of quotedPerReason(writerRefusalText(refusal(words)))) expect(told).toEqual(words.slice(0, 6));
  });

  test("a message built for 50 distinct offending words carries exactly 6 of them, whatever REFUSAL_WORDS_MAX is called", () => {
    const words = Array.from({ length: 50 }, (_, i) => `offence${String(i).padStart(2, "0")}`);
    const content = writerMessages([slot({ category: "home" })], refusal(words))[1]?.content ?? "";
    const told = words.filter((word) => content.includes(`"${word}"`));
    expect(told).toEqual(words.slice(0, 6));
    expect(REFUSAL_WORDS_MAX).toBe(6);
  });

  test("a word is clipped to REFUSAL_WORD_BYTES_MAX UTF-8 bytes", () => {
    const [youth] = quotedPerReason(writerRefusalText(refusal(["a".repeat(500)])));
    expect(youth).toEqual(["a".repeat(REFUSAL_WORD_BYTES_MAX)]);
  });

  test("a clipped word never ends in half a character", () => {
    for (const word of ["я".repeat(100), "😀".repeat(100), "é".repeat(100)]) {
      const [told] = quotedPerReason(writerRefusalText(refusal([word]))).map((reason) => reason[0] ?? "");
      expect(Buffer.byteLength(told ?? "", "utf8")).toBeLessThanOrEqual(REFUSAL_WORD_BYTES_MAX);
      expect(told).not.toContain("�");
      expect(word.startsWith(told ?? "x")).toBe(true);
      expect((told ?? "").length).toBeGreaterThan(0);
    }
  });

  test("a word clipped to nothing is not told at all", () => {
    expect(quotedPerReason(writerRefusalText(refusal(["", "thong"])))[0]).toEqual(["thong"]);
  });

  test("the messages of a chunk's first attempt carry no feedback, so they are untouched", () => {
    expect(writerMessages([slot({ category: "home" })])[1]?.content).not.toContain("rejected");
  });
});


/** The widest of each label the writer sends, read from the tables themselves so a longer phrase can never slip past the floor pins (S5.1b review). */
const longestOf = <T extends string>(keys: readonly T[], label: (key: T) => string): T => keys.reduce((a, b) => (label(b).length > label(a).length ? b : a));
const WORST_TIME = longestOf([...POOL_TIMES, "a time the table does not know"], lightOf);
const WORST_SHOT = longestOf(CANON_SHOTS, (s) => SHOT_LABEL[s]);
const WORST_POSE = longestOf(Object.keys(POSE_LABEL) as Pose[], (p) => POSE_LABEL[p]);

describe("WRITER_CALL's ceiling covers a full chunk of the worst custom pool (CS.1 floor pin)", () => {
  // The worst a custom category can send under the rules a pool and a plan are held to: 25 slots, every place, activity and
  // outfit at POOL_TEXT_MAX (printable ASCII without a quote or a backslash, so one byte each and never escaped by the
  // JSON the slots go out as), the time with the widest light phrase, the widest shot and pose labels (read from the tables above), a label at its 24 chars, and the worst refusal: every reason, and more distinct long words than
  // the feedback will tell (it clips them). Built by hand, not drawn by the planner, so no draw can be luckier.
  const label = "L".repeat(CATEGORY_LABEL_MAX);
  const snapshot: CategorySnapshot = { ref: CUSTOM, name: "я".repeat(40), label, style: "editorial" };
  /** What the reserve keeps clear of the ceiling: room for a field a later change adds to a slot or to a refusal. */
  const MARGIN = 250;
  const MARGIN_PRINTED = 290;
  /** A 100-photo run's last chunk is slots 76..100: the widest indices a chunk can carry. */
  const FIRST_INDEX = 100 - WRITER_CALL.slotsPerCall + 1;

  function worstSlots(textLength: number, text = "x"): PlanSlot[] {
    return Array.from({ length: WRITER_CALL.slotsPerCall }, (_, i) => ({
      slotIndex: FIRST_INDEX + i,
      category: CUSTOM,
      location: text.repeat(textLength),
      timeOfDay: WORST_TIME,
      activity: text.repeat(textLength),
      outfit: text.repeat(textLength),
      shot: WORST_SHOT,
      pose: WORST_POSE,
      attemptIdBase: `slot-${i + 1}`,
      repeatedPair: false,
    }));
  }

  /**
   * 160 distinct words, each one byte MORE than REFUSAL_WORD_BYTES_MAX (a 17-byte word, so the clip is what holds the floor: a bound
   * raised to 17 would let its last byte through and move the floor) and distinct within their first REFUSAL_WORD_BYTES_MAX bytes (the
   * feedback clips a word before it tells it apart), of the four widest kinds: far more than the feedback tells, and the kinds interleaved.
   */
  const hostileWords = Array.from({ length: 40 }, (_, i) => {
    const n = String(i).padStart(4, "0");
    return [`${"W".repeat(12)}${n}x`, `${"Я".repeat(6)}${n}x`, `${"😀".repeat(3)}${n}x`, `${"é".repeat(6)}${n}x`];
  }).flat();

  function worstRefusal(slots: readonly PlanSlot[]): WriterRefusal {
    const indices = slots.map((s) => s.slotIndex);
    const rest = indices.slice(0, -1);
    return {
      problems: ["not-json", "empty", "missing-slots", "unknown-slot", "duplicate-slot", "two-handed", "youth-word", "revealing-word", "pose-contradiction"],
      missingSlots: indices.slice(-1),
      twoHandedSlots: rest,
      wordSlots: rest,
      poseSlots: rest,
      words: hostileWords,
    };
  }

  const floorOf = (slots: readonly PlanSlot[]): number =>
    promptTokenFloor({ messages: writerMessages(slots, worstRefusal(slots), categoryLabelOf([snapshot])), jsonSchema: WRITER_JSON_SCHEMA, images: 0 });
  const CEILING = WRITER_CALL.inputTokens;

  test("the worst refusal really carries the most the feedback can: exactly REFUSAL_WORDS_MAX distinct words of exactly REFUSAL_WORD_BYTES_MAX bytes, per reason, out of words one byte longer", () => {
    expect(new Set(hostileWords).size).toBe(hostileWords.length);
    expect(hostileWords.every((w) => Buffer.byteLength(w, "utf8") === REFUSAL_WORD_BYTES_MAX + 1)).toBe(true);
    const text = writerRefusalText(worstRefusal(worstSlots(POOL_TEXT_MAX)));
    const reasons = text.split("; ").filter((reason) => reason.includes("we do not allow"));
    expect(reasons).toHaveLength(2);
    for (const reason of reasons) {
      const told = [...reason.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
      expect(told).toHaveLength(REFUSAL_WORDS_MAX);
      expect(new Set(told).size).toBe(REFUSAL_WORDS_MAX);
      for (const word of told) expect(Buffer.byteLength(word, "utf8")).toBe(REFUSAL_WORD_BYTES_MAX);
    }
  });

  test(`every text at POOL_TEXT_MAX, label at 24 chars, the worst refusal: the prompt floor stays at least ${MARGIN} tokens under the 14K ceiling (margin ${MARGIN_PRINTED})`, () => {
    expect(floorOf(worstSlots(POOL_TEXT_MAX))).toBeLessThanOrEqual(CEILING - MARGIN);
  });

  test("the margin printed in the pin's name is the measured one: re-measure it when the writer's prompt changes", () => {
    expect(CEILING - floorOf(worstSlots(POOL_TEXT_MAX))).toBe(MARGIN_PRINTED);
  });

  test("POOL_TEXT_MAX is the largest bound that keeps that margin: one char more would eat into it", () => {
    expect(floorOf(worstSlots(POOL_TEXT_MAX + 1))).toBeGreaterThan(CEILING - MARGIN);
  });

  test("one char more in every text is measurably bigger, so the pin does measure the bound", () => {
    expect(floorOf(worstSlots(POOL_TEXT_MAX + 1))).toBeGreaterThan(floorOf(worstSlots(POOL_TEXT_MAX)));
  });

  test("without the escaping rule the pin would not hold: texts of quotes at the bound push the floor over the ceiling", () => {
    expect(floorOf(worstSlots(POOL_TEXT_MAX, '"'))).toBeGreaterThan(CEILING);
    expect(floorOf(worstSlots(POOL_TEXT_MAX, "\\"))).toBeGreaterThan(CEILING);
  });

  test("a label of 24 quotes would also not hold, which is why the label forbids them", () => {
    const quoted: CategorySnapshot = { ...snapshot, label: '"'.repeat(CATEGORY_LABEL_MAX) };
    const slots = worstSlots(POOL_TEXT_MAX);
    const floor = promptTokenFloor({ messages: writerMessages(slots, worstRefusal(slots), categoryLabelOf([quoted])), jsonSchema: WRITER_JSON_SCHEMA, images: 0 });
    expect(floor).toBeGreaterThan(floorOf(slots));
  });

  test("a chunk the planner draws from a pool at the bound is never bigger than the hand-built worst", () => {
    const long = (stem: string): string => `${stem} ${"x".repeat(POOL_TEXT_MAX)}`.slice(0, POOL_TEXT_MAX);
    const pool: Pool = {
      locations: Array.from({ length: 7 }, (_, i) => ({ name: long(`place ${i}`), times: [WORST_TIME], activities: [{ text: long(`activity ${i}`), twoHanded: false }], ...(i === 0 ? { mirror: true as const } : {}) })),
      outfits: Array.from({ length: 6 }, (_, i) => long(`outfit ${i}`)),
      shotDeck: ["photographer", "photographer", "photographer", "candid", "candid"],
    };
    const drawnSlots = planWithPools({ seed: 20261005, count: WRITER_CALL.slotsPerCall, categories: [CUSTOM], poses: { profile: true, back: true } }, { ...POOLS, [CUSTOM]: pool }).slots;
    expect(drawnSlots.every((s) => s.location.length === POOL_TEXT_MAX && s.outfit.length === POOL_TEXT_MAX && s.activity.length === POOL_TEXT_MAX)).toBe(true);
    expect(floorOf(drawnSlots)).toBeLessThanOrEqual(floorOf(worstSlots(POOL_TEXT_MAX)));
  });
});
