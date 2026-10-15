import { describe, expect, test } from "bun:test";
import { MOTION_PROMPTS_PROVISIONAL, MOTION_PROMPT_TEXTS } from "./motionPrompts";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC3: the two system prompts are PROVISIONAL stand-ins; S5.WCX writes the real ones against paid probe P-M. This pins only what must hold of ANY text that replaces them, so the wiring
// never has to change: two different non-empty strings in plain printable text, and the flag that says they are not final. The wording is not tested here, and the wiring tests (motionWriter.test.ts,
// ideaTranslator.test.ts) never assert it.

describe("the system prompts' interface", () => {
  test("are two different non-empty texts, the writer's and the translator's", () => {
    expect(MOTION_PROMPT_TEXTS.writerSystem.length).toBeGreaterThan(0);
    expect(MOTION_PROMPT_TEXTS.translatorSystem.length).toBeGreaterThan(0);
    expect(MOTION_PROMPT_TEXTS.writerSystem).not.toBe(MOTION_PROMPT_TEXTS.translatorSystem);
  });

  test("the translator has a variant for a frame of «Смелая», different from the ordinary one", () => {
    expect(MOTION_PROMPT_TEXTS.translatorSystemBold.length).toBeGreaterThan(0);
    expect(MOTION_PROMPT_TEXTS.translatorSystemBold).not.toBe(MOTION_PROMPT_TEXTS.translatorSystem);
  });

  test("are plain printable text and line breaks: no template slot, no owner word, no Cyrillic", () => {
    for (const text of [MOTION_PROMPT_TEXTS.writerSystem, MOTION_PROMPT_TEXTS.translatorSystem, MOTION_PROMPT_TEXTS.translatorSystemBold]) expect(text).toMatch(/^[\x20-\x7e\n]+$/);
  });

  test("are flagged provisional until S5.WCX writes the real texts", () => {
    expect(MOTION_PROMPTS_PROVISIONAL).toBe(true);
  });
});
