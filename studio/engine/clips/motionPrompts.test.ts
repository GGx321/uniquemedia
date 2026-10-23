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

  test("S5.WC2c round 2 (M2): one translator text for every frame (the faithful one: no frame rule holds clothing on any more); the writer's and the translator's are all there is", () => {
    expect(Object.keys(MOTION_PROMPT_TEXTS).sort()).toEqual(["translatorSystem", "writerSystem"]);
    expect(MOTION_PROMPT_TEXTS.translatorSystem).toContain("translate that faithfully");
  });

  test("S5.WC2c round 2 (M2): no system text tells the model never to take clothing off", () => {
    for (const text of Object.values(MOTION_PROMPT_TEXTS)) expect(text).not.toMatch(/never write taking off|removing or moving clothing/i);
  });

  test("are plain printable text and line breaks: no template slot, no owner word, no Cyrillic", () => {
    for (const text of Object.values(MOTION_PROMPT_TEXTS)) expect(text).toMatch(/^[\x20-\x7e\n]+$/);
  });

  test("are flagged provisional until S5.WCX writes the real texts", () => {
    expect(MOTION_PROMPTS_PROVISIONAL).toBe(true);
  });
});
