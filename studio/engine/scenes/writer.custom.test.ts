import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORY_LABEL_MAX, POOL_TEXT_MAX, type CategorySnapshot } from "../../shared/engine";
import { WRITER_CALL } from "../money/estimate";
import { promptTokenFloor } from "../openrouter/chat";
import { categoryLabelOf, categoryStyleOf } from "./categories";
import { plan, planWithPools } from "./planner";
import { POOLS, type Pool } from "./pools";
import type { PlanSlot } from "./schema";
import { CATEGORIES } from "./types";
import { chunkSlots, writerMessages, WRITER_JSON_SCHEMA, type WriterRefusal } from "./writer";
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

describe("a built-in run's writer messages are byte-identical to main 3a9cd498", () => {
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

describe("WRITER_CALL's ceiling covers a full chunk of the worst custom pool (CS.1 floor pin)", () => {
  // The worst a custom category can send: 25 slots, every pool text at its bound, the widest time of day, the widest
  // shot and pose labels (an all-photographer deck is a legal deck), the 24-char label, and the worst refusal. Built by
  // hand, not drawn by the planner, so no draw can be luckier than this. POOL_TEXT_MAX is the largest bound that fits.
  const label = "L".repeat(CATEGORY_LABEL_MAX);
  const snapshot: CategorySnapshot = { ref: CUSTOM, name: "я".repeat(40), label, style: "editorial" };

  function worstSlots(textLength: number): PlanSlot[] {
    return Array.from({ length: WRITER_CALL.slotsPerCall }, (_, i) => ({
      slotIndex: i + 1,
      category: CUSTOM,
      location: "l".repeat(textLength),
      timeOfDay: "studio lighting",
      activity: "a".repeat(textLength),
      outfit: "o".repeat(textLength),
      shot: "photographer" as const,
      pose: "three-quarter" as const,
      attemptIdBase: `slot-${i + 1}`,
      repeatedPair: false,
    }));
  }

  function worstRefusal(slots: readonly PlanSlot[]): WriterRefusal {
    const indices = slots.map((s) => s.slotIndex);
    const rest = indices.slice(0, -1);
    return {
      problems: ["missing-slots", "two-handed", "youth-word", "revealing-word", "pose-contradiction"],
      missingSlots: indices.slice(-1),
      twoHandedSlots: rest,
      wordSlots: rest,
      poseSlots: rest,
      words: ["girl", "teen", "child", "kid", "school uniform", "bikini", "lingerie", "stockings", "sports bra", "slip dress"],
    };
  }

  const floorOf = (slots: readonly PlanSlot[]): number =>
    promptTokenFloor({ messages: writerMessages(slots, worstRefusal(slots), categoryLabelOf([snapshot])), jsonSchema: WRITER_JSON_SCHEMA, images: 0 });

  test("every text at POOL_TEXT_MAX, label at 24 chars, worst refusal: the prompt floor stays within the 14K input ceiling", () => {
    expect(floorOf(worstSlots(POOL_TEXT_MAX))).toBeLessThanOrEqual(WRITER_CALL.inputTokens);
  });

  test("one char more in every text is already measurably bigger, so the pin does measure the bound", () => {
    expect(floorOf(worstSlots(POOL_TEXT_MAX + 1))).toBeGreaterThan(floorOf(worstSlots(POOL_TEXT_MAX)));
  });

  test("the bound is the largest that fits: four chars more would put the floor over the ceiling", () => {
    expect(floorOf(worstSlots(POOL_TEXT_MAX + 4))).toBeGreaterThan(WRITER_CALL.inputTokens);
  });

  test("a chunk the planner draws from a pool at the bound is never bigger than the hand-built worst", () => {
    const long = (stem: string): string => `${stem} ${"x".repeat(POOL_TEXT_MAX)}`.slice(0, POOL_TEXT_MAX);
    const pool: Pool = {
      locations: Array.from({ length: 7 }, (_, i) => ({ name: long(`place ${i}`), times: ["studio lighting"], activities: [{ text: long(`activity ${i}`), twoHanded: false }], ...(i === 0 ? { mirror: true as const } : {}) })),
      outfits: Array.from({ length: 6 }, (_, i) => long(`outfit ${i}`)),
      shotDeck: ["photographer", "photographer", "photographer", "candid", "candid"],
    };
    const drawnSlots = planWithPools({ seed: 20261005, count: WRITER_CALL.slotsPerCall, categories: [CUSTOM], poses: { profile: true, back: true } }, { ...POOLS, [CUSTOM]: pool }).slots;
    expect(drawnSlots.every((s) => s.location.length === POOL_TEXT_MAX && s.outfit.length === POOL_TEXT_MAX && s.activity.length === POOL_TEXT_MAX)).toBe(true);
    expect(floorOf(drawnSlots)).toBeLessThanOrEqual(floorOf(worstSlots(POOL_TEXT_MAX)));
  });
});
