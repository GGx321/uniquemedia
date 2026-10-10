import { describe, expect, test } from "bun:test";
import { DESCRIPTOR_MAX_CHARS, youthWords, type AvatarDescriptor, type CategorySnapshot } from "../../shared/engine";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { AssemblerRefusalError, assembleRun, assembleSlot as assembleWith, sentenceProblems, type AssembleOptions } from "./assembler";
import type { OwnPlanSlot, PlanSlot } from "./schema";
import { revealingWordsIn } from "./words";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.1: the assembler's last-gate sentence check is one exported function that the owner's edit-time check can call too. A custom category's slot
// is assembled like any other (S5.1a: the assembler no longer reads a category's style).

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair." };
const MASTER = asLibraryReference(JPEG);
const SENTENCE = "She leans on the bridge railing as the evening light turns the river gold.";
const CUSTOM = "cat-paris-cafes";
const PHONE: CategorySnapshot = { ref: CUSTOM, name: "Кофейни Парижа", label: "Paris cafes", style: "phone" };
const EDITORIAL: CategorySnapshot = { ...PHONE, style: "editorial" };

const RUN_ID = "run-custom-1";

/** assembleSlot with the run id every call needs (the look draws are seeded from it). */
function assembleSlot(descriptor: AvatarDescriptor, planSlot: PlanSlot | OwnPlanSlot, sentence: string, master: typeof MASTER, options: Partial<AssembleOptions> = {}) {
  return assembleWith(descriptor, planSlot, sentence, master, { runId: RUN_ID, ...options });
}
const OPTIONS: AssembleOptions = { runId: RUN_ID };

function slot(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: CUSTOM,
    location: "a bridge over the Seine",
    timeOfDay: "golden hour",
    activity: "leaning on the railing",
    outfit: "a beige trench coat and jeans",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...overrides,
  };
}

describe("sentenceProblems", () => {
  test("a clean sentence has no problem", () => {
    expect(sentenceProblems(SENTENCE)).toEqual([]);
  });

  test("a youth word is named, with the words the rule found", () => {
    const sentence = "The little girl waves from the bridge.";
    expect(sentenceProblems(sentence)).toEqual([{ reason: "youth-word", words: youthWords(sentence, "descriptor") }]);
    expect(youthWords(sentence, "descriptor").length).toBeGreaterThan(0);
  });

  test("a revealing word is named, with the words the rule found", () => {
    const sentence = "She wears a bikini on the bridge.";
    expect(sentenceProblems(sentence)).toEqual([{ reason: "revealing-word", words: revealingWordsIn(sentence) }]);
    expect(revealingWordsIn(sentence).length).toBeGreaterThan(0);
  });

  test("a sentence with both says both, the youth words first", () => {
    const problems = sentenceProblems("The girl wears a bikini.");
    expect(problems.map((p) => p.reason)).toEqual(["youth-word", "revealing-word"]);
  });
});

describe("assembleSlot still refuses what sentenceProblems finds, with the same message", () => {
  test("a youth word", () => {
    expect(() => assembleSlot(DESCRIPTOR, slot({ category: "home" }), "The girl waves.", MASTER)).toThrow(AssemblerRefusalError);
    expect(() => assembleSlot(DESCRIPTOR, slot({ category: "home" }), "The girl waves.", MASTER)).toThrow("the sentence for slot 1 still carries a youth word: girl");
  });

  test("a revealing word", () => {
    expect(() => assembleSlot(DESCRIPTOR, slot({ category: "home" }), "She wears a bikini.", MASTER)).toThrow("the sentence for slot 1 still carries a revealing word: bikini");
  });
});

// S5.1a (T4): the assembler no longer reads a category's style. Every slot, built-in or custom, reads as the owner's own ordinary phone photo, so a
// custom category's stored `style: "editorial"` (still readable, I5.5) changes nothing in the prompt.
describe("a custom slot reads as an ordinary phone photo", () => {
  test("with no snapshot and no category library to ask", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER);
    expect(prompt).toContain("Ordinary phone photo");
    expect(prompt).not.toMatch(/editorial/i);
  });

  test("the custom category's name and id never reach the prompt", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER);
    expect(prompt).not.toContain(CUSTOM);
    expect(prompt).not.toContain(PHONE.name);
    expect(prompt).not.toContain(PHONE.label);
    expect(prompt).not.toContain(EDITORIAL.name);
  });

  test("the prompt is the same as a built-in's with the same fields: the category is not an input", () => {
    for (const category of ["home", "photoshoot", "travel"] as const) {
      expect(assembleSlot(DESCRIPTOR, slot({ category }), SENTENCE, MASTER).prompt).toBe(assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER).prompt);
    }
  });

  test("assembleRun assembles built-in and custom slots of one plan alike", () => {
    const slots = [slot({ slotIndex: 1, category: "photoshoot", attemptIdBase: "slot-1" }), slot({ slotIndex: 2, attemptIdBase: "slot-2" })];
    const sentences = new Map([
      [1, SENTENCE],
      [2, SENTENCE],
    ]);
    const prompts = assembleRun(DESCRIPTOR, { version: 1, seed: 1, slots }, sentences, MASTER, OPTIONS);
    for (const scene of prompts) {
      expect(scene.prompt).toContain("Ordinary phone photo");
      expect(scene.prompt).not.toMatch(/editorial/i);
    }
  });
});

// «Реализм камеры» on a custom category: the same ON and OFF lines as everywhere.
describe("camera realism on a custom category", () => {
  test("on: the camera-roll line, and no smartphone-vs-camera contradiction anywhere", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "photographer" }), SENTENCE, MASTER, { cameraRealism: true });

    expect(prompt).toContain("Ordinary phone photo straight from her camera roll");
    expect(prompt).not.toMatch(/editorial|photographer|full-frame|shot on a camera/i);
  });

  test("off adds nothing of the ON line", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, { cameraRealism: false });
    expect(prompt).not.toContain("camera roll");
  });

  test("a refused sentence is still refused with the switch on", () => {
    expect(() => assembleSlot(DESCRIPTOR, slot(), "The girl waves.", MASTER, { cameraRealism: true })).toThrow(AssemblerRefusalError);
  });

  test("a custom slot gets no room phrase from the assembler alone (custom categories have none until 5a.2)", () => {
    expect(assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, { cameraRealism: true }).prompt).not.toContain("The room ");
  });

  // The slot's own fields (place, time, activity, outfit) never reach the prompt: the writer's sentence carries them. What sets the prompt's size is
  // the descriptor, the sentence and the look lines, so the bound is measured with the descriptor at its own limit.
  test("the prompt with the descriptor at DESCRIPTOR_MAX_CHARS, a 400-character sentence and the ON line stays under 2000 characters", () => {
    const text = `25-year-old European woman, ${"light olive skin, warm hazel eyes, soft wavy chestnut hair, ".repeat(12)}`.slice(0, DESCRIPTOR_MAX_CHARS - 1) + ".";
    expect(text).toHaveLength(DESCRIPTOR_MAX_CHARS);
    const sentence = `${"She walks along the quay in the soft evening light, ".repeat(8)}`.slice(0, 399) + ".";
    for (const shot of ["friend", "selfie", "mirror", "candid"] as const) {
      const { prompt } = assembleSlot({ age: 25, text }, slot({ shot }), sentence, MASTER, { cameraRealism: true });
      expect(prompt).toContain(text);
      expect(prompt.length).toBeLessThan(2000);
    }
  });

  test("a custom slot's place, time, activity and outfit are not in the prompt at all, at their bounds or not", () => {
    const bounds = slot({ location: "lllll".repeat(7), activity: "aaaaa".repeat(7), outfit: "ooooo".repeat(7), timeOfDay: "t".repeat(15), shot: "photographer", pose: "three-quarter" });

    const { prompt } = assembleSlot(DESCRIPTOR, bounds, SENTENCE, MASTER, { cameraRealism: true });

    for (const field of [bounds.location, bounds.activity, bounds.outfit, bounds.timeOfDay]) expect(prompt).not.toContain(field);
  });
});
