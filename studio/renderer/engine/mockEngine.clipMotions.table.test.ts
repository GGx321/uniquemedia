import { describe, expect, test } from "bun:test";
import { PriceBook } from "../../engine/money/prices";
import { suggestPrice, translatePrice } from "../../engine/clips/motionPrice";
import { frameFactsOf } from "../../engine/clips/frameFacts";
import { planlessPhoto } from "../../engine/clips/testing/frameFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { chatAttemptWorstMicros } from "../../engine/openrouter/chat";
import { TRANSLATE_ATTEMPT, SUGGEST_ATTEMPT } from "../../engine/money/motionEstimate";
import { MOTION_PROMPT_TEXTS } from "../../engine/clips/motionPrompts";
import { WRITER_JSON_SCHEMA } from "../../engine/clips/motionWriter";
import { TRANSLATOR_JSON_SCHEMA } from "../../engine/clips/ideaTranslator";
import {
  attemptWorstMicros,
  MOCK_SUGGEST_PRICE,
  MOCK_TRANSLATE_PRICE,
} from "./mockClipMotions";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC4 (plan s5b2 §5.6 «C», I5.66, I5.68): the mock cannot import `engine/`, so what the engine decides with is written out in mockClipMotions.ts and HELD to the engine here, by a test that can import both:
// the two prices (they follow the engine's system prompts: the day a prompt changes this test fails and says which figure to move), the normalising of a model's text, and the motion check on the frames the
// mock plays. The SHARED check (shared/scenes/motionText.ts) is imported by both; what is compared is the wrapper around it. Fixed seed, 400 cases, well under 2 s.

const PRICED = { book: PriceBook.fallback(), asOf: "2026-09-24" };
const MODEL = "x-ai/grok-4.3";

describe("the prices", () => {
  test("estimateSuggest is the engine's figure at the bundled table", () => {
    const engine = suggestPrice(PRICED, MODEL);
    expect({ expectedMicros: engine.expectedMicros, worstMicros: engine.worstMicros }).toEqual(MOCK_SUGGEST_PRICE);
  });

  test("estimateIdea is the engine's figure at the bundled table", () => {
    const engine = translatePrice(PRICED, MODEL);
    expect({ expectedMicros: engine.expectedMicros, worstMicros: engine.worstMicros }).toEqual(MOCK_TRANSLATE_PRICE);
  });

  test("a call's worst case is two attempts of a whole number of micro-dollars", () => {
    expect(MOCK_SUGGEST_PRICE.worstMicros % 2).toBe(0);
    expect(MOCK_TRANSLATE_PRICE.worstMicros % 2).toBe(0);
  });

  test("an attempt's reserve is the engine's formula over the message: a table of messages", () => {
    const system = MOTION_PROMPT_TEXTS.writerSystem;
    for (const user of ["{}", JSON.stringify({ frame: { a: 1 } }), "я".repeat(300), JSON.stringify({ idea: "я".repeat(300), problems: ["not-motion"], previous: "x".repeat(80) })]) {
      const engine = chatAttemptWorstMicros(PRICED.book, { model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }], jsonSchema: WRITER_JSON_SCHEMA, ...SUGGEST_ATTEMPT });
      expect(attemptWorstMicros("suggest", user)).toBe(engine);
    }
    const idea = MOTION_PROMPT_TEXTS.translatorSystem;
    for (const user of ["{}", "я".repeat(900)]) {
      const engine = chatAttemptWorstMicros(PRICED.book, { model: MODEL, messages: [{ role: "system", content: idea }, { role: "user", content: user }], jsonSchema: TRANSLATOR_JSON_SCHEMA, ...TRANSLATE_ATTEMPT });
      expect(attemptWorstMicros("idea", user)).toBe(engine);
    }
    // A message under the ceiling pays the ceiling; one over it pays its own size.
    expect(attemptWorstMicros("idea", "{}")).toBe(chatAttemptWorstMicros(PRICED.book, { model: MODEL, messages: [{ role: "system", content: MOTION_PROMPT_TEXTS.translatorSystem }, { role: "user", content: "{}" }], jsonSchema: TRANSLATOR_JSON_SCHEMA, ...TRANSLATE_ATTEMPT }));
  });

});

const ordinary = frameFactsOf(planlessPhoto("home", { faceCos: 0.86 }), null);
const bold = frameFactsOf(planlessPhoto("nightwear", { faceCos: 0.86 }), null);
if (ordinary.kind !== "gallery" || bold.kind !== "gallery") throw new Error("the fixture photos are not gallery photos");


