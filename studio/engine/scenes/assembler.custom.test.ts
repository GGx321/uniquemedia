import { describe, expect, test } from "bun:test";
import { youthWords, type AvatarDescriptor, type CategorySnapshot } from "../../shared/engine";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { AssemblerRefusalError, assembleRun, assembleSlot, sentenceProblems } from "./assembler";
import type { PlanSlot } from "./schema";
import { revealingWordsIn } from "./words";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.1: the assembler picks the realism suffix from the plan's snapshot for a
// custom category, and its last-gate sentence check is one exported function
// that the owner's edit-time check can call too.

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair." };
const MASTER = asLibraryReference(JPEG);
const SENTENCE = "She leans on the bridge railing as the evening light turns the river gold.";
const CUSTOM = "cat-paris-cafes";
const PHONE: CategorySnapshot = { ref: CUSTOM, name: "Кофейни Парижа", label: "Paris cafes", style: "phone" };
const EDITORIAL: CategorySnapshot = { ...PHONE, style: "editorial" };

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

describe("a custom slot's realism suffix is its snapshot's style", () => {
  test("phone style gets the smartphone suffix", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, [PHONE]);
    expect(prompt).toContain("Smartphone photo");
    expect(prompt).not.toContain("Editorial photo");
  });

  test("editorial style gets the editorial suffix", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, [EDITORIAL]);
    expect(prompt).toContain("Editorial photo");
    expect(prompt).not.toContain("Smartphone photo");
  });

  test("a custom slot with no snapshot entry is refused before any prompt is built", () => {
    expect(() => assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER)).toThrow(RangeError);
    expect(() => assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, [])).toThrow(RangeError);
  });

  test("the custom category's name and id never reach the prompt", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, [PHONE]);
    expect(prompt).not.toContain(CUSTOM);
    expect(prompt).not.toContain("Кофейни");
    expect(prompt).not.toContain("Paris cafes");
  });
});

describe("a built-in slot's prompt does not depend on the snapshot", () => {
  test("photoshoot stays editorial and home stays phone, snapshot or not", () => {
    for (const snapshots of [[], [PHONE], [EDITORIAL]]) {
      expect(assembleSlot(DESCRIPTOR, slot({ category: "photoshoot" }), SENTENCE, MASTER, snapshots).prompt).toContain("Editorial photo");
      expect(assembleSlot(DESCRIPTOR, slot({ category: "home" }), SENTENCE, MASTER, snapshots).prompt).toContain("Smartphone photo");
    }
  });

  test("the prompt is byte-identical with and without a snapshot", () => {
    expect(assembleSlot(DESCRIPTOR, slot({ category: "travel" }), SENTENCE, MASTER, [EDITORIAL]).prompt).toBe(assembleSlot(DESCRIPTOR, slot({ category: "travel" }), SENTENCE, MASTER).prompt);
  });
});

describe("assembleRun with a snapshot", () => {
  test("assembles built-in and custom slots in one plan, each by its own style", () => {
    const slots = [slot({ slotIndex: 1, category: "photoshoot", attemptIdBase: "slot-1" }), slot({ slotIndex: 2, attemptIdBase: "slot-2" })];
    const sentences = new Map([
      [1, SENTENCE],
      [2, SENTENCE],
    ]);
    const prompts = assembleRun(DESCRIPTOR, { version: 1, seed: 1, slots }, sentences, MASTER, [PHONE]);
    expect(prompts[0]?.prompt).toContain("Editorial photo");
    expect(prompts[1]?.prompt).toContain("Smartphone photo");
  });
});
