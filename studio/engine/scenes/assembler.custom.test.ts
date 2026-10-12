import { describe, expect, test } from "bun:test";
import { DESCRIPTOR_MAX_CHARS, youthWords, type AvatarDescriptor, type CategorySnapshot } from "../../shared/engine";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { AssemblerRefusalError, assembledScenes, assembleRun, assembleSlot as assembleWith, sentenceProblems, type AssembleOptions } from "./assembler";
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
    const prompts = assembledScenes(assembleRun(DESCRIPTOR, { version: 1, seed: 1, slots }, sentences, MASTER, OPTIONS));
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

// C3′ (the Grok probe c3fix 4b): glancing back over her shoulder, her face shows at three-quarter, even under «Photographed from behind, her face not visible». A
// frame someone else takes of her glancing back says so, whatever its pose; a self-shot keeps its own capture line.
describe("C3′: a frame that glances back over her shoulder never says her face is not visible", () => {
  const promptOf = (overrides: Partial<PlanSlot>): string => assembleSlot(DESCRIPTOR, slot(overrides), "On a bridge, she is looking back over her shoulder, wearing a beige trench coat and jeans.", MASTER).prompt;

  test("at three-quarter, a friend's photo of it is half from behind, her face visible", () => {
    const prompt = promptOf({ pose: "three-quarter", activity: "looking back over her shoulder" });
    expect(prompt).toContain("Seen half from behind, her face turned back to a three-quarter angle, clearly visible.");
    expect(prompt).not.toContain("Her face and body turned to a three-quarter angle");
  });

  test("a custom back frame of it is from behind with her head turned back, never «her face not visible»", () => {
    for (const activity of ["looking back over her shoulder", "glancing back at the river", "peeking over her shoulder"]) {
      const prompt = promptOf({ pose: "back", activity });
      expect(prompt, activity).toContain("Photographed from behind, her head turned back over her shoulder, her face in profile.");
      expect(prompt, activity).not.toContain("her face not visible");
    }
  });

  test("a back frame that does not glance back keeps «Photographed from behind, her face not visible»", () => {
    expect(promptOf({ pose: "back", activity: "leaning on the railing" })).toContain("Photographed from behind, her face not visible.");
    expect(promptOf({ pose: "back", activity: "carrying her bag over her shoulder" })).toContain("Photographed from behind, her face not visible.");
  });

  test("a selfie of it keeps the three-quarter phrase: she takes it herself", () => {
    expect(promptOf({ shot: "selfie", pose: "three-quarter", activity: "looking back over her shoulder" })).toContain("Her face and body turned to a three-quarter angle, face clearly visible.");
  });
});

// C3′ (the owner's verdict, 2026-10-12): Grok drew the owner's «В домашнем» «a tank top and shorts» (R4#04) and «Улица»'s «a hoodie, a mini skirt and sneakers» (R3#03) as
// DENIM. The banks now name every fabric; a custom pool's outfit, the writer's and an idea's may still not, so the assembled prompt says the probe's «her shorts are not
// denim» (c3fix 3a, drawn without denim) right after the outfit, or as a sentence of its own when the outfit is not there word for word. The stored sentence is untouched.
describe("C3′: an outfit that names a skirt or shorts without its fabric is said not to be denim", () => {
  const promptOf = (sentence: string, overrides: Partial<PlanSlot> = {}): string => assembleSlot(DESCRIPTOR, slot(overrides), sentence, MASTER).prompt;

  test("the owner's custom «a tank top and shorts» (R4#04): the clause follows the outfit in the template's sentence", () => {
    const sentence = "In her bedroom by the window, she is holding her coffee, wearing a tank top and shorts, her eyes lowered, a wide, easy grin.";
    expect(promptOf(sentence, { outfit: "a tank top and shorts" })).toContain("wearing a tank top and shorts, her shorts are not denim, her eyes lowered, a wide, easy grin.");
  });

  test("an outfit with commas of its own (R3#03): the clause follows the whole outfit, as the probe sent it", () => {
    const sentence = "On a colourful side street, she looks back over her shoulder, wearing a hoodie, a mini skirt and sneakers, a small, easy smile, with a bicycle by the curb.";
    expect(promptOf(sentence, { outfit: "a hoodie, a mini skirt and sneakers" })).toContain("wearing a hoodie, a mini skirt and sneakers, her skirt is not denim, a small, easy smile,");
  });

  test("an outfit that runs on with legwear takes the clause after the legwear", () => {
    expect(promptOf("In her room, she is stretching, wearing a tee and shorts with white socks, smiling.", { outfit: "a tee and shorts" })).toContain(
      "wearing a tee and shorts with white socks, her shorts are not denim, smiling.",
    );
  });

  test("the writer's own wording of the outfit: the clause is a sentence of its own after the scene's", () => {
    const prompt = promptOf("She stands by the window in a tank top and soft shorts, laughing.", { outfit: "a tank top and shorts" });
    expect(prompt).toContain("She stands by the window in a tank top and soft shorts, laughing. Her shorts are not denim. ");
  });

  test("an idea's own scene (no stored outfit) names a mini skirt: the clause is a sentence of its own", () => {
    const own: OwnPlanSlot = { kind: "own", slotIndex: 2, category: "own", shot: "friend", pose: "front", attemptIdBase: "slot-2", sentence: "She sits on the pier in a striped tee and a mini skirt." };
    expect(assembleSlot(DESCRIPTOR, own, own.sentence, MASTER).prompt).toContain("She sits on the pier in a striped tee and a mini skirt. Her skirt is not denim. ");
  });

  test("an outfit that names its fabric, or no skirt or shorts at all, gets no clause", () => {
    expect(promptOf("On a bridge, she is leaning on the railing, wearing a tank top and cotton shorts, smiling.", { outfit: "a tank top and cotton shorts" })).not.toContain("denim");
    expect(promptOf(SENTENCE)).not.toContain("not denim");
    expect(promptOf("On a bridge, she is leaning on the railing, wearing a beige trench coat and jeans.")).not.toContain("not denim");
  });

  // Review (C3′ round 2): the clause read the whole scene sentence, so «mini golf» or «a mini backpack» made her skirt not denim.
  test("a slot with a stored outfit is judged by its outfit alone: mini golf in trousers gets no clause", () => {
    expect(promptOf("On a sunny green, she is playing mini golf, wearing a tee and trousers.", { outfit: "a tee and trousers" })).not.toContain("denim");
    expect(promptOf("By the lake, she is carrying a mini backpack, wearing a striped tee and chinos.", { outfit: "a striped tee and chinos" })).not.toContain("denim");
  });

  test("a stored outfit with bare shorts takes the clause once, whatever else the sentence names", () => {
    const prompt = promptOf("By the lake, she is carrying a mini backpack, wearing a tee and shorts, smiling.", { outfit: "a tee and shorts" });
    expect(prompt).toContain("wearing a tee and shorts, her shorts are not denim, smiling.");
    expect(prompt.split("not denim").length - 1).toBe(1);
  });

  test("an idea's own scene about mini golf in Bermuda names no bottom: no clause", () => {
    const own: OwnPlanSlot = { kind: "own", slotIndex: 2, category: "own", shot: "friend", pose: "front", attemptIdBase: "slot-2", sentence: "She is playing mini golf in Bermuda in a tee and trousers." };
    expect(assembleSlot(DESCRIPTOR, own, own.sentence, MASTER).prompt).not.toContain("denim");
  });

  test("an outfit that already says it is not denim is not told twice", () => {
    for (const outfit of ["a mini skirt (not denim) and a tee", "a tank top and shorts, not denim"]) {
      const prompt = promptOf(`On a bridge, she is leaning on the railing, wearing ${outfit}, smiling.`, { outfit });
      expect(prompt.split("not denim").length - 1, outfit).toBe(1);
    }
  });

  test("the sentence the writer or the template stored is the one the scene keeps: only the prompt says it", () => {
    const sentence = "In her bedroom by the window, she is holding her coffee, wearing a tank top and shorts, smiling.";
    const [result] = assembleRun(DESCRIPTOR, { slots: [slot({ outfit: "a tank top and shorts" })] }, new Map([[1, sentence]]), MASTER, OPTIONS);
    expect(result?.ok === true ? result.prompt : "").toContain("her shorts are not denim");
    expect(sentence).not.toContain("denim");
  });
});
