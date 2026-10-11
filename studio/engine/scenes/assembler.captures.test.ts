import { describe, expect, test } from "bun:test";
import { youthWords, type AvatarDescriptor } from "../../shared/engine";
import { captureOfShot, CAPTURES, shotOf, type Capture } from "../../shared/scenes/captures";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { assembleSlot, BINDING_ANCHOR, HIDDEN_FACE_POSE_PHRASE, MIRROR_BACK_POSE_PHRASE, POSE_PHRASE } from "./assembler";
import { artefactLine, captureLineOf, CONSTRAINTS, hairLine, imperfectionOf, lightOf, MIRROR_BACK_LINE, phoneHandLineOf, slotKeyOf } from "./phoneLook";
import { plan } from "./planner";
import { slotLookOf } from "./roomPlace";
import type { PlanSlot } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6b, plan s5a2 r1.5 §5.4): the assembler places the capture line by WHO TOOK THE PHOTO, the hand line, the back-to-the-mirror sentence of a tagged
// moment, the body binding by capture, the binding of a frame without her face, the lamp mood for «Дом» at evening and night, and the hair line.

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
const WITH_BODY: AvatarDescriptor = { ...DESCRIPTOR, body: "a slim build with narrow hips" };
const MASTER = asLibraryReference(JPEG);
const SENTENCE = "She waits by the window in the soft light.";
const RUN_ID = "run-a1b2c3";
const BODY_BINDING = ", and her exact body proportions as described";
const HIDDEN_FACE_ANCHOR = "with the exact hair colour and hair length from the reference photo, her build and skin tone";

function slotOf(capture: Capture, over: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: "home",
    location: "her bedroom",
    timeOfDay: "morning",
    activity: "adjusts the hem of her top",
    outfit: "silk pajamas",
    shot: shotOf(capture),
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...(capture === captureOfShot(shotOf(capture)) ? {} : { capture }),
    ...over,
  };
}

const assemble = (slot: PlanSlot, options: Partial<Parameters<typeof assembleSlot>[4]> = {}, descriptor = DESCRIPTOR): string => assembleSlot(descriptor, slot, SENTENCE, MASTER, { runId: RUN_ID, ...options }).prompt;
const keyOf = (slot: PlanSlot): string => slotKeyOf(RUN_ID, slot.attemptIdBase);

describe("the capture line opens the prompt, by who took the photo", () => {
  test.each([...CAPTURES])("%s", (capture) => {
    const slot = slotOf(capture);
    expect(assemble(slot).startsWith(captureLineOf(capture, keyOf(slot)))).toBe(true);
  });

  test("a slot stored before captures reads its capture from its shot: a photographer is a friend", () => {
    for (const shot of ["selfie", "mirror", "friend", "candid", "photographer"] as const) {
      const slot = slotOf("friend", { shot });
      expect(assemble(slot).startsWith(captureLineOf(captureOfShot(shot), keyOf(slot)))).toBe(true);
    }
  });
});

describe("back or side to the mirror", () => {
  test("a moment tagged mirrorBack adds the sentence straight after the capture line", () => {
    const slot = slotOf("mirror-hidden", { location: "her bathroom", activity: "sits on the counter by the mirror", outfit: "an open-back top and grey jeans", pose: "three-quarter" });
    const prompt = assemble(slot, { lookOf: slotLookOf });
    expect(prompt.startsWith(`${captureLineOf("mirror-hidden", keyOf(slot))} ${MIRROR_BACK_LINE}`)).toBe(true);
  });

  test("it is added by the tag alone: no sentence without the lookup, and none on any other moment of a real plan", () => {
    const tagged = slotOf("mirror-hidden", { location: "her bathroom", activity: "sits on the counter by the mirror", outfit: "an open-back top and grey jeans", pose: "three-quarter" });
    expect(assemble(tagged)).not.toContain(MIRROR_BACK_LINE);
    const tags = (activity: string): boolean => activity === "sits on the counter by the mirror" || activity === "stands sideways to the mirror";
    let seen = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const slot of plan({ seed, count: 60, categories: ["home", "travel", "photoshoot", "glamour", "fitness"], poses: { profile: true, back: true } }).slots) {
        const hit = assemble(slot, { lookOf: slotLookOf }).includes(MIRROR_BACK_LINE);
        expect(hit, `${slot.location} / ${slot.activity}`).toBe(tags(slot.activity));
        if (hit) seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("the pose phrase of a frame seen in profile to the mirror", () => {
  const counter = slotOf("mirror-hidden", { location: "her bathroom", activity: "sits on the counter by the mirror", outfit: "an open-back top and grey jeans", pose: "three-quarter" });

  test("a mirrorBack moment says she is in profile to the mirror with her face behind her phone, not turned three-quarter toward it", () => {
    const prompt = assemble(counter, { lookOf: slotLookOf });
    expect(prompt).toContain(MIRROR_BACK_POSE_PHRASE);
    expect(prompt).not.toContain(HIDDEN_FACE_POSE_PHRASE["three-quarter"]);
    expect(prompt).not.toContain("face clearly visible");
  });

  test("it is the tag that decides: the same frame without the lookup keeps the ordinary phrase", () => {
    expect(assemble(counter)).toContain(HIDDEN_FACE_POSE_PHRASE["three-quarter"]);
  });

  test("the phrase says profile and her reflection, and passes the same word lists", () => {
    expect(MIRROR_BACK_POSE_PHRASE).toMatch(/profile to the mirror/);
    expect(MIRROR_BACK_POSE_PHRASE).toMatch(/reflection/);
    expect(youthWords(MIRROR_BACK_POSE_PHRASE, "descriptor")).toEqual([]);
  });
});

describe("the hand line ends the prompt", () => {
  test.each([...CAPTURES])("%s", (capture) => {
    const hand = phoneHandLineOf(capture);
    const prompt = assemble(slotOf(capture));
    expect(prompt.endsWith(hand === null ? CONSTRAINTS : `${CONSTRAINTS} ${hand}`)).toBe(true);
  });

  test("the prone and above lines let the free hand act through a cue, and never say a second phone", () => {
    for (const capture of ["prone", "above"] as const) expect(assemble(slotOf(capture))).not.toMatch(/second phone|hips raised/i);
  });
});

describe("the body binding, by capture", () => {
  test.each<[Capture, boolean]>([
    ["mirror-hidden", true],
    ["mirror", true],
    ["prone", true],
    ["timer", true],
    ["friend", true],
    ["candid", true],
    ["above", false],
    ["selfie", false],
    ["over-shoulder", true],
  ])("%s: %s", (capture, on) => {
    expect(assemble(slotOf(capture), {}, WITH_BODY).includes(BODY_BINDING)).toBe(on);
  });

  test("never without a body on the avatar", () => {
    for (const capture of CAPTURES) expect(assemble(slotOf(capture))).not.toContain(BODY_BINDING);
  });
});

describe("the binding of a frame without her face", () => {
  test("a phone-over-face mirror selfie binds hair colour, hair length, build and skin tone, and not her face", () => {
    const prompt = assemble(slotOf("mirror-hidden"));
    expect(prompt).toContain(HIDDEN_FACE_ANCHOR);
    expect(prompt).not.toContain("her exact face");
  });

  test("it does not say her face is clearly visible, the phone is over it", () => {
    const prompt = assemble(slotOf("mirror-hidden"));
    expect(prompt).not.toContain("face clearly visible");
    expect(prompt).not.toContain(POSE_PHRASE.front);
  });

  test("every other capture keeps the pose's binding, a back pose too (the binding's wording is unchanged)", () => {
    for (const capture of ["mirror", "above", "prone", "timer", "friend", "candid", "selfie", "over-shoulder"] as const) {
      expect(assemble(slotOf(capture))).toContain(BINDING_ANCHOR.front);
    }
    expect(assemble(slotOf("friend", { pose: "back" }))).toContain(BINDING_ANCHOR.back);
  });
});

describe("the lamp mood (I5.34)", () => {
  const evening = slotOf("mirror-hidden", { timeOfDay: "evening" });

  test("a «Дом» lamp place at evening keeps the dim lamp light and drops «everything in focus»", () => {
    for (const cameraRealism of [true, false]) {
      const prompt = assemble(evening, { lookOf: slotLookOf, cameraRealism });
      expect(prompt).toContain(artefactLine({ cameraRealism, light: "x", imperfection: imperfectionOf(evening.shot, keyOf(evening)), lampMood: true }));
      expect(prompt).not.toContain("everything in focus");
    }
  });

  test("at night too; in the morning or at midday the line stays as before", () => {
    expect(assemble(slotOf("mirror-hidden", { timeOfDay: "night" }), { lookOf: slotLookOf })).toContain("dim evening light from a bedside lamp");
    for (const timeOfDay of ["morning", "midday"]) {
      const prompt = assemble(slotOf("mirror-hidden", { timeOfDay }), { lookOf: slotLookOf });
      expect(prompt).toContain("everything in focus, the background as sharp as she is");
      expect(prompt).not.toContain("bedside lamp");
    }
  });

  test("a place without a lamp keeps the line at night too, and so does every other category", () => {
    expect(assemble(slotOf("mirror-hidden", { location: "her hallway", timeOfDay: "night", activity: "stands with her weight on one hip" }), { lookOf: slotLookOf })).toContain("everything in focus");
    const glamour = slotOf("friend", { category: "glamour", location: "a cocktail bar", timeOfDay: "night", activity: "leans on the counter", outfit: "a navy wrap dress" });
    expect(assemble(glamour, { lookOf: slotLookOf })).toContain("everything in focus");
  });

  test("without the lookup nothing is lamp mood (an own scene, a custom category)", () => {
    expect(assemble(evening)).toContain(artefactLine({ cameraRealism: false, light: lightOf("evening"), imperfection: "" }));
  });
});

describe("the hair line (I5.25)", () => {
  test("sits after the binding and the descriptor, before the look's artefact line, on any kind of slot", () => {
    for (const capture of CAPTURES) {
      const slot = slotOf(capture);
      const prompt = assemble(slot, { hairStyleOf: () => "in a low ponytail" });
      const line = hairLine("in a low ponytail");
      expect(prompt).toContain(line);
      expect(prompt.indexOf(line)).toBeGreaterThan(prompt.indexOf(DESCRIPTOR.text));
      expect(prompt.indexOf(line)).toBeLessThan(prompt.indexOf("Ordinary phone photo"));
    }
  });

  test("no line when the style is null (a moment that names her hair), or there is no style source", () => {
    expect(assemble(slotOf("friend"), { hairStyleOf: () => null })).not.toContain("Today her hair");
    expect(assemble(slotOf("friend"))).not.toContain("Today her hair");
  });

  test("the colour is always the reference photo's", () => {
    expect(assemble(slotOf("friend"), { hairStyleOf: () => "half up, half down" })).toContain("the same hair colour as in the reference photo");
  });
});
