import { describe, expect, test } from "bun:test";
import type { AvatarDescriptor } from "../../shared/engine";
import { PromptSubjectError } from "../avatars/prompts";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { plan } from "./planner";
import type { PlanSlot } from "./schema";
import { AssemblerRefusalError, assembleRun, assembleSlot } from "./assembler";
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
      ["front", "faces the camera"],
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
