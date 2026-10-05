import { describe, expect, test } from "bun:test";
import { youthWords } from "../../shared/engine";
import type { AvatarDescriptor } from "../../shared/engine";
import { PromptSubjectError } from "../avatars/prompts";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { plan } from "./planner";
import { PlanSlotSchema, PoseSchema, type PlanSlot } from "./schema";
import { SHOTS } from "./types";
import { revealingWordsIn } from "./words";
import { AssemblerRefusalError, assembleRun, assembleSlot, BINDING_ANCHOR, CAMERA_REALISM_CLAUSE, POSE_PHRASE, SHOT_PHRASE } from "./assembler";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T5b: the assembler. Pure, no I/O: given the avatar's descriptor, one plan
// slot, the writer's sentence for it and the avatar's master reference, it
// builds the exact final image prompt and names which reference(s) go with
// it. Deterministic: the same inputs always give the same prompt.

const DESCRIPTOR: AvatarDescriptor = {
  age: 25,
  text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose.",
};
const MASTER = asLibraryReference(JPEG);
const SENTENCE = "She leans on the balcony railing with a mug of coffee, watching the street wake up below in the soft morning light.";

function slot(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: "home",
    location: "a small balcony with potted plants",
    timeOfDay: "morning",
    activity: "holding a ceramic coffee mug",
    outfit: "an oversized cream knit sweater",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...overrides,
  };
}

describe("assembleSlot", () => {
  test("is deterministic: the same inputs give the exact same prompt", () => {
    const a = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER);
    const b = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER);
    expect(a).toEqual(b);
  });

  test("contains the descriptor's anchor text, via promptSubject only", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER);
    expect(prompt).toContain("25-year-old European woman, light olive skin, hazel eyes");
  });

  test("contains the writer's sentence", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER);
    expect(prompt).toContain("watching the street wake up below in the soft morning light");
  });

  test("contains the adult-woman and no-text/watermark constraints", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER);
    expect(prompt.toLowerCase()).toContain("adult woman");
    expect(prompt.toLowerCase()).toContain("watermark");
  });

  test.each([
    ["friend", "Photo taken by a friend"],
    ["selfie", "Front-camera selfie"],
    ["mirror", "Mirror selfie"],
    ["candid", "Candid shot"],
    ["photographer", "Photographed by a photographer"],
  ] as const)("the %s shot phrase names the shot", (shot, phrase) => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot }), SENTENCE, MASTER);
    expect(prompt).toContain(phrase);
  });

  test.each(["selfie", "mirror"] as const)("a %s slot's constraints say one hand holds the phone", (shot) => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot }), SENTENCE, MASTER);
    expect(prompt.toLowerCase()).toContain("one hand holds the phone");
  });

  test.each(["friend", "candid", "photographer"] as const)("a %s slot's constraints say nothing about a phone hand", (shot) => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot }), SENTENCE, MASTER);
    expect(prompt.toLowerCase()).not.toContain("holds the phone");
  });

  describe("pose (T5c)", () => {
    test.each([
      ["front", "oriented toward the camera"],
      ["three-quarter", "three-quarter"],
      ["profile", "profile"],
      ["back", "from behind"],
    ] as const)("the %s pose phrase is in the prompt", (pose, phrase) => {
      const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "friend", pose }), SENTENCE, MASTER);
      expect(prompt.toLowerCase()).toContain(phrase);
    });

    test("a back pose never says her face is clearly or fully visible", () => {
      const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "friend", pose: "back" }), SENTENCE, MASTER);
      expect(prompt.toLowerCase()).not.toContain("face clearly visible");
      expect(prompt.toLowerCase()).not.toContain("face fully visible");
    });

    test("a back pose's reference binding anchors on hair, build and posture, not her face", () => {
      const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "friend", pose: "back" }), SENTENCE, MASTER);
      expect(prompt.toLowerCase()).not.toContain("exact face");
      expect(prompt.toLowerCase()).toContain("hair");
      expect(prompt.toLowerCase()).toContain("build");
      expect(prompt.toLowerCase()).toContain("posture");
    });

    test("a profile pose's reference binding still names her facial profile", () => {
      const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "friend", pose: "profile" }), SENTENCE, MASTER);
      expect(prompt.toLowerCase()).toContain("profile");
    });

    test.each(["front", "three-quarter"] as const)("the %s pose's reference binding still anchors on her exact face", (pose) => {
      const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "friend", pose }), SENTENCE, MASTER);
      expect(prompt.toLowerCase()).toContain("exact face");
    });

    test("a selfie's shot phrase still says her face is visible, whatever the pose label adds", () => {
      const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "selfie", pose: "front" }), SENTENCE, MASTER);
      expect(prompt.toLowerCase()).toContain("face fully visible");
    });
  });

  test("uses the photoshoot's editorial realism suffix, not the phone-photo one", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ category: "photoshoot" }), SENTENCE, MASTER);
    expect(prompt).toContain("Editorial photo");
    expect(prompt).not.toContain("Smartphone photo");
  });

  test("every other category uses the smartphone realism suffix", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ category: "home" }), SENTENCE, MASTER);
    expect(prompt).toContain("Smartphone photo");
  });

  test("strips stop-words (marketing superlatives) even if the sentence carried one", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), "A stunning, flawless view of the street below.", MASTER);
    expect(prompt.toLowerCase()).not.toContain("stunning");
    expect(prompt.toLowerCase()).not.toContain("flawless");
  });

  // Review round 1 (LOW): stripping "stunning" and "flawless" left a
  // dangling comma ("A, view..."), because only the word was removed, never
  // an adjacent comma. The comma must go together with the word.
  test("stripping stop-words takes an adjacent comma with them, leaving no dangling punctuation", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), "A stunning, flawless view of the street below.", MASTER);
    expect(prompt).toContain("A view of the street below");
    expect(prompt).not.toContain("A,");
    expect(prompt).not.toMatch(/,\s*view/i);
  });

  test("a stop-word followed by a comma, with more text after, keeps that comma as the remaining separator", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), "A cozy nook, stunning, quiet and warm in the morning light.", MASTER);
    expect(prompt.toLowerCase()).not.toContain("stunning");
    expect(prompt).toContain("A cozy nook, quiet and warm");
  });

  test("binds exactly the given master reference, and nothing else", () => {
    const { references } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER);
    expect(references).toEqual([MASTER]);
  });

  test("carries the slot's own index", () => {
    const { slotIndex } = assembleSlot(DESCRIPTOR, slot({ slotIndex: 7 }), SENTENCE, MASTER);
    expect(slotIndex).toBe(7);
  });

  test("a descriptor that no longer passes today's contract is refused before any prompt is built", () => {
    const bad: AvatarDescriptor = { age: 25, text: "25-year-old European woman with a youthful smile." };
    expect(() => assembleSlot(bad, slot(), SENTENCE, MASTER)).toThrow(PromptSubjectError);
  });

  test("a writer sentence that still carries a youth word is refused as a last-resort gate (invariant 8)", () => {
    expect(() => assembleSlot(DESCRIPTOR, slot(), "A young girl waves from the balcony.", MASTER)).toThrow(AssemblerRefusalError);
  });

  test("a writer sentence that still carries a revealing word is refused as a last-resort gate", () => {
    expect(() => assembleSlot(DESCRIPTOR, slot({ category: "glamour" }), "She poses in a bikini by the mirror.", MASTER)).toThrow(
      AssemblerRefusalError,
    );
  });
});

// Round 2 review (HIGH): candid + front produced "she is not looking at the
// camera. She faces the camera, her face clearly visible." in the same
// prompt — a direct self-contradiction, and candid is a large share of real
// slots (2 of 5 shots in the default deck can land any pose). Every valid
// shot×pose combination the schema allows must read as one coherent scene:
// never both a "not looking at the camera" phrase and a "faces/looks at the
// camera" phrase in the same prompt.
describe("shot × pose coherence (round 2, HIGH)", () => {
  const NOT_LOOKING_AT_CAMERA = /\bnot\s+looking\s+(?:at|toward|towards|into)\s+the\s+camera\b/i;
  // A negative lookbehind for a preceding negator, so "not looking at the
  // camera" (which contains the bare substring "looking at the camera")
  // never also counts as an affirmative gaze claim — without it, every
  // candid slot's own NOT_LOOKING_AT_CAMERA match would also trip this
  // regex on itself, and the test would flag every candid pose as
  // self-contradicting instead of only the real bug (candid + front).
  // "faces/faced" the camera is transitive (no preposition needed: "she
  // faces the camera", not "faces at the camera") — a plain \bfaces?\b
  // followed by "at/toward/into" would never match it, which is exactly the
  // bug this test exists to catch (front's original phrase read "She faces
  // the camera" and slipped past a preposition-only regex).
  const NEGATOR = "(?:not|n't|never)\\s+";
  const LOOKS_AT_CAMERA = new RegExp(
    `\\b(?<!${NEGATOR})(?:look(?:s|ing)?|gaz(?:es|ing)?|star(?:es|ing)?)\\s+(?:directly\\s+)?(?:at|toward|towards|into)\\s+the\\s+camera\\b` +
      `|\\b(?<!${NEGATOR})faces?\\s+(?:directly\\s+)?(?:at\\s+)?the\\s+camera\\b`,
    "i",
  );

  function validCombos(): { shot: PlanSlot["shot"]; pose: PlanSlot["pose"] }[] {
    const combos: { shot: PlanSlot["shot"]; pose: PlanSlot["pose"] }[] = [];
    for (const shot of SHOTS) {
      for (const pose of PoseSchema.options) {
        const candidate = { ...slot(), shot, pose };
        if (PlanSlotSchema.safeParse(candidate).success) combos.push({ shot, pose });
      }
    }
    return combos;
  }

  test("every valid shot×pose pair yields at least one combination to check (sanity)", () => {
    expect(validCombos().length).toBeGreaterThan(10);
  });

  test.each(validCombos().map((c): [string, PlanSlot["shot"], PlanSlot["pose"]] => [`${c.shot}/${c.pose}`, c.shot, c.pose]))(
    "%s: never claims both looking and not-looking at the camera",
    (_label, shot, pose) => {
      const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot, pose }), SENTENCE, MASTER);
      const notLooking = NOT_LOOKING_AT_CAMERA.test(prompt);
      const looksAt = LOOKS_AT_CAMERA.test(prompt);
      expect(notLooking && looksAt).toBe(false);
    },
  );
});

// Round 2 review (LOW): the fixed phrase constants are engine-authored text
// that goes straight into every image prompt, exactly like the writer's
// sentence — so they must pass the same youth/revealing checks the writer's
// own answer and the descriptor gate are held to.
describe("phrase constants never suggest a minor or use a revealing word (round 2, LOW)", () => {
  function allPhrases(): [string, string][] {
    return [
      ...Object.entries(SHOT_PHRASE).map(([k, v]): [string, string] => [`SHOT_PHRASE.${k}`, v]),
      ...Object.entries(POSE_PHRASE).map(([k, v]): [string, string] => [`POSE_PHRASE.${k}`, v]),
      ...Object.entries(BINDING_ANCHOR).map(([k, v]): [string, string] => [`BINDING_ANCHOR.${k}`, v]),
    ];
  }

  test.each(allPhrases())("%s has no youth word and no revealing word", (_name, text) => {
    expect(youthWords(text, "descriptor")).toEqual([]);
    expect(revealingWordsIn(text)).toEqual([]);
  });
});

// «Реализм камеры»: one fixed clause, off unless asked for, appended after everything else.
describe("camera realism", () => {
  test("is not in the prompt by default", () => {
    expect(assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER).prompt).not.toContain(CAMERA_REALISM_CLAUSE);
  });

  test("is not in the prompt when switched off explicitly, and the prompt is then exactly the default one", () => {
    const plain = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER);
    expect(assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, { cameraRealism: false })).toEqual(plain);
  });

  test("ends the prompt when switched on, after the constraints, and leaves everything before it untouched", () => {
    const plain = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER).prompt;
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, { cameraRealism: true });
    expect(prompt).toBe(`${plain} ${CAMERA_REALISM_CLAUSE}`);
  });

  test("assembleRun passes the switch to every slot", () => {
    const scenePlan = plan({ seed: 1, count: 3, categories: ["home"] });
    const sentences = new Map(scenePlan.slots.map((s) => [s.slotIndex, SENTENCE]));
    const prompts = assembleRun(DESCRIPTOR, scenePlan, sentences, MASTER, { cameraRealism: true }).map((a) => a.prompt);
    expect(prompts.every((p) => p.endsWith(CAMERA_REALISM_CLAUSE))).toBe(true);
  });

  test("the clause is a short English sentence about the camera, with no youth word and no revealing word", () => {
    expect(CAMERA_REALISM_CLAUSE.length).toBeLessThanOrEqual(220);
    expect(youthWords(CAMERA_REALISM_CLAUSE, "descriptor")).toEqual([]);
    expect(revealingWordsIn(CAMERA_REALISM_CLAUSE)).toEqual([]);
    expect(CAMERA_REALISM_CLAUSE).toMatch(/skin texture/i);
    expect(CAMERA_REALISM_CLAUSE).toMatch(/no airbrushing/i);
  });

  test("the stop-word filter leaves the clause whole (it contains none of them)", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, { cameraRealism: true });
    expect(prompt.endsWith(CAMERA_REALISM_CLAUSE)).toBe(true);
  });

  test("every valid shot and pose with the clause stays well under 2000 characters", () => {
    for (const shot of SHOTS) {
      for (const pose of PoseSchema.options) {
        const candidate = { ...slot(), shot, pose };
        if (!PlanSlotSchema.safeParse(candidate).success) continue;
        const { prompt } = assembleSlot(DESCRIPTOR, candidate, SENTENCE, MASTER, { cameraRealism: true });
        expect(prompt.length).toBeLessThan(2000);
      }
    }
  });
});

describe("assembleRun", () => {
  test("assembles every slot of a real plan, one prompt each, bound to the master", () => {
    const scenePlan = plan({ seed: 1, count: 3, categories: ["home"] });
    const sentences = new Map(scenePlan.slots.map((s) => [s.slotIndex, SENTENCE]));

    const scenes = assembleRun(DESCRIPTOR, scenePlan, sentences, MASTER);

    expect(scenes).toHaveLength(3);
    expect(scenes.map((s) => s.slotIndex)).toEqual(scenePlan.slots.map((s) => s.slotIndex));
    for (const scene of scenes) expect(scene.references).toEqual([MASTER]);
  });

  test("throws when a slot has no sentence", () => {
    const scenePlan = plan({ seed: 1, count: 2, categories: ["home"] });
    const sentences = new Map([[scenePlan.slots[0]!.slotIndex, SENTENCE]]);

    expect(() => assembleRun(DESCRIPTOR, scenePlan, sentences, MASTER)).toThrow();
  });
});
