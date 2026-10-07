import { describe, expect, test } from "bun:test";
import { CATEGORY_DESCRIPTION_MAX, CategoryDescription } from "../../shared/engine";
import { PriceBook } from "../money/prices";
import { chatAttemptWorstMicros, promptTokenFloor } from "../openrouter/chat";
import { POOL_JSON_SCHEMA, POOL_TOLD_WORDS_MAX, POOL_TOLD_WORD_BYTES_MAX, poolCall, poolMessages, type PoolProblem, type PoolRefusal } from "./poolGen";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.2: the pool call's input ceiling must cover its own prompt floor (`promptTokenFloor`, one token per UTF-8 byte) for
// the worst prompt an owner can send, with the worst feedback after a rejected first answer, or the reserve would exceed
// the price the owner accepted and the job's own cap would refuse it. Pinned the way scenes/writer.custom.test.ts pins
// WRITER_CALL.

const TEXT_MODEL = "x-ai/grok-4.3";
const call = poolCall(TEXT_MODEL);
const book = PriceBook.fallback();

/**
 * The margin the ceiling keeps over the worst prompt's floor, in tokens. As built the worst floor (500 CJK chars, the worst feedback) is
 * 6,993 tokens against the 10,000 ceiling: 3,007 of headroom, of which this pin requires 3,000, so a longer system prompt shows up here. (CS.8a: the angles
 * and the body-position rule took 551 tokens of the 3,558 the prompt had before; a further line needs the prompt trimmed or the ceiling re-priced.)
 */
const MARGIN_TOKENS = 3_000;

const ALL_PROBLEMS: PoolProblem[] = ["not-json", "empty", "bad-label", "too-few-places", "too-few-outfits", "bad-shot-deck", "mirror-without-place", "invalid"];

/** Distinct hostile words of exactly `bytes` UTF-8 bytes each, far more than a refusal may tell. */
function manyWords(count: number, bytes: number): string[] {
  return Array.from({ length: count }, (_, i) => `${String.fromCharCode(97 + (i % 26))}${String(i).padStart(2, "0")}`.padEnd(bytes, "z"));
}

const WORST_REFUSAL: PoolRefusal = { problems: ALL_PROBLEMS, words: manyWords(60, 64) };

/** What an owner's 500 chars cost at the dearest: three bytes a char in most of the world's scripts, two in Cyrillic, two for a quote (escaped). */
const DESCRIPTIONS: [string, string][] = [
  ["500 CJK chars (3 bytes each)", "漢".repeat(CATEGORY_DESCRIPTION_MAX)],
  ["500 Cyrillic chars (2 bytes each)", "ы".repeat(CATEGORY_DESCRIPTION_MAX)],
  ["500 quotes (escaped to 2 bytes each)", '"'.repeat(CATEGORY_DESCRIPTION_MAX)],
  ["500 line breaks (escaped to 2 bytes each)", "\n".repeat(CATEGORY_DESCRIPTION_MAX).replace(/^\n/, "x")],
];

function floorOf(description: string, refusal?: PoolRefusal): number {
  return promptTokenFloor({ messages: poolMessages(description, refusal), jsonSchema: POOL_JSON_SCHEMA, images: 0 });
}

describe("the pool call's input ceiling covers its own prompt floor", () => {
  test.each(DESCRIPTIONS)("%s are descriptions the contract accepts", (_name, description) => {
    expect(CategoryDescription.safeParse(description).success).toBe(true);
  });

  test.each(DESCRIPTIONS)("%s with the worst feedback: the floor keeps the margin under the ceiling", (_name, description) => {
    expect(floorOf(description, WORST_REFUSAL)).toBeLessThanOrEqual(call.inputTokens - MARGIN_TOKENS);
  });

  test("the worst feedback tells exactly six words of at most 32 bytes, however many the refusal holds", () => {
    expect(POOL_TOLD_WORDS_MAX).toBe(6);
    expect(POOL_TOLD_WORD_BYTES_MAX).toBe(32);
    const text = poolMessages("x", WORST_REFUSAL)[1]?.content ?? "";
    const told = [...text.matchAll(/"([a-z][0-9]{2}z*)"/g)].map((m) => m[1] ?? "");
    expect(told).toHaveLength(6);
    for (const word of told) expect(Buffer.byteLength(word, "utf8")).toBe(32);
  });

  test("the worst prompt's reserve is the ceiling itself: what the owner accepted is what is reserved", () => {
    const worst = chatAttemptWorstMicros(book, {
      model: TEXT_MODEL,
      messages: poolMessages("漢".repeat(CATEGORY_DESCRIPTION_MAX), WORST_REFUSAL),
      jsonSchema: POOL_JSON_SCHEMA,
      maxTokens: call.maxTokens,
      inputTokens: call.inputTokens,
      images: 0,
    });
    expect(worst).toBe(book.chatWorstCase({ model: TEXT_MODEL, maxTokens: call.maxTokens, inputTokens: call.inputTokens, images: 0 }));
    expect(worst).toBe(22_500);
  });

  test("a prompt a little past the contract's limits would not fit: the pin is not slack", () => {
    // 3,000 more bytes than the contract allows, to show the margin is real and the pin would turn red.
    expect(floorOf("漢".repeat(CATEGORY_DESCRIPTION_MAX + 1_000), WORST_REFUSAL)).toBeGreaterThan(call.inputTokens - MARGIN_TOKENS);
  });
});
