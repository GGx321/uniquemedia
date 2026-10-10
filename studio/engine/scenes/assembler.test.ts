import { describe, expect, test } from "bun:test";
import { youthWords } from "../../shared/engine";
import type { AvatarDescriptor } from "../../shared/engine";
import { PromptSubjectError } from "../avatars/prompts";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { plan } from "./planner";
import { POOL_TIMES } from "../../shared/engine";
import { PlanSlotSchema, PoseSchema, type OwnPlanSlot, type PlanSlot } from "./schema";
import { SHOTS } from "./types";
import { revealingWordsIn } from "./words";
import { AssemblerRefusalError, assembleRun, assembleSlot as assembleWith, BINDING_ANCHOR, POSE_PHRASE, type AssembleOptions } from "./assembler";
import { artefactLine, CAPTURE_LINE, CONSTRAINTS, imperfectionOf, lightOf, NEUTRAL_LIGHT, phoneHandLine, roomStateOf, slotKeyOf, type RoomPlace } from "./phoneLook";
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

const RUN_ID = "run-a1b2c3";
const OPTIONS: AssembleOptions = { runId: RUN_ID };

/** assembleSlot with the run id every call needs (the look draws are seeded from it). */
function assembleSlot(descriptor: AvatarDescriptor, planSlot: PlanSlot | OwnPlanSlot, sentence: string, master: typeof MASTER, options: Partial<AssembleOptions> = {}) {
  return assembleWith(descriptor, planSlot, sentence, master, { ...OPTIONS, ...options });
}

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

  test.each([...SHOTS])("the %s capture line is the first sentence of the prompt", (shot) => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot }), SENTENCE, MASTER);
    expect(prompt.startsWith(CAPTURE_LINE[shot])).toBe(true);
  });

  test("a mirror slot's constraints say one hand holds the phone", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "mirror" }), SENTENCE, MASTER);
    expect(prompt).toContain("One hand holds the phone; only her other hand acts.");
  });

  test("a selfie slot's constraints say her phone arm runs out of the frame, and never that a hand holds the phone", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "selfie" }), SENTENCE, MASTER);
    expect(prompt).toContain("Her phone arm runs out of the frame; only her other hand acts.");
    expect(prompt.toLowerCase()).not.toContain("holds the phone");
  });

  test.each(["friend", "candid", "photographer"] as const)("a %s slot's constraints say nothing about a phone hand", (shot) => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot }), SENTENCE, MASTER);
    expect(prompt.toLowerCase()).not.toContain("phone hand");
    expect(prompt.toLowerCase()).not.toContain("holds the phone");
    expect(prompt.toLowerCase()).not.toContain("phone arm");
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

    test("a selfie's pose phrase still says her face is clearly visible", () => {
      const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "selfie", pose: "front" }), SENTENCE, MASTER);
      expect(prompt.toLowerCase()).toContain("face clearly visible");
    });

    test.each([
      ["front", "the exact hair colour from the reference photo"],
      ["three-quarter", "the exact hair colour from the reference photo"],
      ["profile", "the exact hair colour from the reference photo and build"],
      ["back", "the exact hair colour from the reference photo, her build and posture"],
    ] as const)("the %s binding asks for the exact hair colour from the reference photo (C-21)", (pose, phrase) => {
      const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "friend", pose }), SENTENCE, MASTER);
      expect(prompt).toContain(phrase);
      expect(prompt.toLowerCase()).not.toContain("natural hair");
    });

    test("the binding no longer names the hairline", () => {
      for (const pose of PoseSchema.options) expect(BINDING_ANCHOR[pose]).not.toContain("hairline");
    });
  });

  test("a photoshoot slot reads as an ordinary phone photo too, never as an editorial one (T4)", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ category: "photoshoot", shot: "photographer" }), SENTENCE, MASTER);
    expect(prompt).toContain("Ordinary phone photo");
    expect(prompt).not.toMatch(/editorial/i);
    expect(prompt).not.toMatch(/photographer/i);
  });

  test("every other category reads as an ordinary phone photo", () => {
    for (const category of ["home", "travel", "glamour", "fitness"] as const) {
      expect(assembleSlot(DESCRIPTOR, slot({ category }), SENTENCE, MASTER).prompt).toContain("Ordinary phone photo");
    }
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
      ...Object.entries(CAPTURE_LINE).map(([k, v]): [string, string] => [`CAPTURE_LINE.${k}`, v]),
      ...Object.entries(POSE_PHRASE).map(([k, v]): [string, string] => [`POSE_PHRASE.${k}`, v]),
      ...Object.entries(BINDING_ANCHOR).map(([k, v]): [string, string] => [`BINDING_ANCHOR.${k}`, v]),
      ["CONSTRAINTS", CONSTRAINTS],
    ];
  }

  test.each(allPhrases())("%s has no youth word and no revealing word", (_name, text) => {
    expect(youthWords(text, "descriptor")).toEqual([]);
    expect(revealingWordsIn(text)).toEqual([]);
  });
});

// S5.1a: the order of a prompt (plan 6.2): capture line, pose phrase, sentence, room phrase, binding + descriptor, artefact line, constraints.
describe("the order of a prompt (T6)", () => {
  const ROOM: RoomPlace = { room: true, details: ["a kettle on the counter", "a fruit bowl"], activity: { messyOk: false } };
  const withRoom = { roomPlaceOf: () => ROOM };

  test.each([true, false])("with cameraRealism %p the parts come in the settled order", (cameraRealism) => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "friend", pose: "front" }), SENTENCE, MASTER, { cameraRealism, ...withRoom });
    const room = roomStateOf(slotKeyOf(RUN_ID, "slot-1"), ROOM) ?? "";
    expect(room).not.toBe("");
    const parts = [
      CAPTURE_LINE.friend,
      POSE_PHRASE.front,
      "She leans on the balcony railing",
      room,
      "The same woman as in the reference photo",
      "25-year-old European woman",
      "Ordinary phone photo",
      CONSTRAINTS,
    ];
    const order = parts.map((part) => prompt.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  test("a prompt without a room lookup has no room phrase", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER);
    expect(prompt).not.toContain("The room ");
  });

  test("a lookup that finds no place (an old plan's renamed place) adds no room phrase", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, { roomPlaceOf: () => null });
    expect(prompt).not.toContain("The room ");
  });

  test("the lookup is asked about the slot being assembled", () => {
    const asked: number[] = [];
    assembleSlot(DESCRIPTOR, slot({ slotIndex: 4, attemptIdBase: "slot-4" }), SENTENCE, MASTER, {
      roomPlaceOf: (s) => {
        asked.push(s.slotIndex);
        return null;
      },
    });
    expect(asked).toEqual([4]);
  });

  test("the normalised text carries no doubled space, no dangling comma and no doubled full stop", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "selfie" }), SENTENCE, MASTER, { cameraRealism: true, ...withRoom });
    expect(prompt).not.toMatch(/\s{2,}|,\s*\.|\.\./);
  });
});

// «Реализм камеры»: both lines exist. ON adds the camera-roll artefacts and the slot's imperfection; OFF carries the light and the sharp background.
describe("camera realism (artefact line)", () => {
  const key = slotKeyOf(RUN_ID, "slot-1");

  test("off (the default): the OFF artefact line carries the slot's light", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ timeOfDay: "morning" }), SENTENCE, MASTER);
    expect(prompt).toContain(artefactLine({ cameraRealism: false, light: "morning daylight", imperfection: "" }));
  });

  test("off explicitly is the same prompt as the default", () => {
    expect(assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, { cameraRealism: false })).toEqual(assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER));
  });

  test("on: the ON artefact line carries the light and the slot's imperfection", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ timeOfDay: "evening", shot: "friend" }), SENTENCE, MASTER, { cameraRealism: true });
    expect(prompt).toContain(artefactLine({ cameraRealism: true, light: lightOf("evening"), imperfection: imperfectionOf("friend", key) }));
  });

  test("on: the imperfection is drawn from the author's own list (a mirror gets mirror smudges, never a motion blur)", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "mirror" }), SENTENCE, MASTER, { cameraRealism: true });
    expect(prompt).toContain(imperfectionOf("mirror", key));
    expect(prompt).not.toContain("motion blur");
  });

  test("off: the imperfection and the camera-roll artefacts are not in the prompt", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "friend" }), SENTENCE, MASTER);
    for (const text of ["motion blur", "washed-out", "white balance", "camera roll", "JPEG"]) expect(prompt).not.toContain(text);
  });

  test("the light of every stored time of day reaches the prompt as its source", () => {
    for (const time of POOL_TIMES) expect(assembleSlot(DESCRIPTOR, slot({ timeOfDay: time }), SENTENCE, MASTER).prompt).toContain(lightOf(time));
  });

  test("a time the table does not know gets the neutral light", () => {
    expect(assembleSlot(DESCRIPTOR, slot({ timeOfDay: "twilight" }), SENTENCE, MASTER).prompt).toContain(NEUTRAL_LIGHT);
  });

  test("the stored times «golden hour» and «studio lighting» never reach the prompt", () => {
    for (const time of ["golden hour", "studio lighting"]) {
      const { prompt } = assembleSlot(DESCRIPTOR, slot({ timeOfDay: time }), SENTENCE, MASTER, { cameraRealism: true });
      expect(prompt.toLowerCase()).not.toContain("golden hour");
      expect(prompt.toLowerCase()).not.toContain("studio lighting");
    }
  });

  test("an own scene (no place, no time) gets the neutral light", () => {
    const own: OwnPlanSlot = { kind: "own", slotIndex: 3, category: "own", shot: "selfie", pose: "front", attemptIdBase: "slot-3", sentence: SENTENCE };
    expect(assembleSlot(DESCRIPTOR, own, SENTENCE, MASTER).prompt).toContain(NEUTRAL_LIGHT);
  });

  test("the artefact line comes before the constraints, and the constraints end the prompt of a friend slot", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "friend" }), SENTENCE, MASTER, { cameraRealism: true });
    expect(prompt.endsWith(CONSTRAINTS)).toBe(true);
    expect(prompt.indexOf("Ordinary phone photo straight from her camera roll")).toBeLessThan(prompt.indexOf(CONSTRAINTS));
  });

  test("the prompt of a selfie ends with the phone-arm line after the constraints", () => {
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot: "selfie" }), SENTENCE, MASTER);
    expect(prompt.endsWith(`${CONSTRAINTS} ${phoneHandLine("selfie")}`)).toBe(true);
  });

  test("the stop-word filter leaves both artefact lines whole (they contain none of them)", () => {
    for (const cameraRealism of [true, false]) {
      const { prompt } = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, { cameraRealism });
      expect(prompt).toContain(artefactLine({ cameraRealism, light: lightOf("morning"), imperfection: imperfectionOf("friend", key) }));
    }
  });

  test("every valid shot and pose with the switch on stays well under 2000 characters", () => {
    for (const shot of SHOTS) {
      for (const pose of PoseSchema.options) {
        for (const category of ["home", "photoshoot"] as const) {
          const candidate = { ...slot(), category, shot, pose };
          if (!PlanSlotSchema.safeParse(candidate).success) continue;
          const { prompt } = assembleSlot(DESCRIPTOR, candidate, SENTENCE, MASTER, { cameraRealism: true });
          expect(prompt.length).toBeLessThan(2000);
        }
      }
    }
  });
});

// I5.4: the draws are pure functions of the slot's key.
describe("deterministic per slot (I5.4)", () => {
  test("the same run and slot assemble a byte-identical prompt every time", () => {
    const a = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, { cameraRealism: true });
    const b = assembleSlot(DESCRIPTOR, slot(), SENTENCE, MASTER, { cameraRealism: true });
    expect(a.prompt).toBe(b.prompt);
  });

  test("the plan's seed is not an input: two plans of one run id and slot assemble the same prompt", () => {
    const options = { ...OPTIONS, cameraRealism: true };
    const first = assembleRun(DESCRIPTOR, { version: 1, seed: 1, slots: [slot()] }, new Map([[1, SENTENCE]]), MASTER, options);
    const second = assembleRun(DESCRIPTOR, { version: 1, seed: 0, slots: [slot()] }, new Map([[1, SENTENCE]]), MASTER, options);
    expect(first[0]?.prompt).toBe(second[0]?.prompt);
  });

  test("different runs of the same slot draw different imperfections", () => {
    const prompts = new Set(Array.from({ length: 40 }, (_, i) => assembleWith(DESCRIPTOR, slot(), SENTENCE, MASTER, { runId: `run-${i}`, cameraRealism: true }).prompt));
    expect(prompts.size).toBeGreaterThan(1);
  });

  test("different slots of one run draw different imperfections", () => {
    const prompts = new Set(Array.from({ length: 12 }, (_, i) => assembleSlot(DESCRIPTOR, slot({ slotIndex: i + 1, attemptIdBase: `slot-${i + 1}` }), SENTENCE, MASTER, { cameraRealism: true }).prompt));
    expect(prompts.size).toBeGreaterThan(1);
  });
});

// I5.2 / I5.3 / I5.10 over every shot × pose × category × time × switch (the full sweeps over plans are S5.1d's).
describe("what no new prompt may say", () => {
  const HELD_PHONE = [/holds? (the|her) phone/i, /phone in (her|one) hand/i, /phone (is )?visible/i];
  const STAGING = [/only she is in focus/i, /full-frame/i, /editorial/i, /shot on a camera/i, /photographer/i, /bokeh/i, /studio lighting/i, /golden hour/i, /softly lit/i];
  const NEGATED_LOOK = [/\bno (retouching|airbrushing|beauty filter|bokeh|blur|makeup filter)\b/i, /not retouched/i, /without retouching/i];
  const PHONE_NOT_IN_PICTURE = /phone itself is not in the picture/;

  function everyPrompt(): { label: string; shot: PlanSlot["shot"]; prompt: string }[] {
    const out: { label: string; shot: PlanSlot["shot"]; prompt: string }[] = [];
    for (const shot of SHOTS) {
      for (const pose of PoseSchema.options) {
        for (const category of ["home", "travel", "photoshoot", "glamour", "fitness"] as const) {
          for (const time of [...POOL_TIMES, "twilight"]) {
            const candidate = { ...slot(), category, shot, pose, timeOfDay: time };
            if (!PlanSlotSchema.safeParse(candidate).success) continue;
            for (const cameraRealism of [true, false]) {
              out.push({ label: `${category}/${shot}/${pose}/${time}/${cameraRealism ? "on" : "off"}`, shot, prompt: assembleSlot(DESCRIPTOR, candidate, SENTENCE, MASTER, { cameraRealism }).prompt });
            }
          }
        }
      }
    }
    return out;
  }

  test("the sweep covers a few hundred prompts (sanity)", () => {
    expect(everyPrompt().length).toBeGreaterThan(300);
  });

  test("I5.3: no camera or staging word in any prompt", () => {
    for (const { label, prompt } of everyPrompt()) for (const pattern of STAGING) expect({ label, hit: pattern.test(prompt) }).toEqual({ label, hit: false });
  });

  test("I5.10: no negated look term in any prompt", () => {
    for (const { label, prompt } of everyPrompt()) for (const pattern of NEGATED_LOOK) expect({ label, hit: pattern.test(prompt) }).toEqual({ label, hit: false });
  });

  test("I5.2: no prompt but a mirror's shows or holds a phone", () => {
    for (const { label, shot, prompt } of everyPrompt()) {
      if (shot === "mirror") continue;
      for (const pattern of HELD_PHONE) expect({ label, hit: pattern.test(prompt) }).toEqual({ label, hit: false });
    }
  });

  test("a selfie's prompt says the phone itself is not in the picture; no other author's does", () => {
    for (const { label, shot, prompt } of everyPrompt()) expect({ label, says: PHONE_NOT_IN_PICTURE.test(prompt) }).toEqual({ label, says: shot === "selfie" });
  });

  // The look text may say «phone» only as the kind of photo («Ordinary phone photo», «A quick phone snap», «her phone's front camera»), in the selfie
  // line's «the phone itself is not in the picture» and in the selfie phone-hand line. Activities are S5.1c's concern: the sentence here has none.
  test("I5.2: outside those places, no non-mirror prompt names a phone", () => {
    const allowed = /Ordinary phone photo|A quick phone snap|her phone's front camera|the phone itself is not in the picture|Her phone arm runs out of the frame/g;
    for (const { label, shot, prompt } of everyPrompt()) {
      if (shot === "mirror") continue;
      expect({ label, left: prompt.replace(allowed, "").match(/\bphones?\b/i)?.[0] ?? null }).toEqual({ label, left: null });
    }
  });

  test("the adult-woman line is in every prompt (I5.13)", () => {
    for (const { label, prompt } of everyPrompt()) expect({ label, adult: prompt.includes("She is an adult woman.") }).toEqual({ label, adult: true });
  });
});

describe("assembleRun", () => {
  test("assembles every slot of a real plan, one prompt each, bound to the master", () => {
    const scenePlan = plan({ seed: 1, count: 3, categories: ["home"] });
    const sentences = new Map(scenePlan.slots.map((s) => [s.slotIndex, SENTENCE]));

    const scenes = assembleRun(DESCRIPTOR, scenePlan, sentences, MASTER, OPTIONS);

    expect(scenes).toHaveLength(3);
    expect(scenes.map((s) => s.slotIndex)).toEqual(scenePlan.slots.map((s) => s.slotIndex));
    for (const scene of scenes) expect(scene.references).toEqual([MASTER]);
  });

  test("throws when a slot has no sentence", () => {
    const scenePlan = plan({ seed: 1, count: 2, categories: ["home"] });
    const sentences = new Map([[scenePlan.slots[0]!.slotIndex, SENTENCE]]);

    expect(() => assembleRun(DESCRIPTOR, scenePlan, sentences, MASTER, OPTIONS)).toThrow();
  });
});

// Stage 5, S5.2c: the binding keeps the body. «, and her exact body proportions as described» joins the reference binding only when the avatar has a body
// and the shot is not a selfie (a selfie crops to the face and arm). The phrase itself rides in the descriptor via promptSubject, once.
describe("the body in the reference binding (S5.2c)", () => {
  const BODY_CLAUSE = "and her exact body proportions as described";
  const BODY_PHRASE = "tall, hourglass figure, full bust";
  const WITH_BODY: AvatarDescriptor = { ...DESCRIPTOR, body: BODY_PHRASE };

  test.each(["front", "three-quarter", "profile", "back"] as const)("a %s shot with a body adds the body clause to the binding", (pose) => {
    const { prompt } = assembleSlot(WITH_BODY, slot({ shot: "friend", pose }), SENTENCE, MASTER);
    expect(prompt).toContain(`${BINDING_ANCHOR[pose]}, ${BODY_CLAUSE}; `);
  });

  test.each(["friend", "mirror", "candid", "photographer"] as const)("a %s shot with a body gets the clause", (shot) => {
    const { prompt } = assembleSlot(WITH_BODY, slot({ shot }), SENTENCE, MASTER);
    expect(prompt).toContain(BODY_CLAUSE);
  });

  test("a selfie with a body gets the phrase in the descriptor but not the clause", () => {
    const { prompt } = assembleSlot(WITH_BODY, slot({ shot: "selfie" }), SENTENCE, MASTER);
    expect(prompt).not.toContain(BODY_CLAUSE);
    expect(prompt).toContain(`; ${BODY_PHRASE}.`);
  });

  test("the clause comes once, and the body phrase comes once, after the descriptor text", () => {
    const { prompt } = assembleSlot(WITH_BODY, slot({ shot: "friend" }), SENTENCE, MASTER);
    expect(prompt.split(BODY_CLAUSE)).toHaveLength(2);
    expect(prompt.split(BODY_PHRASE)).toHaveLength(2);
    expect(prompt.indexOf(BODY_CLAUSE)).toBeLessThan(prompt.indexOf(BODY_PHRASE));
  });

  test.each(SHOTS.flatMap((shot) => PoseSchema.options.map((pose) => [shot, pose] as const)))("with no body a %s/%s prompt has no clause and the binding alone", (shot, pose) => {
    if ((shot === "selfie" || shot === "mirror") && pose !== "front" && pose !== "three-quarter") return;
    const { prompt } = assembleSlot(DESCRIPTOR, slot({ shot, pose }), SENTENCE, MASTER);
    expect(prompt).not.toContain(BODY_CLAUSE);
    expect(prompt).toContain(`${BINDING_ANCHOR[pose]}; ${DESCRIPTOR.text.replace(/\.$/, "")}. `);
  });

  test("a prompt with a body differs from the one without only by the clause and the phrase", () => {
    const base = assembleSlot(DESCRIPTOR, slot({ shot: "friend" }), SENTENCE, MASTER).prompt;
    const withBody = assembleSlot(WITH_BODY, slot({ shot: "friend" }), SENTENCE, MASTER).prompt;
    expect(withBody.replace(`, ${BODY_CLAUSE}`, "").replace(`; ${BODY_PHRASE}`, "")).toBe(base);
  });

  test("the clause carries no youth or revealing word", () => {
    expect(youthWords(BODY_CLAUSE, "descriptor")).toEqual([]);
    expect(revealingWordsIn(BODY_CLAUSE)).toEqual([]);
  });
});
